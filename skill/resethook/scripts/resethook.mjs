#!/usr/bin/env node
// ResetHook command line: status, events, and webhook subscription management. Node 18+, no dependencies.
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

const BASE = (process.env.RESETHOOK_BASE || "https://resethook.rakel.top").replace(/\/$/, "");
const [cmd, ...rest] = process.argv.slice(2);

const opts = {};
const args = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) {
    const k = rest[i].slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) opts[k] = true;
    else { opts[k] = next; i++; }
  } else args.push(rest[i]);
}

const out = (v) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
const die = (msg) => { console.error(msg); process.exit(1); };

async function api(path, { method = "GET", body, token } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return {};
  const json = await res.json().catch(() => ({}));
  if (!res.ok) die(`HTTP ${res.status}: ${json.error ?? "request failed"}`);
  return json;
}

const hoursText = (h) => (h >= 48 ? `${(h / 24).toFixed(1)}d` : `${h.toFixed(1)}h`);

function describe(name, s) {
  const lines = [];
  const last = s.last_reset;
  if (!last) return `${name}: no reset on record`;
  const waited = (Date.now() - Date.parse(last.landed_at)) / 3600e3;
  const gaps = s.gap_hours ?? [];
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  const rank = gaps.length >= 3 ? Math.round((gaps.filter((g) => g < waited).length / gaps.length) * 100) : null;
  lines.push(`${name}: last ${last.stage} ${last.landed_at} (${hoursText(waited)} ago)` + (median ? ` · median gap ${hoursText(median)}` : "") + (rank != null ? ` · waited longer than ${rank}% of past gaps` : ""));
  const a = s.open_announcement;
  if (a) {
    const left = a.eta ? (Date.parse(a.eta) - Date.now()) / 3600e3 : null;
    lines.push(`  ANNOUNCED: ${a.eta ? `lands by ${a.eta} (${left > 0 ? hoursText(left) + " left" : "deadline passed, may land any moment"})` : "no time given"} ${a.post_url}`);
  } else lines.push("  announced: no");
  if (s.forecast) lines.push(`  forecast: 24h ${s.forecast.p24}% / 48h ${s.forecast.p48}% (codex-reset.com's model)`);
  return lines.join("\n");
}

const need = (v, what) => v || die(`missing ${what}`);

switch (cmd) {
  case "status": {
    const s = await api("/api/v1/status");
    if (opts.json) out(s);
    else {
      out(describe("codex", s.codex));
      out(describe("claude", s.claude));
      const bad = s.sources.filter((x) => !x.ok).map((x) => x.name);
      if (bad.length) out(`warning: stale source(s): ${bad.join(", ")}`);
    }
    break;
  }
  case "events": {
    const q = new URLSearchParams({ limit: String(opts.limit ?? 10) });
    if (opts.product) q.set("product", opts.product);
    if (opts.since) q.set("since", opts.since);
    const { events } = await api(`/api/v1/events?${q}`);
    if (opts.json) out(events);
    else for (const e of events) out(`${e.data.post.posted_at}  ${e.type.padEnd(22)} ${e.data.confidence.padEnd(9)} ${e.data.post.url}`);
    break;
  }
  case "stats": {
    // numbers you can check yourself: resets and the gaps between them, from this service's own event list
    const days = Number(opts.days ?? 30), product = opts.product ?? "codex";
    const { events } = await api(`/api/v1/events?product=${product}&limit=100`);
    const times = events.filter((e) => e.data.stage === "landed").map((e) => Date.parse(e.data.post.posted_at)).sort((a, b) => a - b);
    const recent = times.filter((t) => t >= Date.now() - days * 86400e3);
    const gaps = recent.slice(1).map((t, i) => (t - recent[i]) / 3600e3).filter((h) => h >= 3).sort((a, b) => a - b);
    const q = (p) => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))] : null);
    const r = (v) => (v == null ? "n/a" : v.toFixed(1) + "h");
    out({ product, days, resets: recent.length, gaps: gaps.length, median_gap: r(q(0.5)), shortest_gap: r(gaps[0] ?? null), longest_gap: r(gaps.at(-1) ?? null), note: "landed resets only (reset cards are not counted); the list holds at most the latest 100 events" });
    break;
  }
  case "subscribe": {
    const url = need(args[0], "webhook url (https)");
    const events = String(opts.events ?? "codex.reset.announced,codex.reset.retracted").split(",");
    const r = await api("/api/v1/subscriptions", { method: "POST", body: { url, events } });
    out(r);
    console.error("\nSave secret and manage_token now: they are shown once. The secret verifies webhook signatures; the manage_token manages this subscription.");
    break;
  }
  case "show": out(await api(`/api/v1/subscriptions/${need(args[0], "subscription id")}`, { token: need(opts.token ?? process.env.RESETHOOK_TOKEN, "--token or RESETHOOK_TOKEN") })); break;
  case "test": out(await api(`/api/v1/subscriptions/${need(args[0], "subscription id")}/test`, { method: "POST", token: need(opts.token ?? process.env.RESETHOOK_TOKEN, "--token or RESETHOOK_TOKEN") })); break;
  case "rotate": out(await api(`/api/v1/subscriptions/${need(args[0], "subscription id")}/rotate-secret`, { method: "POST", token: need(opts.token ?? process.env.RESETHOOK_TOKEN, "--token or RESETHOOK_TOKEN") })); break;
  case "reverify": out(await api(`/api/v1/subscriptions/${need(args[0], "subscription id")}/reverify`, { method: "POST", token: need(opts.token ?? process.env.RESETHOOK_TOKEN, "--token or RESETHOOK_TOKEN") })); break;
  case "delete": await api(`/api/v1/subscriptions/${need(args[0], "subscription id")}`, { method: "DELETE", token: need(opts.token ?? process.env.RESETHOOK_TOKEN, "--token or RESETHOOK_TOKEN") }); out("deleted"); break;
  case "verify": {
    // resethook verify --secret whsec_… --header "t=…,v1=…" < raw-body-file   (or pass --body-file)
    const secret = need(opts.secret ?? process.env.RESETHOOK_SECRET, "--secret or RESETHOOK_SECRET");
    const header = need(opts.header, '--header "t=…,v1=…"');
    const raw = readFileSync(opts["body-file"] ?? 0, "utf8");
    const parts = header.split(",").map((p) => p.split("="));
    const t = Number(parts.find((p) => p[0] === "t")?.[1]);
    const mac = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
    const fresh = Math.abs(Date.now() / 1000 - t) <= Number(opts.tolerance ?? 300);
    const match = parts.filter((p) => p[0] === "v1").some(([, v]) => v?.length === mac.length && timingSafeEqual(Buffer.from(v), Buffer.from(mac)));
    out(match && fresh ? "valid" : `INVALID (${match ? "signature ok but timestamp outside tolerance" : "signature mismatch"})`);
    process.exit(match && fresh ? 0 : 1);
  }
  default:
    out(`resethook <command>

  status [--json]                     last resets, open announcement (with deadline), forecast
  events [--product codex] [--limit 10] [--since <id|iso>] [--json]
  stats [--product codex] [--days 30]   resets and gaps counted from the event list, so you can check the numbers
  subscribe <https-url> [--events codex.reset.announced,codex.reset.retracted]
  show|test|rotate|reverify|delete <id> --token <manage_token>      (or RESETHOOK_TOKEN)
  verify --secret <whsec_…> --header "t=…,v1=…" [--body-file f]     (raw body on stdin)

Environment: RESETHOOK_BASE (default ${BASE})`);
    process.exit(cmd ? 1 : 0);
}
