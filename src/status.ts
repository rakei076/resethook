import { API_VERSION, eventPayload } from "./payload";
import { kvAll, NOT_RETRACTED, rowToEvent } from "./db";
import type { Env, EventRow, Product } from "./types";

const ptDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(d);

// "reset" here means a landed reset or a banked reset card: both are usage you got back
async function latestEvent(db: D1Database, product: Product, stages: string[]): Promise<EventRow | null> {
  const r = await db.prepare(`SELECT * FROM events WHERE product = ? AND stage IN (${stages.map(() => "?").join(",")}) AND ${NOT_RETRACTED} ORDER BY posted_at DESC LIMIT 1`).bind(product, ...stages).first();
  return r ? rowToEvent(r) : null;
}

// hours between consecutive resets (landed or banked), oldest first; the page ranks the current wait against these
async function gapHours(db: D1Database, product: Product): Promise<number[]> {
  const { results } = await db.prepare(`SELECT posted_at FROM events WHERE product = ? AND stage IN ('landed', 'banked') AND ${NOT_RETRACTED} ORDER BY posted_at DESC LIMIT 14`).bind(product).all<{ posted_at: string }>();
  const t = results.map((r) => Date.parse(r.posted_at)).reverse();
  const gaps: number[] = [];
  for (let i = 1; i < t.length; i++) {
    const h = (t[i] - t[i - 1]) / 3600e3;
    if (h >= 3) gaps.push(Math.round(h * 10) / 10); // a landing and its banked card posted hours apart are one reset
  }
  return gaps;
}

async function productStatus(db: D1Database, product: Product, now: Date) {
  const [landed, announced] = await Promise.all([latestEvent(db, product, ["landed", "banked"]), latestEvent(db, product, ["announced"])]);
  const open =
    announced && (!landed || Date.parse(announced.posted_at) > Date.parse(landed.posted_at)) && now.getTime() - Date.parse(announced.posted_at) < 36 * 3600 * 1000
      ? { id: announced.id, post_url: announced.post_url, eta: announced.eta, posted_at: announced.posted_at }
      : null;
  return {
    gap_hours: await gapHours(db, product),
    reset_today_pt: landed ? ptDate(new Date(landed.posted_at)) === ptDate(now) : false,
    last_reset: landed ? { id: landed.reset_id, stage: landed.stage, landed_at: landed.posted_at, post_url: landed.post_url } : null,
    open_announcement: open,
  };
}

export async function buildStatus(env: Env, now = new Date()) {
  const kv = await kvAll(env.DB);
  const [codex, claude] = await Promise.all([productStatus(env.DB, "codex", now), productStatus(env.DB, "claude", now)]);
  const forecast = kv.get("forecast:codex") ? JSON.parse(kv.get("forecast:codex")!) : null;
  const next = kv.get("next:codex");
  const sources = (["codex-reset.com", "whenreset.dev"] as const).map((name) => ({
    name,
    // healthy unless the last success is more than 15 minutes old (a single 429 or blip is not an outage)
    ok: kv.has(`src:${name}:last_ok`) && now.getTime() - Date.parse(kv.get(`src:${name}:last_ok`)!) < 15 * 60_000,
    last_ok_at: kv.get(`src:${name}:last_ok`) ?? null,
  }));
  return {
    generated_at: now.toISOString(),
    api_version: API_VERSION,
    codex: { ...codex, forecast: forecast && { p24: forecast.p24, p48: forecast.p48, source: "https://codex-reset.com/" }, next_estimate: next ? { at: next, source: "https://whenreset.dev/" } : null },
    claude,
    sources,
    attribution: "Data: codex-reset.com, whenreset.dev",
  };
}

export async function listEvents(env: Env, q: { product?: string; since?: string; limit?: number }) {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 100);
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.product === "codex" || q.product === "claude") {
    where.push("product = ?");
    args.push(q.product);
  }
  if (q.since) {
    // a previous event id, or an ISO timestamp
    const ref = q.since.startsWith("evt_") ? await env.DB.prepare("SELECT posted_at FROM events WHERE id = ?").bind(q.since).first<string>("posted_at") : new Date(q.since).toISOString();
    if (ref) {
      where.push("posted_at > ?");
      args.push(ref);
    }
  }
  const sql = `SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY posted_at DESC LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(...args, limit).all();
  return results.map((r) => eventPayload(rowToEvent(r)));
}

