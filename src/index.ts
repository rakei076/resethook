import { Hono } from "hono";
import { handleBatch } from "./deliver";
import { buildStatus, listEvents } from "./status";
import { oembedHtml } from "./oembed";
import { esc, pickLang, renderPage } from "./page";
import { poll } from "./pipeline";
import { eventsPostedSince, NOT_RETRACTED, rowToEvent } from "./db";
import { clientIp, subscriptionRoutes } from "./subscriptions";
import { eventPayload, eventType } from "./payload";
import { SKILL_FILES } from "./skill-files";
import type { DeliveryMessage, Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

// no framing by other sites, no content-type guessing, no full URLs leaked in Referer
app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("x-content-type-options", "nosniff");
  c.res.headers.set("x-frame-options", "DENY");
  c.res.headers.set("referrer-policy", "strict-origin-when-cross-origin");
});
// 60 requests / 60 s per IP on the whole API
app.use("/api/*", async (c, next) => {
  const { success } = await c.env.API_RL.limit({ key: clientIp(c.req.raw) });
  if (!success) return c.json({ error: "rate limited, poll at most once a minute or use a webhook" }, 429, { "retry-after": "60" });
  await next();
});
// public read endpoints are CORS-open; subscription endpoints are same-origin only
app.use("/api/v1/*", async (c, next) => {
  await next();
  if (c.req.method === "GET" && !c.req.path.startsWith("/api/v1/subscriptions")) c.res.headers.set("access-control-allow-origin", "*");
});

app.get("/api/v1/status", async (c) => c.json(await buildStatus(c.env), 200, { "cache-control": "public, max-age=30" }));

app.get("/api/v1/events", async (c) => {
  let events;
  try {
    events = await listEvents(c.env, { product: c.req.query("product"), since: c.req.query("since"), limit: Number(c.req.query("limit")) || undefined });
  } catch {
    return c.json({ error: "invalid since" }, 400);
  }
  return c.json({ events, attribution: "Data: codex-reset.com, whenreset.dev" }, 200, { "cache-control": "public, max-age=30" });
});

app.get("/api/v1/events/:id", async (c) => {
  const r = await c.env.DB.prepare("SELECT * FROM events WHERE id = ?").bind(c.req.param("id")).first();
  if (!r) return c.json({ error: "not found" }, 404);
  return c.json(eventPayload(rowToEvent(r)), 200, { "cache-control": "public, max-age=300" });
});

app.route("/api/v1/subscriptions", subscriptionRoutes());

app.get("/feed.xml", async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM events WHERE stage IN ('landed','banked') AND ${NOT_RETRACTED} ORDER BY posted_at DESC LIMIT 30`).all();
  const events = results.map(rowToEvent);
  const base = c.env.PUBLIC_BASE_URL;
  const entries = events
    .map((e) => `<entry><id>${esc(e.id)}</id><title>${esc(eventType(e))}</title><updated>${esc(e.posted_at)}</updated><link href="${esc(e.post_url)}"/><summary>${esc(e.text)}</summary></entry>`)
    .join("");
  const updated = events[0]?.posted_at ?? new Date(0).toISOString();
  return c.body(
    `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><id>${esc(base)}/feed.xml</id><title>ResetHook</title><updated>${esc(updated)}</updated><link href="${esc(base)}/feed.xml" rel="self"/>${entries}</feed>`,
    200,
    { "content-type": "application/atom+xml; charset=utf-8", "cache-control": "public, max-age=60" },
  );
});

app.get("/privacy", (c) =>
  c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ResetHook privacy</title><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<body style="font:16px/1.6 system-ui;max-width:640px;margin:2em auto;padding:0 16px"><h1>Privacy</h1>
<p>ResetHook stores the webhook URL you submit (for a Grok Bot, its webhook key too, encrypted), the event patterns you chose, a secret for signing, a hash of the manage token, and a salted hash of your IP address (only to rate-limit sign-ups). Delivery logs (HTTP status, time) are kept for 7 days.</p>
<p>Delete your subscription at any time with <code>DELETE /api/v1/subscriptions/:id</code> using your manage token (or the manage link). The secret, token, key and delivery logs are removed at once; the URL and IP hash stay for up to 2 hours so sign-up limits still apply, then they are removed too. There are no cookies. Cloudflare Turnstile loads only when you start typing in the sign-up form; X scripts load only when you click "Load interactive post".</p>
<p>ResetHook is not affiliated with OpenAI or Anthropic. <a href="/">Back</a></p></body>`),
);

// The skill is served from here so a bot can install it without GitHub: curl -fsSL <base>/skill/install.sh | sh
app.get("/skill/install.sh", (c) => {
  const base = c.env.PUBLIC_BASE_URL;
  const files = Object.keys(SKILL_FILES);
  return c.text(
    `#!/bin/sh
# Installs the ResetHook skill into \${RESETHOOK_SKILL_DIR:-$HOME/.resethook/skill}
set -eu
dir=\${RESETHOOK_SKILL_DIR:-$HOME/.resethook/skill}
mkdir -p "$dir/scripts" "$dir/references"
for f in ${files.join(" ")}; do curl -fsSL "${base}/skill/$f" -o "$dir/$f"; done
echo "ResetHook skill installed in $dir (read $dir/SKILL.md)"
`,
    200,
    { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "public, max-age=300" },
  );
});

