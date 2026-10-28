export type Product = "codex" | "claude";
export type Stage = "announced" | "landed" | "banked";

export interface Env {
  DB: D1Database;
  DELIVERIES: Queue<DeliveryMessage>;
  API_RL: RateLimit;
  PUBLIC_BASE_URL: string;
  UPSTREAM_UA: string;
  TURNSTILE_SITEKEY: string;
  TURNSTILE_SECRET?: string;
  IP_SALT: string;
  MAX_FAILURES: string;
  KEY_SECRET?: string; // base64 of 32 random bytes: encrypts Grok webhook keys at rest
}

export interface DeliveryMessage {
  subscriptionId: string;
  eventId: string;
}

// One upstream's claim that something happened, keyed by the X post id.
export interface Observation {
  product: Product;
  stage: Stage;
  postId: string;
  postUrl: string;
  author: string;
  postedAt: string;
  text: string;
  eta: string | null;
  source: SourceName;
}

export type SourceName = "codex-reset.com" | "whenreset.dev";

export interface Confirmation {
  source: SourceName;
  seen_at: string;
  gone_at?: string;
}

export interface EventRow {
  id: string;
  product: Product;
  stage: Stage | "retracted";
  reset_id: string;
  post_id: string;
  post_url: string;
  author: string;
  posted_at: string;
  text: string;
  eta: string | null;
  confidence: "single" | "confirmed";
  confirmations: Confirmation[];
  created_at: string;
}
