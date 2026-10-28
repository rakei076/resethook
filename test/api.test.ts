import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { handleBatch } from "../src/deliver";
import { poll } from "../src/pipeline";
import { buildStatus } from "../src/status";
import { subscriptionRoutes } from "../src/subscriptions";
import type { DeliveryMessage, Env } from "../src/types";
import { fakeEnv, fixture, verifyHeader } from "./helpers";

const queued: any[] = [];
let e: Env;

beforeEach(async () => {
  queued.length = 0;
  e = fakeEnv(env as unknown as Env, queued);
  for (const t of ["events", "subscriptions", "deliveries", "kv"]) await e.DB.prepare(`DELETE FROM ${t}`).run();
});

/** A receiver that echoes challenges and records everything else. */
function receiver(status = 200) {
  const calls: { url: string; headers: Headers; body: string }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const body = String(init.body);
    calls.push({ url, headers: new Headers(init.headers), body });
    const j = JSON.parse(body);
    return j.type === "challenge" ? new Response(j.challenge) : new Response("", { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const jsonReq = (path: string, method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://x.test${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json", "cf-connecting-ip": "1.2.3.4", ...headers } });

function subsApp(f: typeof fetch) {
  return new Hono<{ Bindings: Env }>().route("/api/v1/subscriptions", subscriptionRoutes(f));
}

describe("subscriptions", () => {
  it("creates after the challenge, pings with a verifiable signature, rotates, deletes", async () => {
    const r = receiver();
    const app = subsApp(r.f);
    const res = await app.fetch(jsonReq("/api/v1/subscriptions", "POST", { url: "https://hooks.example.com/reset", events: ["codex.*"] }), e);
    expect(res.status).toBe(201);
    const sub = (await res.json()) as any;
    expect(sub.secret).toMatch(/^whsec_/);
    expect(r.calls[0].headers.get("user-agent")).toContain("resethook/1.0");

    const auth = { authorization: `Bearer ${sub.manage_token}` };
    const ping = await app.fetch(jsonReq(`/api/v1/subscriptions/${sub.id}/test`, "POST", undefined, auth), e);
    expect(await ping.json()).toMatchObject({ delivered: true, http_status: 200 });
    const call = r.calls.at(-1)!;
    const t = Number(/t=(\d+)/.exec(call.headers.get("x-resethook-signature")!)![1]);
    expect(await verifyHeader(call.body, call.headers.get("x-resethook-signature")!, sub.secret, t)).toBe(true);
    expect(call.headers.get("x-resethook-event-type")).toBe("ping");

    const rot = (await (await app.fetch(jsonReq(`/api/v1/subscriptions/${sub.id}/rotate-secret`, "POST", undefined, auth), e)).json()) as any;
    await app.fetch(jsonReq(`/api/v1/subscriptions/${sub.id}/test`, "POST", undefined, auth), e);
    const c2 = r.calls.at(-1)!;
    const sig = c2.headers.get("x-resethook-signature")!;
    expect(sig.match(/v1=/g)).toHaveLength(2);
    expect(await verifyHeader(c2.body, sig, rot.secret, t)).toBe(true);
    expect(await verifyHeader(c2.body, sig, sub.secret, t)).toBe(true);

    expect((await app.fetch(jsonReq(`/api/v1/subscriptions/${sub.id}`, "GET", undefined, { authorization: "Bearer wrong" }), e)).status).toBe(404);
    const got = (await (await app.fetch(jsonReq(`/api/v1/subscriptions/${sub.id}`, "GET", undefined, auth), e)).json()) as any;
    expect(got.recent_deliveries).toHaveLength(2);
    expect((await app.fetch(jsonReq(`/api/v1/subscriptions/${sub.id}`, "DELETE", undefined, auth), e)).status).toBe(204);
    // a deleted subscription keeps only what the sign-up limits need, and is gone for the API
    const left = await e.DB.prepare("SELECT status, secret, token_hash, bearer_enc FROM subscriptions WHERE id = ?").bind(sub.id).first<any>();
    expect(left).toEqual({ status: "deleted", secret: "", token_hash: "", bearer_enc: null });
    expect((await app.fetch(jsonReq(`/api/v1/subscriptions/${sub.id}`, "GET", undefined, auth), e)).status).toBe(404);
  });

  it("does not let create-and-delete loops reset the sign-up limit, and refuses oversized bodies", async () => {
    const r = receiver();
    const app = subsApp(r.f);
    const ip = { "cf-connecting-ip": "9.9.9.9" };
    for (let i = 0; i < 3; i++) {
      const sub = (await (await app.fetch(jsonReq("/api/v1/subscriptions", "POST", { url: `https://loop${i}.example.com/h` }, ip), e)).json()) as any;
      await app.fetch(jsonReq(`/api/v1/subscriptions/${sub.id}`, "DELETE", undefined, { ...ip, authorization: `Bearer ${sub.manage_token}` }), e);
    }
    expect((await app.fetch(jsonReq("/api/v1/subscriptions", "POST", { url: "https://loop9.example.com/h" }, ip), e)).status).toBe(429);
    const big = await app.fetch(jsonReq("/api/v1/subscriptions", "POST", { url: "https://big.example.com/h", pad: "x".repeat(10_000) }), e);
    expect(big.status).toBe(413);
  });

  it("refuses receivers that do not echo the challenge, unsafe urls, and floods", async () => {
    const app = subsApp((async () => new Response("nope")) as unknown as typeof fetch);
    const other = { "cf-connecting-ip": "8.8.8.8" };
    expect((await app.fetch(jsonReq("/api/v1/subscriptions", "POST", { url: "https://hooks.example.com/a" }, other), e)).status).toBe(400);
    expect((await app.fetch(jsonReq("/api/v1/subscriptions", "POST", { url: "http://hooks.example.com/a" }, other), e)).status).toBe(400);
    expect((await app.fetch(jsonReq("/api/v1/subscriptions", "POST", { url: "https://hooks.example.com/a", events: ["nope"] }), e)).status).toBe(400);

    const ok = subsApp(receiver().f);
    for (const n of [1, 2, 3]) expect((await ok.fetch(jsonReq("/api/v1/subscriptions", "POST", { url: `https://h${n}.example.com/x` }), e)).status).toBe(201);
    const flood = await ok.fetch(jsonReq("/api/v1/subscriptions", "POST", { url: "https://h4.example.com/x" }), e);
    expect(flood.status).toBe(429); // 3 per hour without a Turnstile token
  });

  it("counts failed challenges against the address, so strangers cannot be probed through us", async () => {
    const app = subsApp((async () => new Response("nope")) as unknown as typeof fetch);
    for (const n of [1, 2, 3]) expect((await app.fetch(jsonReq("/api/v1/subscriptions", "POST", { url: `https://victim${n}.example.com/x` }), e)).status).toBe(400);
    expect((await app.fetch(jsonReq("/api/v1/subscriptions", "POST", { url: "https://victim4.example.com/x" }), e)).status).toBe(429);
  });

  it("holds the limits under concurrent sign-ups", async () => {
    const app = subsApp(receiver().f);
    const results = await Promise.all(Array.from({ length: 10 }, () => app.fetch(jsonReq("/api/v1/subscriptions", "POST", { url: "https://burst.example.com/x" }), e)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
  });

  it("reads only the first kilobyte of a challenge reply", async () => {
    let pulled = 0;
    const huge = (async () =>
      new Response(new ReadableStream({ pull: (c) => { pulled += 1; c.enqueue(new Uint8Array(65536).fill(65)); if (pulled > 200) c.close(); } }), { status: 200 })) as unknown as typeof fetch;
    const res = await subsApp(huge).fetch(jsonReq("/api/v1/subscriptions", "POST", { url: "https://big.example.com/x" }), e);
    expect(res.status).toBe(400);
    expect(pulled).toBeLessThan(10);
  });

  it("caps subscriptions per url", async () => {
    const ok = subsApp(receiver().f);
    for (const ip of ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) expect((await ok.fetch(jsonReq("/api/v1/subscriptions", "POST", { url: "https://same.example.com/x" }, { "cf-connecting-ip": ip }), e)).status).toBe(201);
    expect((await ok.fetch(jsonReq("/api/v1/subscriptions", "POST", { url: "https://same.example.com/x" }, { "cf-connecting-ip": "4.4.4.4" }), e)).status).toBe(409);
  });
});

function upstream() {
  const hits: string[] = [];
  const f = (async (url: string) => {
    hits.push(url);
    if (url.includes("/api/forecast")) return Response.json(fixture("codex-forecast.json"));
    if (url.includes("/api/timeline")) return Response.json(fixture("codex-timeline.json"));
    if (url.includes("whenreset.dev")) return Response.json(fixture("whenreset.json"));
    throw new Error("unexpected " + url);
  }) as unknown as typeof fetch;
  return { f, hits };
}

describe("poll", () => {
  const T0 = new Date("2026-10-26T07:00:00Z");

  it("stores history silently, pushes fresh events to matching subscribers, respects upstream rate limits", async () => {
    await subsApp(receiver().f).fetch(jsonReq("/api/v1/subscriptions", "POST", { url: "https://hooks.example.com/a", events: ["codex.*"] }), e);
    await subsApp(receiver().f).fetch(jsonReq("/api/v1/subscriptions", "POST", { url: "https://hooks.example.com/b", events: ["claude.*"] }, { "cf-connecting-ip": "9.9.9.9" }), e);

    const up = upstream();
    await poll(e, T0, up.f);
    const events = (await e.DB.prepare("SELECT id, stage FROM events").all()).results;
    expect(events.length).toBeGreaterThan(10);
    // only the 10/26 landing is within 24h of T0, and only the codex subscriber gets it
    expect(queued).toHaveLength(1);
    expect(queued[0].eventId).toBe("evt_codex_2114588174249071102_landed");

    // 2 minutes later: codex-reset may be asked again (>=60s) but not whenreset (5 min), and nothing new is pushed
    const up2 = upstream();
    await poll(e, new Date(T0.getTime() + 120_000), up2.f);
    expect(up2.hits.filter((u) => u.includes("whenreset"))).toHaveLength(0);
    expect(up2.hits.filter((u) => u.includes("/api/timeline"))).toHaveLength(0); // forecast unchanged
    expect(queued).toHaveLength(1);

    // 6 minutes after the first poll whenreset is due again
    const up3 = upstream();
    await poll(e, new Date(T0.getTime() + 360_000), up3.f);
    expect(up3.hits.filter((u) => u.includes("whenreset"))).toHaveLength(1);
    expect(queued).toHaveLength(1);

    const status = (await buildStatus(e, new Date("2026-10-26T06:30:00Z"))) as any; // 23:30 PT on the 25th: the reset belongs to that Pacific day
    expect(status.codex.reset_today_pt).toBe(true);
    expect(status.codex.forecast).toMatchObject({ p24: 46, p48: 71 });
    expect(status.sources.every((s: any) => s.ok)).toBe(true);
    expect(status.codex.last_reset.post_url).toContain("2114588174249071102");
  });

  it("drops delivery logs older than 7 days", async () => {
    const nowSec = Math.floor(T0.getTime() / 1000);
    await e.DB.batch([
      e.DB.prepare("INSERT INTO deliveries (subscription_id, event_id, attempt, http_status, ok, at) VALUES ('s', 'old', 1, 200, 1, ?)").bind(nowSec - 8 * 86400),
      e.DB.prepare("INSERT INTO deliveries (subscription_id, event_id, attempt, http_status, ok, at) VALUES ('s', 'new', 1, 200, 1, ?)").bind(nowSec - 86400),
    ]);
    await poll(e, T0, upstream().f);
    expect((await e.DB.prepare("SELECT event_id FROM deliveries").all()).results).toEqual([{ event_id: "new" }]);
  });

  it("marks an upstream failing and keeps the other source working", async () => {
    const f = (async (url: string) => {
      if (url.includes("codex-reset.com")) return new Response("boom", { status: 500 });
      return Response.json(fixture("whenreset.json"));
    }) as unknown as typeof fetch;
    await poll(e, T0, f);
    // codex-reset never succeeded; once whenreset's last success is also 15+ minutes old it is reported down too
    const status = (await buildStatus(e, new Date(T0.getTime() + 60_000))) as any;
    expect(status.sources.find((s: any) => s.name === "codex-reset.com").ok).toBe(false);
    expect(((await buildStatus(e, new Date(T0.getTime() + 20 * 60_000))) as any).sources.find((s: any) => s.name === "whenreset.dev").ok).toBe(false);
    expect(status.sources.find((s: any) => s.name === "whenreset.dev").ok).toBe(true);
    expect(queued.map((m) => m.eventId)).toEqual([]); // codex subscribers none here, but events exist from whenreset alone
    expect((await e.DB.prepare("SELECT COUNT(*) AS n FROM events").first<number>("n"))! > 0).toBe(true);
  });

  it("backs off an upstream that answers 429", async () => {
    const f = (async () => new Response("slow down", { status: 429, headers: { "retry-after": "600" } })) as unknown as typeof fetch;
    await poll(e, T0, f);
    const up = upstream();
    await poll(e, new Date(T0.getTime() + 300_000), up.f);
    expect(up.hits.filter((u) => u.includes("codex-reset.com"))).toHaveLength(0);
  });
});

describe("delivery queue", () => {
  async function seed() {
    const r = receiver();
    const res = await subsApp(r.f).fetch(jsonReq("/api/v1/subscriptions", "POST", { url: "https://hooks.example.com/a", events: ["*"] }), e);
    const sub = (await res.json()) as any;
    await poll(e, new Date("2026-10-26T07:00:00Z"), upstream().f);
    return sub;
  }
  const batch = (m: DeliveryMessage, attempts: number) => {
    const out = { acked: false, retried: undefined as undefined | { delaySeconds?: number } };
    const msg = { body: m, attempts, ack: () => void (out.acked = true), retry: (o?: { delaySeconds?: number }) => void (out.retried = o ?? {}) };
    return { out, batch: { messages: [msg] } as unknown as MessageBatch<DeliveryMessage> };
  };

  it("delivers the documented payload and acks", async () => {
    const sub = await seed();
    const r = receiver();
    const { out, batch: b } = batch({ subscriptionId: sub.id, eventId: "evt_codex_2114588174249071102_landed" }, 1);
    await handleBatch(b, e, r.f);
    expect(out.acked).toBe(true);
    const body = JSON.parse(r.calls[0].body);
    expect(body).toMatchObject({ id: "evt_codex_2114588174249071102_landed", type: "codex.reset.landed", api_version: "2026-10-28", data: { product: "codex", stage: "landed", scope: "global" } });
    expect(body.data.post.url).toBe("https://x.com/thsottiaux/status/2114588174249071102");
    expect(r.calls[0].headers.get("x-resethook-attempt")).toBe("1");
  });

  it("backs off on failure, then disables after too many consecutive failures", async () => {
    const sub = await seed();
    const bad = receiver(500);
    const first = batch({ subscriptionId: sub.id, eventId: "evt_codex_2114588174249071102_landed" }, 1);
    await handleBatch(first.batch, e, bad.f);
    expect(first.out).toEqual({ acked: false, retried: { delaySeconds: 60 } });
    const third = batch({ subscriptionId: sub.id, eventId: "evt_codex_2114588174249071102_landed" }, 3);
    await handleBatch(third.batch, e, bad.f);
    expect(third.out.retried).toEqual({ delaySeconds: 240 });
    await e.DB.prepare("UPDATE subscriptions SET failures = 7").run();
    const last = batch({ subscriptionId: sub.id, eventId: "evt_codex_2114588174249071102_landed" }, 8);
    await handleBatch(last.batch, e, bad.f);
    expect(last.out.acked).toBe(true);
    expect(await e.DB.prepare("SELECT status FROM subscriptions").first("status")).toBe("disabled");
  });

  it("does not follow redirects or treat them as success", async () => {
    const sub = await seed();
    const redirect = (async () => new Response("", { status: 302, headers: { location: "http://169.254.169.254/" } })) as unknown as typeof fetch;
    const { out, batch: b } = batch({ subscriptionId: sub.id, eventId: "evt_codex_2114588174249071102_landed" }, 1);
    await handleBatch(b, e, redirect);
    expect(out.retried).toBeDefined();
  });
});

describe("grok bot delivery", () => {
  const GROK = "https://api2.cursor.sh/hooks/routine/abc123";
  function grokServer(status = 200) {
    const calls: { url: string; headers: Headers; body: any }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
      return new Response("ok", { status });
    }) as unknown as typeof fetch;
    return { f, calls };
  }
  const signUp = (f: typeof fetch, body: Record<string, unknown>) => subsApp(f).fetch(jsonReq("/api/v1/subscriptions", "POST", body), e);

  it("connects with the routine's url and key: a test message proves the key, the key is stored encrypted", async () => {
    const g = grokServer();
    const res = await signUp(g.f, { url: GROK, grok_key: "Authorization: Bearer gk_live_123", lang: "zh" });
    expect(res.status).toBe(201);
    const sub = (await res.json()) as any;
    expect(sub.secret).toBeUndefined();
    expect(sub.manage_url).toContain(`/manage#${sub.id}.`);
    expect(sub.events).toEqual(["codex.reset.announced", "codex.reset.landed", "codex.reset.retracted"]);
    expect(g.calls[0].headers.get("authorization")).toBe("Bearer gk_live_123");
    expect(g.calls[0].body.message).toContain("ResetHook 测试");
    const row = await e.DB.prepare("SELECT kind, bearer_enc, lang FROM subscriptions WHERE id = ?").bind(sub.id).first<any>();
    expect(row.kind).toBe("grok");
    expect(row.lang).toBe("zh");
    expect(row.bearer_enc).not.toContain("gk_live_123");
  });

  it("replays the latest real reset post as a marked test", async () => {
    const g = grokServer();
    const sub = (await (await signUp(g.f, { url: GROK, grok_key: "gk_2", lang: "zh" })).json()) as any;
    await e.DB.prepare("INSERT INTO events (id, product, stage, reset_id, post_id, post_url, author, posted_at, text, eta, confidence, confirmations, created_at) VALUES ('evt_codex_6_landed', 'codex', 'landed', 'r', '6', 'u', 'thsottiaux', '2026-10-28T06:35:00Z', 'Lands by midnight PST.', NULL, 'confirmed', '[]', '2026-10-28T06:36:00Z')").run();
    const res = await subsApp(g.f).fetch(jsonReq(`/api/v1/subscriptions/${sub.id}/test?sample=latest`, "POST", undefined, { authorization: `Bearer ${sub.manage_token}` }), e);
    expect(await res.json()).toMatchObject({ delivered: true });
    const message = g.calls.at(-1)!.body.message as string;
    expect(message).toMatch(/^【测试/);
    expect(message).toContain("Lands by midnight PST.");
  });

  it("refuses other hosts and keys Grok does not accept", async () => {
    const g = grokServer();
    expect((await signUp(g.f, { url: "https://hooks.example.com/x", grok_key: "k" })).status).toBe(400);
    expect((await signUp(g.f, { url: GROK, grok_key: "k\r\nX-Evil: 1" })).status).toBe(400);
    const pastedUrl = await signUp(g.f, { url: GROK, grok_key: GROK });
    expect(pastedUrl.status).toBe(400);
    expect(((await pastedUrl.json()) as any).error).toContain("holds a url");
    expect(g.calls.length).toBe(0);
    expect(g.calls.length).toBe(0);
    const bad = grokServer(401);
    const res = await signUp(bad.f, { url: GROK, grok_key: "wrong" });
    expect(res.status).toBe(400);
    expect(await e.DB.prepare("SELECT status FROM subscriptions WHERE kind = 'grok'").first("status")).toBe("rejected");
  });

  it("delivers reset posts as plain messages with the bearer key, landed ones too, and skips reset cards", async () => {
    const sub = (await (await signUp(grokServer().f, { url: GROK, grok_key: "gk_1", lang: "zh" })).json()) as any;
    await e.DB.prepare("INSERT INTO events (id, product, stage, reset_id, post_id, post_url, author, posted_at, text, eta, confidence, confirmations, created_at) VALUES ('evt_codex_9_announced', 'codex', 'announced', 'r', '9', 'https://x.com/thsottiaux/status/9', 'thsottiaux', '2026-10-28T06:00:00Z', 'Reset tonight', '2026-10-29T07:59:00Z', 'confirmed', '[]', '2026-10-28T06:01:00Z')").run();
    const g = grokServer();
    const msg = (eventId: string) => {
      const out = { acked: false };
      return { out, b: { messages: [{ body: { subscriptionId: sub.id, eventId }, attempts: 1, ack: () => void (out.acked = true), retry: () => {} }] } as unknown as MessageBatch<DeliveryMessage> };
    };
    const a = msg("evt_codex_9_announced");
    await handleBatch(a.b, e, g.f);
    expect(a.out.acked).toBe(true);
    expect(g.calls[0].url).toBe(GROK);
    expect(g.calls[0].headers.get("authorization")).toBe("Bearer gk_1");
    expect(g.calls[0].body.message).toContain("「Reset tonight」");
    expect(g.calls[0].body.message).toContain("eta=2026-10-29T07:59:00Z");

    await e.DB.prepare("INSERT INTO events (id, product, stage, reset_id, post_id, post_url, author, posted_at, text, eta, confidence, confirmations, created_at) VALUES ('evt_codex_8_landed', 'codex', 'landed', 'r', '8', 'u', 'thsottiaux', '2026-10-29T07:00:00Z', 'Lands by midnight PST.', NULL, 'confirmed', '[]', '2026-10-29T07:01:00Z')").run();
    const l = msg("evt_codex_8_landed");
    await handleBatch(l.b, e, g.f);
    expect(l.out.acked).toBe(true);
    expect(g.calls[1].body.message).toContain("Lands by midnight PST.");

    await e.DB.prepare("INSERT INTO events (id, product, stage, reset_id, post_id, post_url, author, posted_at, text, eta, confidence, confirmations, created_at) VALUES ('evt_codex_7_banked', 'codex', 'banked', 'r', '7', 'u', 'thsottiaux', '2026-10-29T08:00:00Z', 'card', NULL, 'confirmed', '[]', '2026-10-29T08:01:00Z')").run();
    const bk = msg("evt_codex_7_banked");
    await handleBatch(bk.b, e, g.f);
    expect(bk.out.acked).toBe(true);
    expect(g.calls.length).toBe(2);
  });
});

describe("review regressions (pipeline and queue)", () => {
  const T0 = new Date("2026-10-26T07:00:00Z");

  it("stores nothing when the queue is down, so the next tick still delivers", async () => {
    await subsApp(receiver().f).fetch(jsonReq("/api/v1/subscriptions", "POST", { url: "https://hooks.example.com/a", events: ["codex.*"] }), e);
    const broken = { ...e, DELIVERIES: { sendBatch: async () => { throw new Error("queue down"); } } as unknown as Queue };
    await expect(poll(broken, T0, upstream().f)).rejects.toThrow("queue down");
    expect(await e.DB.prepare("SELECT COUNT(*) AS n FROM events").first("n")).toBe(0);
    await poll(e, new Date(T0.getTime() + 120_000), upstream().f);
    expect(queued.map((m) => m.eventId)).toEqual(["evt_codex_2114588174249071102_landed"]);
  });

  it("retries a message whose event row is not committed yet", async () => {
    const sub = (await (await subsApp(receiver().f).fetch(jsonReq("/api/v1/subscriptions", "POST", { url: "https://hooks.example.com/a" }), e)).json()) as any;
    let retried: unknown;
    const msg = { body: { subscriptionId: sub.id, eventId: "evt_codex_1_landed" }, attempts: 1, ack: () => {}, retry: (o: unknown) => void (retried = o) };
    await handleBatch({ messages: [msg] } as unknown as MessageBatch<DeliveryMessage>, e, receiver().f);
    expect(retried).toEqual({ delaySeconds: 30 });
  });

  it("counts failures atomically when consumers run concurrently", async () => {
    const sub = (await (await subsApp(receiver().f).fetch(jsonReq("/api/v1/subscriptions", "POST", { url: "https://hooks.example.com/a" }), e)).json()) as any;
    await poll(e, T0, upstream().f);
    const bad = receiver(500);
    await Promise.all(
      Array.from({ length: 10 }, () => {
        const msg = { body: { subscriptionId: sub.id, eventId: "evt_codex_2114588174249071102_landed" }, attempts: 1, ack: () => {}, retry: () => {} };
        return handleBatch({ messages: [msg] } as unknown as MessageBatch<DeliveryMessage>, e, bad.f);
      }),
    );
    expect(await e.DB.prepare("SELECT failures FROM subscriptions").first("failures")).toBeGreaterThanOrEqual(8);
    expect(await e.DB.prepare("SELECT status FROM subscriptions").first("status")).toBe("disabled");
  });

  it("hides a retracted event from status, page and feed", async () => {
    await poll(e, T0, upstream().f);
    const row = await e.DB.prepare("SELECT * FROM events WHERE id = 'evt_codex_2114588174249071102_landed'").first<any>();
    await e.DB.prepare("INSERT INTO events (id, product, stage, reset_id, post_id, post_url, author, posted_at, text, eta, confidence, confirmations, created_at) VALUES (?, ?, 'retracted', ?, ?, ?, ?, ?, ?, NULL, 'confirmed', ?, ?)")
      .bind("evt_codex_2114588174249071102_retracted", row.product, row.reset_id, row.post_id, row.post_url, row.author, row.posted_at, row.text, row.confirmations, row.created_at).run();
    const status = (await buildStatus(e, new Date("2026-10-26T06:30:00Z"))) as any;
    expect(status.codex.reset_today_pt).toBe(false);
    expect(status.codex.last_reset.post_url).not.toContain("2114588174249071102");
    const feed = await (await worker.fetch(new Request("https://x.test/feed.xml"), e, {} as ExecutionContext)).text();
    expect(feed).not.toContain("2114588174249071102");
    const api = (await (await worker.fetch(new Request("https://x.test/api/v1/events?limit=100"), e, {} as ExecutionContext)).json()) as any;
    expect(api.events.some((x: any) => x.type === "codex.reset.retracted")).toBe(true);
  });

  it("flags retracted events once in the database, whichever row is stored first, and reads them through an index", async () => {
    const ins = (id: string, stage: string, post: string) =>
      e.DB.prepare("INSERT INTO events (id, product, stage, reset_id, post_id, post_url, author, posted_at, text, eta, confidence, confirmations, created_at) VALUES (?, 'codex', ?, 'r', ?, 'u', 'a', '2026-10-26T00:00:00Z', '', NULL, 'confirmed', '[]', '2026-10-26T00:00:00Z')").bind(id, stage, post).run();
    const flag = (id: string) => e.DB.prepare("SELECT retracted FROM events WHERE id = ?").bind(id).first("retracted");
    await ins("a_landed", "landed", "a");
    await ins("a_retracted", "retracted", "a");
    await ins("b_retracted", "retracted", "b");
    await ins("b_landed", "landed", "b");
    await ins("c_landed", "landed", "c");
    expect([await flag("a_landed"), await flag("b_landed"), await flag("c_landed"), await flag("a_retracted")]).toEqual([1, 1, 0, 0]);
    const { results } = await e.DB.prepare("EXPLAIN QUERY PLAN SELECT * FROM events WHERE product = 'codex' AND stage IN ('landed', 'banked') AND retracted = 0 ORDER BY posted_at DESC LIMIT 14").all<any>();
    expect(results.map((r) => r.detail).join(" ")).toContain("USING INDEX events_live");
  });
});

describe("public pages", () => {
  it("serves the page, the events API, the feed and the privacy page", async () => {
    await poll(e, new Date("2026-10-26T07:00:00Z"), upstream().f);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ html: '<blockquote class="twitter-tweet"><p>Day 21/ ... today is a reset.</p></blockquote>' }));
    const get = (p: string) => worker.fetch(new Request(`https://x.test${p}`), e, {} as ExecutionContext);

    const page = await (await get("/?lang=en")).text();
    expect(page).toContain("Wake your Grok Bot before Codex resets.");
    expect(page).toContain("twitter-tweet");
    expect(page).toContain("Data: codex-reset.com, whenreset.dev");
    expect(page).not.toMatch(/<script[^>]+src=/); // no third-party script until the visitor starts typing
    expect(page).not.toContain("{{"); // every template token was filled
    const data = JSON.parse(/const DATA = (\{.*?\});\n/s.exec(page)![1]);
    expect(data.codex.last).toBe("2026-10-26T06:08:46.000Z");
    expect(data.codex.gaps.length).toBeGreaterThan(3);
    expect(data.events.length).toBeGreaterThan(3);

    // Chinese by default, English on ?lang=en
    const zh = await (await get("/")).text();
    expect(zh).toContain("Codex 要重置时，叫醒你的 Grok Bot。");
    expect(zh).toContain('<html lang="zh-CN">');
    expect(zh).toContain('const LANG = "zh"');
    expect(zh).toContain("/skill/install.sh | sh");
    expect(zh).toContain('<meta property="og:image" content="https://resethook.example.com/og-zh.png">');
    expect(zh).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(page).toContain("/og-en.png");

    // the skill is served from the site: an installer that fetches every bundled file, and the files themselves
    const install = await (await get("/skill/install.sh")).text();
    expect(install).toContain("scripts/burn.mjs");
    expect(install).not.toContain("burn.test.mjs");
    const skill = await get("/skill/SKILL.md");
    expect(skill.headers.get("content-type")).toContain("text/markdown");
    expect(await skill.text()).toContain("name: resethook");
    expect((await get("/skill/../wrangler.prod.jsonc")).status).toBe(404);

    const evs = (await (await get("/api/v1/events?product=codex&limit=3")).json()) as any;
    expect(evs.events).toHaveLength(3);
    expect(evs.events[0].data.post.text.length).toBeLessThanOrEqual(280);
    // newest post first, even though history is inserted oldest-last; `since` returns only newer posts
    const times = evs.events.map((x: any) => Date.parse(x.data.post.posted_at));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    const after = (await (await get(`/api/v1/events?product=codex&since=${evs.events[1].id}`)).json()) as any;
    expect(after.events.map((x: any) => x.id)).toContain(evs.events[0].id);
    expect(after.events.map((x: any) => x.id)).not.toContain(evs.events[1].id);
    const res = await get("/api/v1/status");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toBe("public, max-age=30");
    const single = await get("/api/v1/events/evt_codex_2114588174249071102_landed");
    expect(single.status).toBe(200);
    expect((await get("/api/v1/events/nope")).status).toBe(404);
    expect((await get("/api/v1/events?since=garbage")).status).toBe(400);
    const feed = await (await get("/feed.xml")).text();
    expect(feed).toContain("<feed");
    expect(feed).toContain("codex.reset.landed");
    expect(await (await get("/privacy")).text()).toContain("Privacy");
    vi.restoreAllMocks();
  });
});
