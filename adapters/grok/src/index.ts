// Relay: ResetHook webhook -> Grok Bot routine webhook.
// Grok's webhook wants `Authorization: Bearer <key>` and a short message; ResetHook sends an HMAC signature.
// This Worker verifies the signature, turns the event into a plain message and forwards it.

import { grokMessage, grokTestMessage } from "../../../src/grok";
import { readLimited } from "../../../src/limits";

export interface Env {
  MESSAGE_LANG?: string; // "zh" or "en" (default)
  MESSAGE_SUFFIX?: string; // appended to every forwarded message, e.g. "Hand this to your Codex bot, playbook at ..."
  RESETHOOK_SECRET?: string;
  GROK_WEBHOOK_URL: string;
  GROK_WEBHOOK_KEY: string;
}

const TOLERANCE_S = 300;
const enc = new TextEncoder();

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

/** `t=<unix>,v1=<hex>[,v1=<hex>]`: valid when any v1 matches and t is recent (several v1 appear while a secret rotates). */
export async function verify(raw: string, header: string | null, secret: string, nowSec = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!header) return false;
  const parts = header.split(",").map((p) => p.split("="));
  const t = Number(parts.find((p) => p[0] === "t")?.[1]);
  if (!t || Math.abs(nowSec - t) > TOLERANCE_S) return false;
  const mac = await hmac(secret, `${t}.${raw}`);
  return parts.filter((p) => p[0] === "v1").some(([, v]) => v?.length === mac.length && crypto.subtle.timingSafeEqual(enc.encode(v), enc.encode(mac)));
}

/** The message is built by ResetHook's own Grok delivery, so the relay and the hosted service say the same thing. */
export { grokMessage as formatMessage } from "../../../src/grok";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    const body = await readLimited(req.body, 64 * 1024);
    if (body.tooBig) return new Response("body too large", { status: 413 });
    const raw = body.text;
    let ev: any;
    try {
      ev = JSON.parse(raw);
    } catch {
      return new Response("bad json", { status: 400 });
    }
    // sign-up handshake: unsigned by design, echoes a random string and nothing else
    if (ev.type === "challenge" && typeof ev.challenge === "string") return new Response(ev.challenge);

    if (!env.RESETHOOK_SECRET || !(await verify(raw, req.headers.get("x-resethook-signature"), env.RESETHOOK_SECRET))) {
      return new Response("bad signature", { status: 401 });
    }
    // ResetHook's own "send a test" ping proves the signature works without waking the bot.
    // Only someone holding the secret can add data.wake to make it forward a clearly marked test message.
    let message: string | null;
    const lang = env.MESSAGE_LANG === "zh" ? "zh" : "en";
    if (ev.type === "ping") message = ev.data?.wake === true ? grokTestMessage(lang) : null;
    else {
      message = grokMessage(ev, lang);
      if (message && env.MESSAGE_SUFFIX) message += " " + env.MESSAGE_SUFFIX;
    }
    if (!message) return new Response("ok, nothing to forward");

    const res = await fetch(env.GROK_WEBHOOK_URL, {
      method: "POST",
      redirect: "manual", // never carry the Bearer key to wherever a redirect points
      headers: { authorization: `Bearer ${env.GROK_WEBHOOK_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: "resethook", message }),
    });
    await res.body?.cancel();
    // non-2xx makes ResetHook retry with backoff
    return new Response(res.ok ? "forwarded" : "grok webhook failed", { status: res.ok ? 200 : 502 });
  },
};
