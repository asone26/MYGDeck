// Phone dashboard relay (Cloudflare Worker): serves the page from ./public, asks for a password once a
// day, and forwards /api/* to the PC's session daemon over Workers VPC: a named Cloudflare Tunnel
// that the daemon runs, with no public hostname and no domain. The phone never holds the dashboard
// token; this Worker adds it.
//
// Secrets (wrangler secret put): DASH_PASSWORD, SESSION_SECRET, DASH_TOKEN (= token in ~/.mygdeck/mobile.json).
// Bindings (wrangler.toml): ASSETS, DECK (KV: failed logins), PC (VPC service → 127.0.0.1:7781).
import { DAY, SESSION_COOKIE, json, makeSession, safeEqual, validSession } from "./lib/auth.js";

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

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/auth/login" && request.method === "POST") return login(request, env);
    if (pathname.startsWith("/api/")) return relay(request, env);
    return env.ASSETS.fetch(request);
  },
};
