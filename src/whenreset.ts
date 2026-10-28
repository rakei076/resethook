import { decodeText } from "./upstream";
import type { Observation, Product } from "./types";

const PRODUCTS: Product[] = ["codex", "claude"];

export interface WhenresetParsed {
  observations: Observation[];
  nextEstimate: Partial<Record<Product, string>>;
}

/**
 * whenreset: events[] = completed resets/cards (id `<provider>-<postId>`, sources[] with roles pre/landed/followup);
 * watch.<provider> = an open announcement that has not landed yet. Grok events are ignored.
 */
export function parseWhenreset(j: any): WhenresetParsed {
  const observations: Observation[] = [];
  const watchTexts = new Map<string, string>();
  for (const p of PRODUCTS) {
    const w = j.watch?.[p];
    if (w?.postId && w.text) watchTexts.set(String(w.postId), decodeText(String(w.text)).slice(0, 280));
  }

  for (const e of j.events ?? []) {
    if (!PRODUCTS.includes(e.provider) || (e.type !== "reset" && e.type !== "card")) continue;
    const postId = String(e.id).slice(e.provider.length + 1);
    const sources: any[] = e.sources ?? [];
    // a card that only has a "pre" post has not landed: it is an announcement, not a banked reset
    if (!sources.some((s) => s.role === "landed")) continue;
    const earliest = [...sources].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
    const landing = sources.find((s) => s.role === "landed")!;
    const own = sources.find((s) => String(s.postId) === postId) ?? landing;
    // codex-reset stamps resets with the landing time but banked cards with the announcement time; match each
    const stampedAt = e.type === "card" ? earliest : landing;
    observations.push({
      product: e.provider,
      stage: e.type === "card" ? "banked" : "landed",
      postId,
      postUrl: String(own.url),
      author: String(own.account),
      postedAt: String(stampedAt.at),
      text: watchTexts.get(postId) ?? e.reasonNote?.en ?? "",
      eta: null,
      source: "whenreset.dev",
    });
  }

  for (const p of PRODUCTS) {
    const w = j.watch?.[p];
    if (!w?.open || !w.postId) continue;
    observations.push({
      product: p,
      stage: "announced",
      postId: String(w.postId),
      postUrl: String(w.url),
      author: String(w.account),
      postedAt: String(w.at),
      text: decodeText(String(w.text ?? "")).slice(0, 280),
      eta: typeof w.scheduledAt === "string" ? w.scheduledAt : null,
      source: "whenreset.dev",
    });
  }

  const nextEstimate: WhenresetParsed["nextEstimate"] = {};
  for (const p of PRODUCTS) if (j.stats?.[p]?.estimatedNextAt) nextEstimate[p] = j.stats[p].estimatedNextAt;
  return { observations, nextEstimate };
}
