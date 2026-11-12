// Web Push from a Worker with WebCrypto only: VAPID (RFC 8292) and aes128gcm payloads (RFC 8291).
// The VAPID key is one secret, VAPID_KEY: a P-256 private JWK (`node vapid.mjs` makes one).

const enc = new TextEncoder();

export const b64u = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The application server key the browser subscribes with: the uncompressed public point. */
export function publicKey(jwkText) {
  const j = JSON.parse(jwkText);
  return b64u(concat(new Uint8Array([4]), unb64u(j.x), unb64u(j.y)));
}

/** `Authorization` header for one push service: a 12-hour JWT signed with the VAPID key. */
export async function vapid(endpoint, jwkText, subject) {
  const j = JSON.parse(jwkText);
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: j.x, y: j.y, d: j.d, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${claims}`));
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${publicKey(jwkText)}`;
}

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/** One aes128gcm record for the subscription's keys (p256dh, auth). */
export async function encrypt(sub, payload) {
  const uaPublic = unb64u(sub.keys.p256dh);
  const auth = unb64u(sub.keys.auth);
  const ua = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: ua }, local.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // 0x02: padding delimiter of the last (only) record.
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(enc.encode(payload), new Uint8Array([2]))));
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, sealed);
}

/** Push services browsers use; the Worker sends nowhere else. */
export function pushHost(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && /(^|\.)(googleapis\.com|push\.apple\.com|mozilla\.com|notify\.windows\.com)$/.test(u.hostname);
  } catch {
    return false;
  }
}

/** Send one push; returns the push service's HTTP status (404/410: the subscription is gone). */
export async function sendPush(sub, payload, jwkText, subject, urgency = "normal") {
  if (!pushHost(sub.endpoint)) return 400;
  const body = await encrypt(sub, payload);
  const r = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapid(sub.endpoint, jwkText, subject),
      TTL: "3600",
      Urgency: urgency,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
    },
    body,
  });
  return r.status;
}
