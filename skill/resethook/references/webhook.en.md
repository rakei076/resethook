# Receiving webhooks yourself

Without a Grok Bot, subscribe a signed webhook and receive it on your own server.

## Subscribe

```bash
node scripts/resethook.mjs subscribe https://<your-domain>/hooks/reset
```

- The URL must be `https://` on port 443, a hostname (no IP or internal names), no redirects, answering within 10 seconds.
- On sign-up ResetHook sends `{"type":"challenge","challenge":"<random>"}`; echo the random string back.
- The returned `secret` (for verification) and `manage_url` (test, delete) are shown once.

## Verify

Header `X-Resethook-Signature: t=<unix>,v1=<hex>`, where `hex = HMAC-SHA256(secret, t + "." + raw body)`. Reject when `|now − t| > 300` seconds.

```bash
node scripts/resethook.mjs verify --secret whsec_… --header "t=…,v1=…" < body.json
```

## Retries

Non-2xx answers are retried after 1, 2, 4, 8, 16, 32, 60, 60, 60 minutes; 8 failures in a row turn the subscription off.

## Without a webhook

Run `node scripts/resethook.mjs status --json` once a minute and read `open_announcement`.
