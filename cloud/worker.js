// Phone dashboard relay (Cloudflare Worker): serves the page from ./public, asks for a password once a
// day, and forwards /api/* to the PC's session daemon over Workers VPC: a named Cloudflare Tunnel
// that the daemon runs, with no public hostname and no domain. The phone never holds the dashboard
// token; this Worker adds it.
//
// Secrets (wrangler secret put): DASH_PASSWORD, SESSION_SECRET, DASH_TOKEN (= token in ~/.mygdeck/mobile.json),
// VAPID_KEY (optional, `node vapid.mjs`: turns on phone notifications).
// Bindings (wrangler.toml): ASSETS, DECK (KV: failed logins, push subscriptions), PC (VPC service → 127.0.0.1:7781).
import { DAY, SESSION_COOKIE, json, makeSession, safeEqual, validSession } from "./lib/auth.js";
import { publicKey, pushHost, sendPush } from "./lib/webpush.js";

const MAX_FAILS = 10;
const LOCK_SECONDS = 15 * 60;

async function login(request, env) {
  if (!env.DASH_PASSWORD || !env.SESSION_SECRET) return json({ error: "relay가 아직 설정되지 않았습니다 (DASH_PASSWORD, SESSION_SECRET)" }, 500);
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const failKey = `fail:${ip}`;
  const fails = Number((await env.DECK.get(failKey)) || 0);
  if (fails >= MAX_FAILS) return json({ error: "비밀번호를 여러 번 틀렸습니다. 15분 뒤에 다시 시도하세요." }, 429);

  const { password = "" } = await request.json().catch(() => ({}));
  // Spaces around a password are never meant: a pasted value or a hidden prompt can add them.
  if (!(await safeEqual(env.SESSION_SECRET, String(password).trim(), String(env.DASH_PASSWORD).trim()))) {
    await env.DECK.put(failKey, String(fails + 1), { expirationTtl: LOCK_SECONDS });
    return json({ error: "비밀번호가 맞지 않습니다" }, 401);
  }
  if (fails) await env.DECK.delete(failKey);
  const session = await makeSession(env);
  return json(null, 200, { "set-cookie": `${SESSION_COOKIE}=${session}; Path=/; Max-Age=${DAY}; HttpOnly; Secure; SameSite=Lax` });
}

async function relay(request, env) {
  if (!(await validSession(request, env))) return json({ error: "login" }, 401);
  const url = new URL(request.url);
  const headers = { cookie: `mygdeck_k=${env.DASH_TOKEN}` };
  for (const h of ["content-type", "x-mygdeck"]) {
    const v = request.headers.get(h);
    if (v) headers[h] = v;
  }
  try {
    // The VPC service fixes the target (127.0.0.1:7781 on the PC); this URL only carries the path.
    const res = await env.PC.fetch(
      new Request(`http://127.0.0.1:7781${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
        redirect: "manual",
      }),
    );
    return new Response(res.body, { status: res.status, headers: { "content-type": res.headers.get("content-type") || "application/json", "cache-control": "no-store" } });
  } catch {
    // The tunnel is down: PC off, or the deck (and with it the daemon and the tunnel) closed.
    return json({ error: "offline" }, 503);
  }
}

// ---- Phone notifications ----
// The phone subscribes here (signed in); the PC's daemon calls /push/notify with the dashboard token
// when an agent starts waiting or finishes, and this Worker forwards it to every subscribed phone.

const SUBS = "push:subs";
const MAX_SUBS = 10;

async function push(request, env, pathname) {
  const subs = async () => (await env.DECK.get(SUBS, "json")) || [];
  if (pathname === "/push/notify" && request.method === "POST") {
    const token = request.headers.get("x-mygdeck-token") || "";
    if (!env.DASH_TOKEN || !env.SESSION_SECRET || !(await safeEqual(env.SESSION_SECRET, token, env.DASH_TOKEN))) return json({ error: "unauthorized" }, 401);
    if (!env.VAPID_KEY) return json({ sent: 0, off: true });
    const m = await request.json().catch(() => ({}));
    const payload = JSON.stringify({
      title: String(m.title || "MYG Deck").slice(0, 120),
      body: String(m.body || "").slice(0, 300),
      tag: String(m.tag || "mygdeck").slice(0, 200),
      url: String(m.url || "/").startsWith("/") ? String(m.url || "/").slice(0, 600) : "/",
      urgent: !!m.urgent,
    });
    const list = await subs();
    const subject = new URL(request.url).origin;
    const codes = await Promise.all(list.map((s) => sendPush(s, payload, env.VAPID_KEY, subject, m.urgent ? "high" : "normal").catch(() => 0)));
    const keep = list.filter((_, i) => codes[i] !== 404 && codes[i] !== 410);
    if (keep.length !== list.length) await env.DECK.put(SUBS, JSON.stringify(keep));
    return json({ sent: codes.filter((c) => c >= 200 && c < 300).length, removed: list.length - keep.length });
  }

  if (!(await validSession(request, env))) return json({ error: "login" }, 401);
  if (!env.VAPID_KEY) return json({ error: "알림이 설정되지 않았습니다" }, 404);
  if (pathname === "/push/key" && request.method === "GET") return json({ key: publicKey(env.VAPID_KEY) });
  if (request.method !== "POST" || request.headers.get("x-mygdeck") !== "1") return json({ error: "not found" }, 404);
  const body = await request.json().catch(() => ({}));
  const endpoint = String(body.endpoint || "");
  if (pathname === "/push/subscribe") {
    const { p256dh, auth } = body.keys || {};
    if (!pushHost(endpoint) || endpoint.length > 1000 || typeof p256dh !== "string" || typeof auth !== "string") return json({ error: "잘못된 구독" }, 400);
    const list = (await subs()).filter((s) => s.endpoint !== endpoint);
    list.push({ endpoint, keys: { p256dh, auth } });
    await env.DECK.put(SUBS, JSON.stringify(list.slice(-MAX_SUBS)));
    return json(null);
  }
  if (pathname === "/push/unsubscribe") {
    const list = await subs();
    const keep = list.filter((s) => s.endpoint !== endpoint);
    if (keep.length !== list.length) await env.DECK.put(SUBS, JSON.stringify(keep));
    return json(null);
  }
  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/auth/login" && request.method === "POST") return login(request, env);
    if (pathname.startsWith("/push/")) return push(request, env, pathname);
    if (pathname.startsWith("/api/")) return relay(request, env);
    return env.ASSETS.fetch(request);
  },
};
