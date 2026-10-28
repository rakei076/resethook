import { describe, expect, it } from "vitest";
import { detectRetractions, mergeObservations } from "../src/merge";
import { signHeader } from "../src/sign";
import { parseCodexForecast, parseCodexTimeline } from "../src/upstream";
import { parseWhenreset } from "../src/whenreset";
import { matches, parseEvents, validateHookUrl } from "../src/url";
import type { EventRow, Observation } from "../src/types";
import { fixture, verifyHeader } from "./helpers";

const codex = parseCodexTimeline(fixture("codex-timeline.json"));
const when = parseWhenreset(fixture("whenreset.json"));
const T = new Date("2026-10-26T07:00:00Z");

describe("codex-reset adapter", () => {
  it("reads the documented landed rule and decodes text", () => {
    const landed = codex.find((o) => o.postId === "2114588174249071102")!;
    expect(landed).toMatchObject({ product: "codex", stage: "landed", author: "thsottiaux", source: "codex-reset.com" });
    expect(landed.text).toContain("today is a reset");
    // 10/23 post is unconfirmed live-feed data (announcement_state none): not a reset
    expect(codex.some((o) => o.postId === "2113492187770175603")).toBe(false);
  });
  it("maps banked grants to banked", () => {
    const banked = codex.filter((o) => o.stage === "banked");
    expect(banked.length).toBeGreaterThan(0);
  });
  it("fingerprints the forecast", () => {
    const f = parseCodexForecast(fixture("codex-forecast.json"));
    expect(f).toMatchObject({ lastResetAt: "2026-10-26T06:08:46.000Z", p24: 46, p48: 71 });
  });
});

describe("whenreset adapter", () => {
  it("skips grok and cards that never landed, keys events by the post id in the event id", () => {
    expect(when.observations.every((o) => o.product === "codex" || o.product === "claude")).toBe(true);
    expect(when.observations.some((o) => o.postId === "2114588174249071102" && o.stage === "landed")).toBe(true);
    expect(when.observations.some((o) => o.postId === "2090964822422949999")).toBe(false);
  });
  it("reports an open watch as an announcement with an eta", () => {
    const a = when.observations.find((o) => o.stage === "announced")!;
    expect(a.eta).toBe("2026-10-26T07:00:00.000Z");
    expect(when.nextEstimate.codex).toMatch(/^2026-/);
  });
});

describe("merge", () => {
  it("creates one event when both sources report the same reset, even with different post ids", () => {
    // 10/25: codex-reset cites ...124163 (reply), whenreset cites ...882932
    const a = codex.find((o) => o.postId === "2114200291319124163")!;
    const b = when.observations.find((o) => o.postId === "2114237083652882932")!;
    expect(a && b).toBeTruthy();
    const first = mergeObservations(new Map(), [a], T);
    const row = first.inserts[0];
    const second = mergeObservations(new Map([[row.id, row]]), [b], T);
    expect(second.inserts).toHaveLength(0);
    expect(second.updates[0].confirmations.map((c) => c.source).sort()).toEqual(["codex-reset.com", "whenreset.dev"]);
    expect(second.updates[0].confidence).toBe("confirmed");
  });
  it("only pushes events from the last 24 hours (history is stored silently)", () => {
    const m = mergeObservations(new Map(), [...codex, ...when.observations], new Date("2026-10-26T08:00:00Z"));
    expect(m.inserts.length).toBeGreaterThan(5);
    expect(m.deliver.map((e) => e.post_id)).toContain("2114588174249071102");
    expect(m.deliver.every((e) => Date.parse("2026-10-26T08:00:00Z") - Date.parse(e.posted_at) <= 86400_000)).toBe(true);
    const later = mergeObservations(new Map(), [...codex, ...when.observations], new Date("2026-10-28T03:00:00Z"));
    expect(later.deliver).toHaveLength(0);
  });
  it("does not announce a reset that already landed", () => {
    const landed = when.observations.find((o) => o.stage === "landed" && o.postId === "2114588174249071102")!;
    const open = when.observations.find((o) => o.stage === "announced")!;
    const m = mergeObservations(new Map(), [landed, open], T);
    expect(m.inserts.map((e) => e.stage)).toEqual(["landed"]);
  });
  it("is idempotent", () => {
    const once = mergeObservations(new Map(), codex, T);
    const map = new Map(once.inserts.map((e) => [e.id, e]));
    const twice = mergeObservations(map, codex, T);
    expect(twice.inserts).toHaveLength(0);
    expect(twice.updates).toHaveLength(0);
  });
});

