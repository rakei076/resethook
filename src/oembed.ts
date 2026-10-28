import { kvGet, kvSet } from "./db";
import type { Env } from "./types";

/** Static quote block from X's oEmbed (no script, no cookies); cached per post forever. */
export async function oembedHtml(env: Env, postId: string, postUrl: string, f: typeof fetch = fetch): Promise<string | null> {
  const key = `oembed:${postId}`;
  const cached = await kvGet(env.DB, key);
  if (cached) return cached;
  try {
    const res = await f(`https://publish.x.com/oembed?omit_script=1&dnt=true&hide_thread=true&url=${encodeURIComponent(postUrl)}`, {
      headers: { "user-agent": env.UPSTREAM_UA },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const html = ((await res.json()) as { html?: string }).html ?? "";
    // only accept the plain blockquote X documents; never inject anything with scripts
    if (!html.startsWith('<blockquote class="twitter-tweet"') || /<(script|iframe|object|embed|style|form|img|svg)|\son\w+\s*=|javascript:|data:/i.test(html)) return null;
    await kvSet(env.DB, key, html).run();
    return html;
  } catch {
    return null;
  }
}
