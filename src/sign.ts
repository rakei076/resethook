const enc = new TextEncoder();

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const randomToken = (prefix: string, bytes = 32) => prefix + b64url(crypto.getRandomValues(new Uint8Array(bytes)));

export async function sha256Hex(input: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(input)));
}

// signature = hex(HMAC-SHA256(secret, `${t}.${body}`)), header `t=<unix>,v1=<sig>`
export async function signHeader(secret: string, body: string, t: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = hex(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${body}`)));
  return `t=${t},v1=${mac}`;
}
