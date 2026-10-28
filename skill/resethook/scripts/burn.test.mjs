// node --test skill/resethook/scripts/burn.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseUntil, plan, rates, simulate } from "./burn.mjs";

const from = new Date("2026-10-28T12:00:00Z");
const q = (p, w, pResetH = 0.25, wResetH = 24 * 6) => ({
  five_hour: { used: p, resets_at: new Date(from.getTime() + pResetH * 3600e3).toISOString() },
  weekly: { used: w, resets_at: new Date(from.getTime() + wResetH * 3600e3).toISOString() },
});
const k = { v: 0.16, measured: false }, r = { v: 40, measured: false };

test("two days is enough to burn a full week, six hours is not", () => {
  const two = plan(q(37, 6), { until: parseUntil("+48h", from), from, k, r });
  assert.equal(two.parallel, 1);
  assert.ok(two.doneAt && two.doneAt < two.deadline);
  const six = plan(q(37, 6), { until: parseUntil("+6h", from), from, k, r });
  assert.equal(six.doneAt, null);
  assert.equal(six.parallel, 3);
  assert.ok(six.weeklyAtEnd > 30 && six.weeklyAtEnd < 50, String(six.weeklyAtEnd));
});

test("the five-hour window caps the pace: at most 100% per window, so 20k weekly percent per hour", () => {
  const { weeklyAtEnd } = simulate(q(0, 0, 5), from, parseUntil("+10h", from), 100, 0.16, 1000, 3);
  assert.ok(Math.abs(weeklyAtEnd - 32) < 0.01, String(weeklyAtEnd)); // two full windows × 16%
});

test("nothing to do when the week is already at the target; the weekly window ending is a deadline too", () => {
  assert.equal(plan(q(10, 96), { until: parseUntil("+48h", from), from, k, r }).parallel, 0);
  const x = plan(q(0, 0, 5, 3), { until: parseUntil("+48h", from), from, k, r });
  assert.equal(x.deadline.getTime(), from.getTime() + 3 * 3600e3);
});

test("rates are measured from readings inside the same windows, and fall back to defaults until there are enough", () => {
  assert.equal(rates([]).k.measured, false);
  const s = [];
  for (let i = 0; i <= 10; i++) s.push({ t: i * 600e3, p: i * 5, p_reset: "a", w: Math.floor(i * 0.8), w_reset: "b", burning: 1 });
  s.push({ t: 11 * 600e3, p: 2, p_reset: "c", w: 8, w_reset: "b", burning: 1 }); // window reset: ignored
  const { k: km, r: rm } = rates(s);
  assert.ok(km.measured && Math.abs(km.v - 0.16) < 1e-9);
  assert.ok(rm.measured && Math.abs(rm.v - 30) < 1e-9);
});

test("relative and absolute deadlines", () => {
  assert.equal(parseUntil("+30m", from).toISOString(), "2026-10-28T12:30:00.000Z");
  assert.equal(parseUntil("2026-10-29T06:00:00Z").toISOString(), "2026-10-29T06:00:00.000Z");
  assert.throws(() => parseUntil("tomorrow"));
});

test("the skill bundled into the site matches skill/resethook (run node scripts/bundle-skill.mjs)", async () => {
  const { readFileSync } = await import("node:fs");
  const { render } = await import("../../../scripts/bundle-skill.mjs");
  assert.equal(readFileSync(new URL("../../../src/skill-files.ts", import.meta.url), "utf8"), render());
});