describe("retraction", () => {
  const obs: Observation = { product: "codex", stage: "landed", postId: "1", postUrl: "u", author: "a", postedAt: "2026-10-26T06:00:00Z", text: "t", eta: null, source: "codex-reset.com" };
  const row = mergeObservations(new Map(), [obs], T).inserts[0];
  it("retracts when every confirming source stops listing the event within 24h", () => {
    const r = detectRetractions([row], { "codex-reset.com": [] }, new Date("2026-10-26T09:00:00Z"));
    expect(r.retractions[0]).toMatchObject({ id: "evt_codex_1_retracted", stage: "retracted" });
  });
  it("does nothing while a source still lists it, or when a source is unknown", () => {
    expect(detectRetractions([row], { "codex-reset.com": [obs] }, T).retractions).toHaveLength(0);
    expect(detectRetractions([row], {}, T).retractions).toHaveLength(0);
  });
  it("leaves one-source loss alone when another source still confirms", () => {
    const two: EventRow = { ...row, confirmations: [...row.confirmations, { source: "whenreset.dev", seen_at: T.toISOString() }] };
    const r = detectRetractions([two], { "codex-reset.com": [] }, T);
    expect(r.retractions).toHaveLength(0);
    expect(r.updates[0].confidence).toBe("single");
  });
});

describe("review regressions", () => {
  const base: Observation = { product: "codex", stage: "landed", postId: "10", postUrl: "u", author: "a", postedAt: "2026-10-26T06:00:00Z", text: "t", eta: null, source: "codex-reset.com" };

  it("does not retract an event another source confirms in the same tick", () => {
    const row = mergeObservations(new Map(), [base], T).inserts[0];
    const later = new Date("2026-10-26T08:00:00Z");
    const viaB = { ...base, postId: "11", source: "whenreset.dev" as const };
    const merged = mergeObservations(new Map([[row.id, row]]), [viaB], later);
    const state = new Map([[row.id, row]]);
    for (const x of merged.updates) state.set(x.id, x);
    const r = detectRetractions([...state.values()], { "codex-reset.com": [], "whenreset.dev": [viaB] }, later);
    expect(r.retractions).toHaveLength(0);
    expect(r.updates[0].confirmations.map((c) => [c.source, !!c.gone_at])).toEqual([["codex-reset.com", true], ["whenreset.dev", false]]);
  });

  it("keeps both an eta update and a new confirmation from the same tick", () => {
    const row = mergeObservations(new Map(), [{ ...base, stage: "announced" }], T).inserts[0];
    const a = { ...base, stage: "announced" as const, eta: "2026-10-26T07:00:00Z", source: "whenreset.dev" as const };
    const b = { ...base, stage: "announced" as const, source: "whenreset.dev" as const };
    const m = mergeObservations(new Map([[row.id, row]]), [a, b], T);
    expect(m.updates).toHaveLength(1);
    expect(m.updates[0].eta).toBe("2026-10-26T07:00:00Z");
    expect(m.updates[0].confirmations).toHaveLength(2);
  });

  it("does not retract an announcement because the reset landed and the watch closed", () => {
    const ann = mergeObservations(new Map(), [{ ...base, stage: "announced", postId: "20", postedAt: "2026-10-26T05:00:00Z", source: "whenreset.dev" }], T).inserts[0];
    const land = mergeObservations(new Map(), [{ ...base, postId: "21", postedAt: "2026-10-26T15:00:00Z", source: "whenreset.dev" }], T).inserts[0];
    const r = detectRetractions([ann, land], { "whenreset.dev": [{ ...base, postId: "21", postedAt: "2026-10-26T15:00:00Z" }] }, new Date("2026-10-26T16:00:00Z"));
    expect(r.retractions).toHaveLength(0);
    // but an announcement that simply disappears is retracted
    expect(detectRetractions([ann], { "whenreset.dev": [] }, new Date("2026-10-26T16:00:00Z")).retractions).toHaveLength(1);
  });

  it("stamps whenreset resets with the landing time and cards with the announcement time", () => {
    expect(when.observations.find((o) => o.postId === "2113162277688070445")!.postedAt).toBe("2026-10-22T17:00:00.000Z");
    expect(when.observations.find((o) => o.postId === "2107913738791596286")!).toMatchObject({ stage: "banked", postedAt: "2026-10-07T19:19:33.000Z" });
  });
});

