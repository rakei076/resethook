import template from "./page.html";
import type { EventRow } from "./types";

type Status = Awaited<ReturnType<typeof import("./status").buildStatus>>;
export type Lang = "en" | "zh";

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const TEXT = {
  en: {
    desc: "Wake your Grok Bot when a Codex reset is announced, so it uses up the quota first. Free, no code.",
    h1: "Wake your Grok Bot before Codex resets.",
    sub: "When Tibo posts about a reset, your bot gets the post and uses up the quota before it is wiped. Free, no code, three steps.",
    viewX: "View on X",
  },
  zh: {
    desc: "Codex 预告重置时叫醒你的 Grok Bot，在重置前把额度用完。免费，不用写代码。",
    h1: "Codex 要重置时，叫醒你的 Grok Bot。",
    sub: "Tibo 一发重置的帖子，Bot 就收到原文，在重置前把额度用完。免费，不用写代码，三步接好。",
    viewX: "在 X 上查看",
  },
};

/** Chinese by default; ?lang=en switches. The server decides so the first paint is already right. */
export function pickLang(query: string | undefined): Lang {
  return query === "en" ? "en" : "zh";
}

// JSON embedded in a <script>: "<" must not be able to close it
const jsonForScript = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

export function renderPage(opts: { lang: Lang; status: Status; latest: EventRow | null; quote: string | null; recent: EventRow[]; sitekey: string; base: string; now: Date }): string {
  const t = TEXT[opts.lang];
  const { status: s, latest, recent } = opts;
  const retracted = new Set(recent.filter((e) => e.stage === "retracted").map((e) => `${e.product}:${e.post_id}`));
  const events = recent
    .filter((e) => (e.stage === "landed" || e.stage === "banked") && !retracted.has(`${e.product}:${e.post_id}`) && Date.parse(e.posted_at) >= opts.now.getTime() - 15 * 86400_000)
    .map((e) => ({ p: e.product, stage: e.stage, at: e.posted_at, url: e.post_url }));
  const data = {
    codex: {
      last: s.codex.last_reset?.landed_at ?? null,
      gaps: s.codex.gap_hours,
      p24: s.codex.forecast?.p24 ?? null,
      p48: s.codex.forecast?.p48 ?? null,
      next: s.codex.next_estimate?.at ?? null,
    },
    claude: { last: s.claude.last_reset?.landed_at ?? null, gaps: s.claude.gap_hours, p24: null, p48: null, next: null },
    events,
  };
  const post = latest
    ? `<div class="post" id="post">${opts.quote ?? `<q>${esc(latest.text)}</q>`}<span>@${esc(latest.author)} · <a href="${esc(latest.post_url)}" target="_blank" rel="noopener">${t.viewX}</a></span></div>`
    : "";
  const turnstile = opts.sitekey ? `<div class="cf-turnstile" id="ts" data-sitekey="${esc(opts.sitekey)}"></div>` : "";
  const fill: Record<string, string> = {
    LANG: opts.lang === "zh" ? "zh-CN" : "en",
    LANGKEY: opts.lang,
    TITLE: "ResetHook",
    TITLE_FULL: esc(`ResetHook · ${t.h1}`),
    LANGQ: opts.lang === "en" ? "?lang=en" : "",
    DESC: esc(t.desc),
    H1: esc(t.h1),
    SUB: esc(t.sub),
    TURNSTILE: turnstile,
    POST: post,
    SITEKEY: esc(opts.sitekey),
    BASE: esc(opts.base),
  };
  return template
    .replace("/*DATA*/{}/*END*/", () => jsonForScript(data))
    .replace(/\{\{(\w+)\}\}/g, (m, k: string) => fill[k] ?? m);
}
