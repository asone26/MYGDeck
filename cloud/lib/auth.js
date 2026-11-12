// Shared by the Pages Functions: the daily session cookie and the PC's registered tunnel.
// Secrets (wrangler pages secret put): DASH_PASSWORD, SESSION_SECRET, REGISTER_KEY. KV binding: DECK.

export const SESSION_COOKIE = "mg_s";
export const DAY = 24 * 60 * 60;

const enc = new TextEncoder();

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Equal strings compared through their MACs, so the time taken says nothing about the content. */
export async function safeEqual(secret, a, b) {
  return (await hmac(secret, `eq:${a}`)) === (await hmac(secret, `eq:${b}`));
}

export async function makeSession(env) {
  const exp = Math.floor(Date.now() / 1000) + DAY;
  return `${exp}.${await hmac(env.SESSION_SECRET, `session:${exp}`)}`;
}

export function cookie(request, name) {
  const all = request.headers.get("cookie") || "";
  for (const part of all.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export async function validSession(request, env) {
  const value = cookie(request, SESSION_COOKIE);
  if (!value) return false;
  const [exp, sig] = value.split(".");
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  return safeEqual(env.SESSION_SECRET, sig, await hmac(env.SESSION_SECRET, `session:${exp}`));
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
}
