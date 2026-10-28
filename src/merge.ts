import type { Confirmation, EventRow, Observation, Product, SourceName, Stage } from "./types";

const DAY = 24 * 3600 * 1000;
// Two upstreams often cite different posts for the same reset; same product + stage within this window is one reset.
const SAME_RESET_MS = 6 * 3600 * 1000;
// an announcement is fulfilled once a reset of that product lands within this long after it
const ANNOUNCE_TO_LAND_MS = 36 * 3600 * 1000;

export const eventId = (product: Product, postId: string, stage: Stage | "retracted") => `evt_${product}_${postId}_${stage}`;
export const resetId = (product: Product, postId: string) => `rst_${product}_${postId}`;

const activeSources = (c: Confirmation[]) => new Set(c.filter((x) => !x.gone_at).map((x) => x.source));
const confidenceOf = (c: Confirmation[]) => (activeSources(c).size >= 2 ? "confirmed" : "single");
const at = (iso: string) => Date.parse(iso);

export interface MergeResult {
  inserts: EventRow[];
  updates: EventRow[];
  // events that should be pushed to subscribers (recent enough, newly created)
  deliver: EventRow[];
}

/** Fold observations into events. One event per reset (matched by post id, else by time proximity). */
export function mergeObservations(existing: Map<string, EventRow>, observations: Observation[], now: Date): MergeResult {
  const nowIso = now.toISOString();
  const state = new Map(existing);
  const inserted = new Set<string>();
  const updated = new Set<string>();

  for (const o of observations) {
    const id = eventId(o.product, o.postId, o.stage);
    const t = at(o.postedAt);
    const all = [...state.values()].filter((e) => e.product === o.product);
    const landed = all.filter((e) => e.stage === "landed");
    if (o.stage === "announced" && landed.some((e) => e.post_id === o.postId || (at(e.posted_at) >= t - SAME_RESET_MS && at(e.posted_at) <= t + ANNOUNCE_TO_LAND_MS))) continue;

    let cur = state.get(id);
    if (!cur && o.stage !== "announced") cur = all.find((e) => e.stage === o.stage && Math.abs(at(e.posted_at) - t) <= SAME_RESET_MS);
    if (!cur) {
      state.set(id, {
        id,
        product: o.product,
        stage: o.stage,
        reset_id: resetId(o.product, o.postId),
        post_id: o.postId,
        post_url: o.postUrl,
        author: o.author,
        posted_at: o.postedAt,
        text: o.text,
        eta: o.eta,
        confidence: "single",
        confirmations: [{ source: o.source, seen_at: nowIso }],
        created_at: nowIso,
      });
      inserted.add(id);
      continue;
    }
    const next: EventRow = { ...cur, confirmations: cur.confirmations.map((c) => ({ ...c })) };
    const mine = next.confirmations.find((c) => c.source === o.source);
    let changed = false;
    if (!mine) {
      next.confirmations.push({ source: o.source, seen_at: nowIso });
      changed = true;
    } else if (mine.gone_at) {
      delete mine.gone_at;
      changed = true;
    }
    if (o.eta && o.eta !== cur.eta) {
      next.eta = o.eta;
      changed = true;
    }
    if (!changed) continue;
    next.confidence = confidenceOf(next.confirmations);
    state.set(cur.id, next);
    if (!inserted.has(cur.id)) updated.add(cur.id);
  }

  const inserts = [...inserted].map((id) => state.get(id)!);
  return {
    inserts,
    updates: [...updated].map((id) => state.get(id)!),
    deliver: inserts.filter((e) => now.getTime() - at(e.posted_at) <= DAY),
  };
}

/**
 * Mark confirmations gone when a source that completely listed its recent events no longer has them.
 * A fresh event whose every confirmation is gone is retracted. `events` must already include this tick's merge.
 */
export function detectRetractions(
  events: EventRow[],
  listings: Partial<Record<SourceName, Observation[]>>,
  now: Date,
): { updates: EventRow[]; retractions: EventRow[] } {
  const nowIso = now.toISOString();
  const have = new Set(events.map((e) => e.id));
  const updates: EventRow[] = [];
  const retractions: EventRow[] = [];

  for (const e of events) {
    if (e.stage === "retracted") continue;
    // only fresh posts: older history can roll out of an upstream's window without being retracted
    if (now.getTime() - at(e.created_at) > DAY || now.getTime() - at(e.posted_at) > DAY) continue;
    if (have.has(eventId(e.product, e.post_id, "retracted"))) continue;
    const lists = (listing: Observation[]) => listing.some((o) => o.product === e.product && o.stage === e.stage && (o.postId === e.post_id || Math.abs(at(o.postedAt) - at(e.posted_at)) <= SAME_RESET_MS));
    // an announcement that dropped off a watch list because the reset landed is fulfilled, not retracted
    const fulfilled = e.stage === "announced" && events.some((x) => x.product === e.product && (x.stage === "landed" || x.stage === "banked") && at(x.posted_at) >= at(e.posted_at) - SAME_RESET_MS && at(x.posted_at) <= at(e.posted_at) + ANNOUNCE_TO_LAND_MS);
    if (fulfilled) continue;

    let changed = false;
    const confirmations = e.confirmations.map((c) => {
      const listing = listings[c.source];
      if (!listing || c.gone_at || lists(listing)) return c;
      changed = true;
      return { ...c, gone_at: nowIso };
    });
    if (!changed) continue;
    const next: EventRow = { ...e, confirmations, confidence: confidenceOf(confirmations) };
    updates.push(next);
    if (activeSources(confirmations).size === 0) {
      retractions.push({ ...next, id: eventId(e.product, e.post_id, "retracted"), stage: "retracted", confidence: "confirmed", created_at: nowIso });
    }
  }
  return { updates, retractions };
}