describe("signing and url rules", () => {
  it("signs t.body and verifies with the documented receiver snippet, including during rotation", async () => {
    const body = JSON.stringify({ a: 1 });
    const h = await signHeader("whsec_new", body, 1000);
    expect(await verifyHeader(body, h, "whsec_new", 1100)).toBe(true);
    expect(await verifyHeader(body, h, "whsec_new", 1400)).toBe(false); // replay window
    expect(await verifyHeader(body + " ", h, "whsec_new", 1100)).toBe(false);
    const both = `${h},${(await signHeader("whsec_old", body, 1000)).split(",")[1]}`;
    expect(await verifyHeader(body, both, "whsec_old", 1000)).toBe(true);
    expect(await verifyHeader(body, both, "whsec_new", 1000)).toBe(true);
  });
  it("rejects unsafe webhook urls", () => {
    for (const bad of ["http://a.com/x", "https://127.0.0.1/x", "https://localhost/x", "https://a.internal/x", "https://nodot/x", "https://a.com:8443/x", "https://u:p@a.com/x", "https://[::1]/x"]) {
      expect(typeof validateHookUrl(bad), bad).toBe("string");
    }
    expect(validateHookUrl("https://example.com/hooks/reset")).toBeInstanceOf(URL);
  });
  it("matches event patterns", () => {
    expect(matches(["codex.*"], "codex.reset.landed")).toBe(true);
    expect(matches(["codex.*"], "claude.reset.landed")).toBe(false);
    expect(matches(["*"], "claude.reset.banked")).toBe(true);
    expect(matches(["codex.reset.landed"], "codex.reset.banked")).toBe(false);
    expect(parseEvents(["codex.*", "bogus"])).toMatch(/unknown/);
  });
});

describe("untrusted upstream data", () => {
  it("stores only real post links", async () => {
    const { safePostUrl } = await import("../src/db");
    expect(safePostUrl("https://x.com/thsottiaux/status/2115273253711409208", "2115273253711409208")).toBe("https://x.com/thsottiaux/status/2115273253711409208");
    expect(safePostUrl("javascript:alert(1)", "123")).toBe("https://x.com/i/status/123");
    expect(safePostUrl('https://x.com/a/status/1"><script>', "1")).toBe("https://x.com/i/status/1");
    expect(safePostUrl(null as unknown as string, "9")).toBe("https://x.com/i/status/9");
  });

  it("accepts only a plain oEmbed quote, nothing with handlers, scripts or odd links", async () => {
    const { oembedHtml } = await import("../src/oembed");
    const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({}) }) }) }, UPSTREAM_UA: "t" } as any;
    const serve = (html: string) => (async () => Response.json({ html })) as unknown as typeof fetch;
    expect(await oembedHtml(env, "1", "u", serve('<blockquote class="twitter-tweet"><p>Reset tonight</p></blockquote>'))).toContain("Reset tonight");
    for (const bad of ['<blockquote class="twitter-tweet"><img src=x onerror=alert(1)></blockquote>', '<blockquote class="twitter-tweet"><a href="javascript:alert(1)">x</a></blockquote>', '<div onclick="x">', '<blockquote class="twitter-tweet"><script>x</script></blockquote>'])
      expect(await oembedHtml(env, "1", "u", serve(bad))).toBeNull();
  });
});
