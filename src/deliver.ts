import { eventPayload } from "./payload";
import { signHeader } from "./sign";
import { getEvent } from "./db";
import { readLimited } from "./limits";
import { decryptKey, grokMessage, postGrok, type Lang } from "./grok";
import type { DeliveryMessage, Env } from "./types";

// minutes to wait after failed attempt 1, 2, 3, ...
export const BACKOFF_MINUTES = [1, 2, 4, 8, 16, 32, 60, 60, 60];

export interface SubRow {
  id: string;
  url: string;
  events: string;
  secret: string;
  secret_prev: string | null;
  secret_prev_until: number | null;
  token_hash: string;
  status: "active" | "disabled" | "deleted";
  failures: number;
  created_at: number;
  kind: "webhook" | "grok";
  bearer_enc: string | null;
  lang: string;
}

export interface PostResult {
  ok: boolean;
  status: number | null;
}

export const UA = (env: Env) => `resethook/1.0 (+${env.PUBLIC_BASE_URL})`;

/** Sign and POST one webhook. During secret rotation the old secret signs too, so receivers can verify with either. */
export async function postSigned(
  env: Env,
  sub: Pick<SubRow, "url" | "secret" | "secret_prev" | "secret_prev_until">,
  event: { id: string; type: string },
  body: unknown,
  attempt: number,
  f: typeof fetch = fetch,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<PostResult> {
  const raw = JSON.stringify(body);
  let signature = await signHeader(sub.secret, raw, nowSec);
  if (sub.secret_prev && sub.secret_prev_until && sub.secret_prev_until > nowSec) {
    signature += "," + (await signHeader(sub.secret_prev, raw, nowSec)).split(",")[1];
  }
  try {
    const res = await f(sub.url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "content-type": "application/json",
        "user-agent": UA(env),
        "x-resethook-event-id": event.id,
        "x-resethook-event-type": event.type,
        "x-resethook-attempt": String(attempt),
        "x-resethook-signature": signature,
      },
      body: raw,
    });
    const ok = res.status >= 200 && res.status < 300;
    if (!ok) console.warn("delivery failed", new URL(sub.url).host, res.status, (await readLimited(res.body, 200)).text, res.headers.get("server"), res.headers.get("cf-ray"));
    else await res.body?.cancel();
    return { ok, status: res.status };
  } catch {
    return { ok: false, status: null };
  }
}

/** Queue consumer: deliver, log, back off, disable after too many consecutive failures. */
export async function handleBatch(batch: MessageBatch<DeliveryMessage>, env: Env, f: typeof fetch = fetch): Promise<void> {
  const maxFailures = Number(env.MAX_FAILURES) || 8;
  for (const msg of batch.messages) {
    const { subscriptionId, eventId } = msg.body;
    const sub = await env.DB.prepare("SELECT * FROM subscriptions WHERE id = ?").bind(subscriptionId).first<SubRow>();
    if (!sub || sub.status !== "active") {
      msg.ack();
      continue;
    }
    const ev = await getEvent(env.DB, eventId);
    if (!ev) {
      // enqueued a moment before the event row was committed: try again shortly
      msg.retry({ delaySeconds: 30 });
      continue;
    }
    const payload = eventPayload(ev);
    let res: PostResult;
    if (sub.kind === "grok") {
      const message = grokMessage(payload, sub.lang as Lang);
      if (!message) {
        msg.ack();
        continue;
      }
      res = await postGrok(sub.url, await decryptKey(env.KEY_SECRET!, sub.bearer_enc!), message, UA(env), f);
    } else res = await postSigned(env, sub, { id: ev.id, type: payload.type }, payload, msg.attempts, f);
    // count in SQL: concurrent consumers for one subscription must not overwrite each other's failures
    const [, after] = await env.DB.batch<{ status: string }>([
      env.DB.prepare("INSERT INTO deliveries (subscription_id, event_id, attempt, http_status, ok, at) VALUES (?, ?, ?, ?, ?, ?)").bind(sub.id, ev.id, msg.attempts, res.status, res.ok ? 1 : 0, Math.floor(Date.now() / 1000)),
      res.ok
        ? env.DB.prepare("UPDATE subscriptions SET failures = 0 WHERE id = ? RETURNING status").bind(sub.id)
        : env.DB.prepare("UPDATE subscriptions SET failures = failures + 1, status = CASE WHEN failures + 1 >= ? THEN 'disabled' ELSE status END WHERE id = ? RETURNING status").bind(maxFailures, sub.id),
    ]);
    const status = after.results[0]?.status ?? "disabled";
    if (res.ok || status === "disabled") msg.ack();
    else msg.retry({ delaySeconds: BACKOFF_MINUTES[Math.min(msg.attempts - 1, BACKOFF_MINUTES.length - 1)] * 60 });
  }
}