app.get("/skill", (c) => {
  const base = c.env.PUBLIC_BASE_URL;
  const en = c.req.query("lang") === "en";
  const list = Object.keys(SKILL_FILES).map((f) => `${base}/skill/${f}`).join("\n");
  return c.text(
    en
      ? `ResetHook skill\n\nInstall: curl -fsSL ${base}/skill/install.sh | sh\nThen read ~/.resethook/skill/SKILL.en.md.\n\nFiles:\n${list}\n`
      : `ResetHook skill\n\n安装：curl -fsSL ${base}/skill/install.sh | sh\n装好后读 ~/.resethook/skill/SKILL.md。\n\n文件：\n${list}\n`,
    200,
    { "cache-control": "public, max-age=300" },
  );
});

app.get("/skill/*", (c) => {
  const path = c.req.path.slice("/skill/".length);
  const body = SKILL_FILES[path];
  if (body === undefined) return c.text("not found", 404);
  return c.text(body, 200, { "content-type": `${path.endsWith(".mjs") ? "text/javascript" : "text/markdown"}; charset=utf-8`, "cache-control": "public, max-age=300" });
});

// The manage link carries "<id>.<token>" in the fragment, which never reaches the server or its logs.
app.get("/manage", (c) => {
  const zh = pickLang(c.req.query("lang")) === "zh";
  const T = zh
    ? { title: "管理 ResetHook", loading: "读取中…", bad: "链接不完整或已失效。", st: { active: "运行中", disabled: "已停用（连续发送失败）", pending: "等待验证", rejected: "没接通" }, test: "发一条测试", del: "停用并删除", sure: "确定删除？删除后不会再收到提醒。", sent: "测试已发出。", fail: "没发出去：", gone: "已删除。", grok: "Grok Bot", hook: "Webhook", back: "回首页" }
    : { title: "Manage ResetHook", loading: "Loading…", bad: "This link is incomplete or no longer valid.", st: { active: "Running", disabled: "Off (too many failed deliveries)", pending: "Waiting for verification", rejected: "Not connected" }, test: "Send a test", del: "Turn off and delete", sure: "Delete it? You will stop getting alerts.", sent: "Test sent.", fail: "Not delivered: ", gone: "Deleted.", grok: "Grok Bot", hook: "Webhook", back: "Home" };
  return c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><title>${T.title}</title>
<body style="font:16px/1.6 system-ui;max-width:560px;margin:2em auto;padding:0 16px;color-scheme:light dark"><h1 style="font-size:22px">${T.title}</h1>
<p id="info">${T.loading}</p><p id="msg"></p>
<p><button id="test" hidden>${T.test}</button> <button id="del" hidden>${T.del}</button></p><p><a href="/">${T.back}</a></p>
<script>
const T = ${JSON.stringify(T).replace(/</g, "\\u003c")};
const [id, token] = location.hash.slice(1).split(".");
const call = (path, method = "GET") => fetch("/api/v1/subscriptions/" + encodeURIComponent(id) + path, { method, headers: { authorization: "Bearer " + token } });
const info = document.getElementById("info"), msg = document.getElementById("msg");
(async () => {
  if (!id || !token) { info.textContent = T.bad; return; }
  const r = await call("");
  if (!r.ok) { info.textContent = T.bad; return; }
  const s = await r.json();
  info.textContent = (s.kind === "grok" ? T.grok : T.hook) + " · " + (T.st[s.status] || s.status) + " · " + s.events.join(", ");
  document.getElementById("test").hidden = document.getElementById("del").hidden = false;
})();
document.getElementById("test").onclick = async () => { const j = await (await call("/test", "POST")).json(); msg.textContent = j.delivered ? T.sent : T.fail + (j.error || j.http_status); };
document.getElementById("del").onclick = async () => { if (!confirm(T.sure)) return; await call("", "DELETE"); info.textContent = T.gone; msg.textContent = ""; document.getElementById("test").hidden = document.getElementById("del").hidden = true; };
</script></body>`);
});

app.get("/", async (c) => {
  const lang = pickLang(c.req.query("lang"));
  const now = new Date();
  const [status, latest, recent] = await Promise.all([
    buildStatus(c.env, now),
    c.env.DB.prepare(`SELECT * FROM events WHERE stage != 'retracted' AND ${NOT_RETRACTED} ORDER BY posted_at DESC LIMIT 1`).first().then((r) => (r ? rowToEvent(r) : null)),
    eventsPostedSince(c.env.DB, new Date(now.getTime() - 15 * 86400_000).toISOString()),
  ]);
  const quote = latest ? await oembedHtml(c.env, latest.post_id, latest.post_url) : null;
  return c.html(renderPage({ lang, status, latest, quote, recent, sitekey: c.env.TURNSTILE_SITEKEY, base: c.env.PUBLIC_BASE_URL, now }), 200, {
    "cache-control": "public, max-age=60",
  });
});

export default {
  fetch: app.fetch,
  scheduled: async (_c: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(poll(env, new Date()));
  },
  queue: (batch: MessageBatch<DeliveryMessage>, env: Env) => handleBatch(batch, env),
};
