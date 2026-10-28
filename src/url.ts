// Subscriber URLs must be public https endpoints on 443. Workers cannot reach private
// networks anyway; this keeps obvious abuse (IP literals, internal names) out of the table.
export function validateHookUrl(raw: string): URL | string {
  if (raw.length > 2048) return "url too long";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "invalid url";
  }
  if (u.protocol !== "https:") return "url must be https";
  if (u.port && u.port !== "443") return "only port 443 is allowed";
  if (u.username || u.password) return "credentials in url are not allowed";
  const host = u.hostname.toLowerCase();
  if (host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host)) return "ip addresses are not allowed";
  if (!host.includes(".")) return "hostname must contain a dot";
  if (/\.(local|localhost|internal|lan|home|corp)$/.test(host) || host === "localhost") return "internal hostnames are not allowed";
  return u;
}

export const EVENT_PATTERN = /^(\*|(codex|claude)\.\*|(codex|claude)\.reset\.(announced|landed|banked|retracted))$/;

export function parseEvents(input: unknown): string[] | string {
  if (!Array.isArray(input) || input.length === 0 || input.length > 8) return "events must be a non-empty array";
  for (const e of input) if (typeof e !== "string" || !EVENT_PATTERN.test(e)) return `unknown event pattern: ${String(e)}`;
  return [...new Set(input as string[])];
}

export function matches(patterns: string[], type: string): boolean {
  return patterns.some((p) => p === "*" || p === type || (p.endsWith(".*") && type.startsWith(p.slice(0, -1))));
}
