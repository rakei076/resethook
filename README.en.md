# ResetHook

Wakes your Grok Bot when a global Codex reset is announced, so it uses up the remaining quota before the reset.

[Website](https://resethook.rakel.top/?lang=en) · [中文](README.md) · MIT · Cloudflare Workers

## Connect a Grok Bot

On https://resethook.rakel.top/?lang=en, no code:

1. Copy the text on the page and send it to your Grok Bot. The bot installs the skill and the Codex CLI, and creates a routine triggered by Webhook.
2. Paste the routine's webhook URL and key into the page and press Connect.
3. When "ResetHook test" shows up in Grok, you are connected. The page gives a manage link for tests and turning it off.

From then on, each reset announcement brings the bot the post, its author, a link and a parsed deadline; the bot decides with the skill whether to burn quota. Resets that already happened are not sent.

## Skill

```bash
curl -fsSL https://resethook.rakel.top/skill/install.sh | sh    # installs into ~/.resethook/skill
```

Source in [`skill/resethook`](skill/resethook). `scripts/burn.mjs` reads the live quota from Codex, works out whether it can be used up before the deadline, and runs read-only Codex tasks in the background:

```
weekly % that can still be used ≈ k × [(100 − P) + 100 × five-hour resets before the deadline]
```

P is the five-hour window used; k is the weekly percent per 1% of the five-hour window. OpenAI does not publish k; Plus users measure a full five-hour window at 15–16% of the week, so it defaults to 0.16 and is replaced by your own readings.

## Events

| Type | When |
| --- | --- |
| `codex.reset.announced` | A reset was announced; `data.eta` is the parsed latest time |
| `codex.reset.landed` | The reset took effect |
| `codex.reset.banked` | A reset card was granted (redeemable later) |
| `codex.reset.retracted` | An earlier event was withdrawn within 24 hours |
| `claude.reset.*` | Same, for Claude (beta, one source) |
| `ping` | A test |

```json
{
  "id": "evt_codex_2114588174249071102_landed",
  "type": "codex.reset.landed",
  "created_at": "2026-10-26T06:16:02Z",
  "api_version": "2026-10-28",
  "data": {
    "product": "codex", "stage": "landed", "reset_id": "rst_codex_2114588174249071102",
    "scope": "global", "eta": null,
    "post": { "id": "2114588174249071102", "url": "https://x.com/thsottiaux/status/2114588174249071102", "author": "thsottiaux", "posted_at": "2026-10-26T06:08:46Z", "text": "…" },
    "confidence": "confirmed",
    "confirmations": [{ "source": "codex-reset.com", "seen_at": "2026-10-26T06:10:00Z" }, { "source": "whenreset.dev", "seen_at": "2026-10-26T06:15:00Z" }]
  },
  "source": ["https://codex-reset.com/", "https://whenreset.dev/"]
}
```

Retries keep the same `id`; dedupe on it.

## Receiving webhooks yourself

```bash
curl -X POST https://resethook.rakel.top/api/v1/subscriptions \
  -H 'content-type: application/json' \
  -d '{"url":"https://<your-domain>/hooks/reset","events":["codex.reset.announced"]}'
```

- Sign-up sends `{"type":"challenge","challenge":"…"}`; echo the string back. The returned `secret` and `manage_url` are shown once.
- Every request carries `X-Resethook-Signature: t=<unix>,v1=<hex>`, `v1 = HMAC-SHA256(secret, t + "." + raw body)`. Use the raw body and a constant-time compare, reject when `|now − t| > 300` s, and accept any `v1` (two appear for 24 hours after a rotation).
- Test vector: secret `whsec_test_secret`, `t=1700000000`, body `{"hello":"world"}`, `v1=86748dbec9cc87a9219f8a96632da703271bf5e85aa0afa2b310c37ba059d514`.
- HTTPS on 443 only, no redirects, 10 s timeout. Non-2xx answers are retried after 1, 2, 4, 8, 16, 32, 60, 60, 60 minutes; 8 failures in a row turn the subscription off.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verify(rawBody, header, secret, tolerance = 300) {
  const parts = header.split(",").map((p) => p.split("="));
  const t = Number(parts.find((p) => p[0] === "t")?.[1]);
  if (!t || Math.abs(Date.now() / 1000 - t) > tolerance) return false;
  const mac = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return parts.filter((p) => p[0] === "v1").some(([, v]) => v?.length === mac.length && timingSafeEqual(Buffer.from(v), Buffer.from(mac)));
}
```

## API

| Call | Returns |
| --- | --- |
| `GET /api/v1/status` | Recent resets, open announcement, past gaps, forecast, source health |
| `GET /api/v1/events?product=codex&since=<id or time>&limit=50` | Events, newest first, up to 100 |
| `GET /api/v1/events/:id` | One event |
| `GET /feed.xml` | Atom (landed, banked) |
| `POST /api/v1/subscriptions` | Create; `GET`, `DELETE`, `/test`, `/rotate-secret`, `/reverify` need `Authorization: Bearer <manage_token>` |

Reads are CORS-open, 60 requests a minute per IP.

## Self-hosting

```bash
npm install --legacy-peer-deps
npx wrangler d1 create resethook                   # put the id in wrangler.jsonc
npx wrangler d1 migrations apply resethook --remote
npx wrangler queues create resethook-deliveries
npx wrangler queues create resethook-deliveries-dlq
openssl rand -hex 32 | npx wrangler secret put IP_SALT
openssl rand -base64 32 | npx wrangler secret put KEY_SECRET    # encrypts Grok keys; lose it and stored keys cannot be read
npx wrangler deploy
```

Set `routes`, `PUBLIC_BASE_URL` and a contact address in `UPSTREAM_UA` in `wrangler.jsonc` first. Node 22+. Optional: Cloudflare Turnstile (`TURNSTILE_SITEKEY`, `TURNSTILE_SECRET`). `npm test` runs every test. The free plan is enough.

To keep your Grok key out of the service, deploy the relay in [`adapters/grok`](adapters/grok) instead.

## Security and privacy

- Grok keys are stored AES-GCM encrypted and sent only to `api2.cursor.sh`; manage tokens are stored hashed; the manage link keeps its credential after `#`, which never reaches the server.
- Deliveries go to public HTTPS on 443 only, no IP or internal names, no redirects; request and response bodies are read with a size limit.
- Sign-ups are limited per IP and per URL (deleting does not reset the count), Turnstile optional; reads are limited per IP.
- Upstream data is treated as untrusted: only x.com post links are kept, quoted posts are filtered for scripts and handlers, and only posts from trusted accounts reach the bot, marked as information, not instructions.
- Stored: subscription URL, event types, signing secret, encrypted Grok key, manage-token hash, salted IP hash (for rate limits only). Delivery logs are kept 7 days.

## Data

[codex-reset.com](https://codex-reset.com) (every minute) and [whenreset.dev](https://whenreset.dev) (every 5 minutes), merged and deduplicated. Forecast probabilities come from codex-reset.com's model. Not affiliated with OpenAI or Anthropic.

MIT, by [Rakel](https://rakel.top).
