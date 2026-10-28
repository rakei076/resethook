import type { Env } from "../src/types";
import codexForecast from "./fixtures/codex-forecast.json";
import codexTimeline from "./fixtures/codex-timeline.json";
import whenreset from "./fixtures/whenreset.json";

// workerd has no filesystem: fixtures are bundled as JSON modules
const fixtures: Record<string, unknown> = { "codex-forecast.json": codexForecast, "codex-timeline.json": codexTimeline, "whenreset.json": whenreset };
export const fixture = (name: string) => structuredClone(fixtures[name]) as any;

export const verifyHeader = async (rawBody: string, header: string, secret: string, nowSec: number, tolerance = 300) => {
  const { createHmac, timingSafeEqual } = await import("node:crypto");
  const parts = header.split(",").map((s) => s.split("="));
  const t = Number(parts.find((p) => p[0] === "t")![1]);
  if (Math.abs(nowSec - t) > tolerance) return false;
  const mac = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return parts.filter((p) => p[0] === "v1").some((p) => p[1].length === mac.length && timingSafeEqual(Buffer.from(p[1]), Buffer.from(mac)));
};

export function fakeEnv(base: Env, queued: unknown[] = []): Env {
  return {
    ...base,
    DELIVERIES: { send: async (m: unknown) => void queued.push(m), sendBatch: async (ms: { body: unknown }[]) => void queued.push(...ms.map((m) => m.body)) } as unknown as Queue,
    API_RL: { limit: async () => ({ success: true }) } as unknown as RateLimit,
  };
}
