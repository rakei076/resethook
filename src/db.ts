import type { EventRow } from "./types";

type Row = Record<string, unknown>;

// an event whose post was later retracted is hidden from status, the page and the feed (the API still lists both rows);
// a trigger sets the flag when the retraction is stored (migrations/0002)
export const NOT_RETRACTED = "retracted = 0";

export function rowToEvent(r: Row): EventRow {
  return { ...(r as unknown as EventRow), confirmations: JSON.parse(r.confirmations as string) };
}

/** Upstream data is not ours: only an x.com / twitter.com post link is stored, anything else becomes the canonical link. */
export function safePostUrl(url: string, postId: string): string {
  return /^https:\/\/(x|twitter)\.com\/\w{1,15}\/status\/\d{1,25}$/.test(url) ? url : `https://x.com/i/status/${encodeURIComponent(postId)}`;
}

export const insertEvent = (db: D1Database, e: EventRow) =>
  db
    .prepare(
      `INSERT OR IGNORE INTO events (id, product, stage, reset_id, post_id, post_url, author, posted_at, text, eta, confidence, confirmations, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(e.id, e.product, e.stage, e.reset_id, e.post_id, safePostUrl(e.post_url, e.post_id), e.author, e.posted_at, e.text, e.eta, e.confidence, JSON.stringify(e.confirmations), e.created_at);

export const updateEvent = (db: D1Database, e: EventRow) =>
  db.prepare("UPDATE events SET eta = ?, confidence = ?, confirmations = ? WHERE id = ?").bind(e.eta, e.confidence, JSON.stringify(e.confirmations), e.id);

export async function getEvent(db: D1Database, id: string): Promise<EventRow | null> {
  const r = await db.prepare("SELECT * FROM events WHERE id = ?").bind(id).first<Row>();
  return r ? rowToEvent(r) : null;
}

export async function eventsPostedSince(db: D1Database, sinceIso: string): Promise<EventRow[]> {
  const { results } = await db.prepare("SELECT * FROM events WHERE posted_at >= ? ORDER BY posted_at DESC").bind(sinceIso).all<Row>();
  return results.map(rowToEvent);
}

export async function kvAll(db: D1Database): Promise<Map<string, string>> {
  const { results } = await db.prepare("SELECT k, v FROM kv WHERE k NOT LIKE 'oembed:%'").all<{ k: string; v: string }>();
  return new Map(results.map((r) => [r.k, r.v]));
}

export const kvSet = (db: D1Database, k: string, v: string) =>
  db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(k, v);

export async function kvGet(db: D1Database, k: string): Promise<string | null> {
  return (await db.prepare("SELECT v FROM kv WHERE k = ?").bind(k).first<string>("v")) ?? null;
}
