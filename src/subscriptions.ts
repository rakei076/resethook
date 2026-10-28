import { Hono } from "hono";
import { postSigned, UA, type SubRow } from "./deliver";
import { encryptKey, grokMessage, grokTestMessage, isGrokUrl, postGrok, decryptKey } from "./grok";
import { eventPayload } from "./payload";
import { rowToEvent } from "./db";
import { randomToken, sha256Hex } from "./sign";
import { parseEvents, validateHookUrl } from "./url";
import { API_VERSION } from "./payload";
import { readLimited } from "./limits";
import type { Env } from "./types";

const HOUR = 3600;
// 500 keeps one event within a free-plan invocation (5 queue batches) and the daily queue budget (~3 operations per delivery)
const MAX_ACTIVE = 500;
// a Grok Bot gets every Codex reset post and judges from the text whether it already landed
const GROK_EVENTS = ["codex.reset.announced", "codex.reset.landed", "codex.reset.retracted"];
const MAX_PER_URL = 3;
const MAX_ATTEMPTS_PER_URL = 6; // per hour, from anyone
const PING_PER_HOUR = 5;

const nowSec = () => Math.floor(Date.now() / 1000);

/** Ask the receiver to echo a random string; proves the URL's owner wants these requests. */
export async function challenge(env: Env, url: string, f: typeof fetch = fetch): Promise<boolean> {
  const c = randomToken("", 16);
  try {
    const res = await f(url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json", "user-agent": `resethook/1.0 (+${env.PUBLIC_BASE_URL})` },
      body: JSON.stringify({ type: "challenge", challenge: c }),
    });
    if (res.status !== 200) return false;
    const text = (await readLimited(res.body, 1024)).text.trim();
    if (text === c) return true;
    try {
      return (JSON.parse(text) as { challenge?: string }).challenge === c;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

async function verifyTurnstile(env: Env, token: string, ip: string, f: typeof fetch): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true; // not configured: local dev
  const res = await f("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
  });
  return ((await res.json()) as { success?: boolean }).success === true;
}

export const clientIp = (req: Request) => req.headers.get("cf-connecting-ip") ?? "0.0.0.0";

const publicSub = (s: SubRow) => ({ id: s.id, kind: s.kind, url: s.kind === "grok" ? s.url.replace(/[^/]{6}$/, "……") : s.url, events: s.events.split(","), status: s.status, consecutive_failures: s.failures, created_at: new Date(s.created_at * 1000).toISOString() });

