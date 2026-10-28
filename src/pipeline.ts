import { detectRetractions, mergeObservations } from "./merge";
import { eventsPostedSince, insertEvent, kvAll, kvSet, updateEvent } from "./db";
import { matches } from "./url";
import { parseCodexForecast, parseCodexTimeline } from "./upstream";
import { parseWhenreset } from "./whenreset";
import type { DeliveryMessage, Env, EventRow, Observation, SourceName } from "./types";

const MIN = 60_000;
const MAX_EVENT_WRITES = 25; // D1 free tier: 50 queries per invocation (3 reads + ~11 state writes + 2 cleanups + this)

type Fetch = typeof fetch;

async function getJson(env: Env, url: string, f: Fetch): Promise<{ json?: any; retryAfter?: number }> {
  const res = await f(url, { headers: { "user-agent": env.UPSTREAM_UA, accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  if (res.status === 429) return { retryAfter: Number(res.headers.get("retry-after")) || 300 };
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return { json: await res.json() };
}

/** One cron tick: pull both upstreams within their rate limits, merge, persist, enqueue deliveries. */
export async function poll(env: Env, now: Date, f: Fetch = fetch): Promise<void> {
  const kv = await kvAll(env.DB);
  const writes: D1PreparedStatement[] = [];
  const set = (k: string, v: string) => {
    kv.set(k, v);
    writes.push(kvSet(env.DB, k, v));
  };
  const observations: Observation[] = [];
  const listings: Partial<Record<SourceName, Observation[]>> = {};
  const nowMs = now.getTime();
  const since = (k: string) => (kv.has(k) ? nowMs - Date.parse(kv.get(k)!) : Infinity);

  const run = async (name: SourceName, minGapMs: number, job: () => Promise<void>) => {
    const blocked = kv.get(`src:${name}:blocked_until`);
    if (since(`src:${name}:last_fetch`) < minGapMs || (blocked && Date.parse(blocked) > nowMs)) return;
    set(`src:${name}:last_fetch`, now.toISOString());
    try {
      await job();
      set(`src:${name}:last_ok`, now.toISOString());
      set(`src:${name}:fails`, "0");
    } catch (e) {
      set(`src:${name}:fails`, String(Number(kv.get(`src:${name}:fails`) ?? 0) + 1));
      console.error(name, String(e));
    }
  };

  // a 50 s gap so a once-a-minute cron that fires a little early still fetches every tick
  await run("codex-reset.com", 50_000, async () => {
    const fc = await getJson(env, "https://codex-reset.com/api/forecast", f);
    if (fc.retryAfter) {
      set("src:codex-reset.com:blocked_until", new Date(nowMs + fc.retryAfter * 1000).toISOString());
      throw new Error("rate limited");
    }
    const forecast = parseCodexForecast(fc.json);
    set("forecast:codex", JSON.stringify({ p24: forecast.p24, p48: forecast.p48, last_reset_at: forecast.lastResetAt }));
    // the timeline is 180 KB: only fetch it when the forecast signals a change, or every 15 minutes
    if (kv.get("codex:fingerprint") !== forecast.fingerprint || since("codex:timeline_at") > 15 * MIN) {
      const tl = await getJson(env, "https://codex-reset.com/api/timeline", f);
      if (tl.retryAfter) {
        set("src:codex-reset.com:blocked_until", new Date(nowMs + tl.retryAfter * 1000).toISOString());
        throw new Error("rate limited");
      }
      const obs = parseCodexTimeline(tl.json);
      observations.push(...obs);
      listings["codex-reset.com"] = obs;
      set("codex:fingerprint", forecast.fingerprint);
      set("codex:timeline_at", now.toISOString());
    }
  });

  await run("whenreset.dev", 5 * MIN, async () => {
    const r = await getJson(env, "https://whenreset.dev/api/resets", f);
    if (r.retryAfter) {
      set("src:whenreset.dev:blocked_until", new Date(nowMs + r.retryAfter * 1000).toISOString());
      throw new Error("rate limited");
    }
    const parsed = parseWhenreset(r.json);
    observations.push(...parsed.observations);
    listings["whenreset.dev"] = parsed.observations;
    for (const [product, at] of Object.entries(parsed.nextEstimate)) if (at) set(`next:${product}`, at);
  });

  // every stored event at least as new as the oldest observation: small table, and D1 caps bound variables at 100
  const oldest = Math.min(nowMs - 2 * 24 * 60 * MIN, ...observations.map((o) => Date.parse(o.postedAt)));
  const stored = await eventsPostedSince(env.DB, new Date(oldest - 24 * 60 * MIN).toISOString());
  const existing = new Map(stored.map((e) => [e.id, e]));
  const recent = stored.filter((e) => Date.parse(e.created_at) >= nowMs - 24 * 60 * MIN);

  const merged = mergeObservations(existing, observations, now);
  const state = new Map(existing);
  for (const e of [...merged.updates, ...merged.inserts]) state.set(e.id, e);
  const { updates: goneUpdates, retractions } = detectRetractions([...state.values()], listings, now);

  // updates (confirmations) are few and recent: they go first; history inserts use the rest of the write budget, newest first
  const updateMap = new Map<string, EventRow>();
  for (const u of [...merged.updates, ...goneUpdates]) updateMap.set(u.id, u);
  const mergedIds = new Set(merged.inserts.map((e) => e.id));
  const updates = [...updateMap.values()].filter((u) => !mergedIds.has(u.id)).slice(0, MAX_EVENT_WRITES);
  const inserts = [...merged.inserts, ...retractions].sort((a, b) => Date.parse(b.posted_at) - Date.parse(a.posted_at)).slice(0, MAX_EVENT_WRITES - updates.length);
  const insertedIds = new Set(inserts.map((e) => e.id));

  // Enqueue before persisting: if the queue is down nothing is stored and the next tick retries.
  // If the write fails after enqueueing, the next tick enqueues again; receivers dedupe on the event id.
  const toDeliver = [...merged.deliver, ...retractions].filter((e) => insertedIds.has(e.id));
  if (toDeliver.length) await enqueue(env, toDeliver);

  // delivery logs are kept for 7 days (see /privacy); stale sign-up attempts for 2 hours
  writes.push(env.DB.prepare("DELETE FROM deliveries WHERE at < ?").bind(Math.floor(nowMs / 1000) - 7 * 86400));
  writes.push(env.DB.prepare("DELETE FROM subscriptions WHERE status IN ('pending', 'rejected', 'deleted') AND created_at < ?").bind(Math.floor(nowMs / 1000) - 2 * 3600));
  await env.DB.batch([...inserts.map((e) => insertEvent(env.DB, e)), ...updates.map((e) => updateEvent(env.DB, e)), ...writes]);
}

async function enqueue(env: Env, events: EventRow[]): Promise<void> {
  const { results } = await env.DB.prepare("SELECT id, events FROM subscriptions WHERE status = 'active'").all<{ id: string; events: string }>();
  const messages: { body: DeliveryMessage }[] = [];
  for (const e of events) {
    const type = `${e.product}.reset.${e.stage}`;
    for (const s of results) if (matches(s.events.split(","), type)) messages.push({ body: { subscriptionId: s.id, eventId: e.id } });
  }
  for (let i = 0; i < messages.length; i += 100) await env.DELIVERIES.sendBatch(messages.slice(i, i + 100));
}
