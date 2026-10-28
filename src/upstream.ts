import type { Observation, SourceName } from "./types";

export interface CodexForecast {
  lastResetAt: string | null;
  p24: number | null;
  p48: number | null;
  /** changes when anything that could mean a new announcement changes */
  fingerprint: string;
}

const entities: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
export const decodeText = (s: string) => s.replace(/&(amp|lt|gt|quot|nbsp|#39);/g, (m) => entities[m] ?? m);

const authorOf = (url: string) => /x\.com\/([^/]+)\/status/.exec(url)?.[1] ?? "unknown";

export function parseCodexForecast(j: any): CodexForecast {
  return {
    lastResetAt: j.last_reset_at ?? null,
    p24: j.probabilities?.rounded_24h ?? null,
    p48: j.probabilities?.rounded_48h ?? null,
    fingerprint: JSON.stringify([j.last_reset_at, j.official_signal, j.teased_window, j.tease_signal, j.alert_event_id]),
  };
}

/**
 * codex-reset documents: only group=reset with announcement_state=announced counts as reset.
 * Banked resets are credits-type posts with banked_grant. A reset with preview=true is a heads-up.
 */
export function parseCodexTimeline(j: any): Observation[] {
  const out: Observation[] = [];
  for (const e of j.events ?? []) {
    const base = {
      product: "codex" as const,
      postId: String(e.id),
      postUrl: String(e.url),
      author: authorOf(String(e.url)),
      postedAt: String(e.announced_at),
      text: decodeText(String(e.text ?? e.summary ?? "")).slice(0, 280),
      eta: typeof e.effective_at === "string" ? e.effective_at : null,
      source: "codex-reset.com" as SourceName,
    };
    if (e.banked_grant === true) out.push({ ...base, stage: "banked" });
    else if (e.group === "reset" && e.announcement_state === "announced") out.push({ ...base, stage: "landed" });
    else if (e.group === "reset" && e.preview === true) out.push({ ...base, stage: "announced" });
  }
  return out;
}