export function subscriptionRoutes(f: typeof fetch = fetch) {
  const app = new Hono<{ Bindings: Env }>();

  app.post("/", async (c) => {
    const env = c.env;
    const raw = await readLimited(c.req.raw.body, 4096);
    if (raw.tooBig) return c.json({ error: "request body too large" }, 413);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw.text);
    } catch {}
    const body = parsed as { url?: string; events?: unknown; turnstile_token?: string; grok_key?: string; lang?: string } | null;
    if (!body || typeof body.url !== "string") return c.json({ error: "url is required" }, 400);
    const u = validateHookUrl(body.url.trim());
    if (typeof u === "string") return c.json({ error: u }, 400);
    // A Grok Bot routine: deliver a plain message with its Bearer key, to the Grok host only.
    const grok = typeof body.grok_key === "string";
    // people paste the key, "Bearer <key>" or the whole "Authorization: Bearer <key>" line
    const grokKey = grok ? body.grok_key!.trim().replace(/^authorization:\s*/i, "").replace(/^bearer\s+/i, "").trim() : "";
    const lang = body.lang === "zh" ? "zh" : "en";
    if (grok) {
      if (!isGrokUrl(u)) return c.json({ error: "this is not a Grok Bot webhook url (it starts with https://api2.cursor.sh/)" }, 400);
      if (!grokKey || grokKey.length > 512) return c.json({ error: "the webhook key is missing" }, 400);
      if (/^https?:/i.test(grokKey)) return c.json({ error: "the key field holds a url, not the key" }, 400);
      if (!/^[\x21-\x7e]+$/.test(grokKey)) return c.json({ error: "the webhook key has characters a key cannot have" }, 400);
      if (!env.KEY_SECRET) return c.json({ error: "grok delivery is not configured on this server" }, 503);
    }
    const events = body.events === undefined ? (grok ? GROK_EVENTS : ["*"]) : parseEvents(body.events);
    if (typeof events === "string") return c.json({ error: events }, 400);

    const ip = clientIp(c.req.raw);
    const hasToken = typeof body.turnstile_token === "string" && body.turnstile_token !== "";
    if (hasToken && !(await verifyTurnstile(env, body.turnstile_token!, ip, f))) return c.json({ error: "turnstile verification failed" }, 400);
    const ipHash = await sha256Hex(`${env.IP_SALT}|${ip}`);

    const id = randomToken("sub_", 12);
    const secret = randomToken("whsec_");
    const manageToken = randomToken("mt_");
    const now = nowSec();
    // One atomic statement checks every limit and reserves the row as 'pending', so concurrent sign-ups cannot all pass
    // the check before any of them is stored. Rejected attempts stay (for 2 hours) and count toward the per-address
    // limit: a failed challenge is still an outbound request we made on a stranger's behalf.
    const reserved = await env.DB.prepare(
      `INSERT INTO subscriptions (id, url, events, secret, token_hash, status, failures, ip_hash, created_at, kind, bearer_enc, lang)
       SELECT ?1, ?2, ?3, ?4, ?5, 'pending', 0, ?6, ?7, ?13, ?14, ?15
       WHERE (SELECT COUNT(*) FROM subscriptions WHERE ip_hash = ?6 AND created_at > ?8) < ?9
         AND (SELECT COUNT(*) FROM subscriptions WHERE url = ?2 AND created_at > ?8) < ?10
         AND (SELECT COUNT(*) FROM subscriptions WHERE url = ?2 AND status IN ('pending', 'active', 'disabled')) < ?11
         AND (SELECT COUNT(*) FROM subscriptions WHERE status IN ('pending', 'active')) < ?12`,
    )
      .bind(id, u.href, events.join(","), secret, await sha256Hex(manageToken), ipHash, now, now - HOUR, hasToken ? 10 : 3, MAX_ATTEMPTS_PER_URL, MAX_PER_URL, MAX_ACTIVE,
        grok ? "grok" : "webhook", grok ? await encryptKey(env.KEY_SECRET!, grokKey) : null, lang)
      .run();
    if (reserved.meta.changes === 0) {
      const [perIp, perUrl, live, active] = await env.DB.batch<{ n: number }>([
        env.DB.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE ip_hash = ? AND created_at > ?").bind(ipHash, now - HOUR),
        env.DB.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE url = ? AND created_at > ?").bind(u.href, now - HOUR),
        env.DB.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE url = ? AND status IN ('pending', 'active', 'disabled')").bind(u.href),
        env.DB.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE status IN ('pending', 'active')"),
      ]);
      if (perIp.results[0].n >= (hasToken ? 10 : 3)) return c.json({ error: "too many attempts from this address, try again later" }, 429, { "retry-after": "3600" });
      if (live.results[0].n >= MAX_PER_URL) return c.json({ error: "this url already has the maximum number of subscriptions" }, 409);
      if (perUrl.results[0].n >= MAX_ATTEMPTS_PER_URL) return c.json({ error: "too many attempts for this url, try again later" }, 429, { "retry-after": "3600" });
      if (active.results[0].n >= MAX_ACTIVE) return c.json({ error: "subscription capacity reached" }, 503);
      return c.json({ error: "could not create the subscription, try again" }, 409);
    }

    // Proof the owner wants this: a webhook echoes a challenge; a Grok routine accepts its own key with our test message.
    const grokRes = grok ? await postGrok(u.href, grokKey, grokTestMessage(lang), UA(env), f) : null;
    const accepted = grok ? grokRes!.ok : await challenge(env, u.href, f);
    if (!accepted) {
      await env.DB.prepare("UPDATE subscriptions SET status = 'rejected' WHERE id = ?").bind(id).run();
      if (grok) console.warn("grok sign-up refused", grokRes!.status);
      return grok
        ? c.json({ error: `Grok did not accept the test message (HTTP ${grokRes!.status ?? "no answer"})`, grok_status: grokRes!.status }, 400)
        : c.json({ error: "challenge failed: respond 200 with the challenge string (plain text or {\"challenge\": ...}) within 10 seconds" }, 400);
    }
    await env.DB.prepare("UPDATE subscriptions SET status = 'active' WHERE id = ?").bind(id).run();
    const manage_url = `${env.PUBLIC_BASE_URL}/manage#${id}.${manageToken}`;
    if (grok) return c.json({ id, manage_token: manageToken, manage_url, events, status: "active" }, 201);
    return c.json({ id, secret, manage_token: manageToken, manage_url, events, status: "active" }, 201);
  });

  // everything below needs Authorization: Bearer <manage_token>
  const auth = async (c: any): Promise<SubRow | Response> => {
    const sub = await c.env.DB.prepare("SELECT * FROM subscriptions WHERE id = ? AND status != 'deleted'").bind(c.req.param("id")).first();
    const token = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
    if (!sub || (await sha256Hex(token)) !== sub.token_hash) return c.json({ error: "not found or bad token" }, 404);
    return sub as SubRow;
  };

  app.get("/:id", async (c) => {
    const sub = await auth(c);
    if (sub instanceof Response) return sub;
    const { results } = await c.env.DB.prepare("SELECT event_id, attempt, http_status, ok, at FROM deliveries WHERE subscription_id = ? ORDER BY at DESC LIMIT 10").bind(sub.id).all();
    return c.json({
      ...publicSub(sub),
      recent_deliveries: results.map((r: any) => ({ event_id: r.event_id, attempt: r.attempt, http_status: r.http_status, ok: !!r.ok, at: new Date(r.at * 1000).toISOString() })),
    });
  });

  app.delete("/:id", async (c) => {
    const sub = await auth(c);
    if (sub instanceof Response) return sub;
    // keep a stripped row for the sign-up limits (counted per IP hash and URL per hour); it is purged with stale attempts
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE subscriptions SET status = 'deleted', secret = '', secret_prev = NULL, token_hash = '', bearer_enc = NULL WHERE id = ?").bind(sub.id),
      c.env.DB.prepare("DELETE FROM deliveries WHERE subscription_id = ?").bind(sub.id),
    ]);
    return c.body(null, 204);
  });

  app.post("/:id/test", async (c) => {
    const sub = await auth(c);
    if (sub instanceof Response) return sub;
    const recent = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE subscription_id = ? AND event_id LIKE 'evt_ping_%' AND at > ?").bind(sub.id, nowSec() - HOUR).first<{ n: number }>();
    if ((recent?.n ?? 0) >= PING_PER_HOUR) return c.json({ error: "at most 5 test pings per hour" }, 429);
    const id = randomToken("evt_ping_", 8);
    const body = { id, type: "ping", created_at: new Date().toISOString(), api_version: API_VERSION, data: { message: "Test ping from ResetHook" } };
    const lang = sub.lang === "zh" ? "zh" : "en";
    let message = grokTestMessage(lang);
    // ?sample=latest: replay the latest real reset post, marked as a test, so the owner can see how the bot judges it
    if (sub.kind === "grok" && c.req.query("sample") === "latest") {
      const row = await c.env.DB.prepare("SELECT * FROM events WHERE product = 'codex' AND stage IN ('announced', 'landed') AND retracted = 0 ORDER BY posted_at DESC LIMIT 1").first();
      const real = row ? grokMessage(eventPayload(rowToEvent(row)), lang) : null;
      if (real) message = (lang === "zh" ? "【测试：这是最近一条真实的重置帖子，重新发一次给你看】\n" : "[Test: the latest real reset post, sent again]\n") + real;
    }
    const res =
      sub.kind === "grok"
        ? await postGrok(sub.url, await decryptKey(c.env.KEY_SECRET!, sub.bearer_enc!), message, UA(c.env), f)
        : await postSigned(c.env, sub, { id, type: "ping" }, body, 1, f);
    await c.env.DB.prepare("INSERT INTO deliveries (subscription_id, event_id, attempt, http_status, ok, at) VALUES (?, ?, 1, ?, ?, ?)").bind(sub.id, id, res.status, res.ok ? 1 : 0, nowSec()).run();
    return c.json({ delivered: res.ok, http_status: res.status });
  });

  app.post("/:id/rotate-secret", async (c) => {
    const sub = await auth(c);
    if (sub instanceof Response) return sub;
    const secret = randomToken("whsec_");
    await c.env.DB.prepare("UPDATE subscriptions SET secret = ?, secret_prev = ?, secret_prev_until = ? WHERE id = ?").bind(secret, sub.secret, nowSec() + 24 * HOUR, sub.id).run();
    return c.json({ secret, previous_secret_valid_until: new Date((nowSec() + 24 * HOUR) * 1000).toISOString() });
  });

  app.post("/:id/reverify", async (c) => {
    const sub = await auth(c);
    if (sub instanceof Response) return sub;
    if (!(await challenge(c.env, sub.url, f))) return c.json({ error: "challenge failed" }, 400);
    await c.env.DB.prepare("UPDATE subscriptions SET status = 'active', failures = 0 WHERE id = ?").bind(sub.id).run();
    return c.json({ status: "active" });
  });

  return app;
}
