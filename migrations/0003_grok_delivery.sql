-- Subscriptions that deliver straight to a Grok Bot routine (Bearer key, plain message) instead of a signed webhook.
ALTER TABLE subscriptions ADD COLUMN kind TEXT NOT NULL DEFAULT 'webhook';
ALTER TABLE subscriptions ADD COLUMN bearer_enc TEXT;
ALTER TABLE subscriptions ADD COLUMN lang TEXT NOT NULL DEFAULT 'en';
