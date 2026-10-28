import type { Confirmation, EventRow, SourceName } from "./types";

export const API_VERSION = "2026-10-28";

const SOURCE_URL: Record<SourceName, string> = {
  "codex-reset.com": "https://codex-reset.com/",
  "whenreset.dev": "https://whenreset.dev/",
};

export const eventType = (e: Pick<EventRow, "product" | "stage">) => `${e.product}.reset.${e.stage}`;

export const sourceUrls = (c: Confirmation[]) => [...new Set(c.map((x) => SOURCE_URL[x.source]))];

/** The JSON body for webhooks and for GET /api/v1/events. */
export function eventPayload(e: EventRow) {
  return {
    id: e.id,
    type: eventType(e),
    created_at: e.created_at,
    api_version: API_VERSION,
    data: {
      product: e.product,
      stage: e.stage,
      reset_id: e.reset_id,
      scope: "global",
      eta: e.eta,
      post: { id: e.post_id, url: e.post_url, author: e.author, posted_at: e.posted_at, text: e.text.slice(0, 280) },
      confidence: e.confidence,
      confirmations: e.confirmations.map(({ source, seen_at }) => ({ source, seen_at })),
    },
    source: sourceUrls(e.confirmations),
  };
}
