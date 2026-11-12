//! Phone dashboard: what the session daemon offers a phone, so the deck's agents can be watched and
//! answered without a remote desktop. The page lives on a Cloudflare Worker (`cloud/`), which asks
//! for a password once a day and relays `/api/*` here over Workers VPC: a named Cloudflare Tunnel the
//! daemon runs, with no public hostname, no domain and no open port. The daemon listens on loopback
//! only and every API call must carry the dashboard token, which only the Worker knows. The daemon
//! also serves the page on loopback for checking it on this PC.
use crate::daemon::Hub;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

pub const DEFAULT_PORT: u16 = 7781;
const COOKIE: &str = "mygdeck_k";
const MAX_BODY: usize = 64 * 1024;

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Conf {
    pub port: u16,
    pub token: String,
    /// The address the phone opens (the Worker, `https://mygdeck.<account>.workers.dev`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay: Option<String>,
    /// Run token of the named tunnel `mygdeck` (secret; `mygdeck-cli mobile tunnel-token` sets it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tunnel_token: Option<String>,
}

fn conf_path() -> PathBuf {
    crate::daemon::dir().join("mobile.json")
}

/// The dashboard is on exactly when this file exists.
pub fn read_conf() -> Option<Conf> {
    serde_json::from_str(&std::fs::read_to_string(conf_path()).ok()?).ok()
}

/// Turn the dashboard on, keeping the existing token so the Worker's copy (`DASH_TOKEN`) stays valid.
pub fn enable(port: Option<u16>, relay: Option<String>, tunnel_token: Option<String>) -> Result<Conf, String> {
    let mut conf = match read_conf() {
        Some(c) => c,
        None => Conf { port: DEFAULT_PORT, token: new_token()?, relay: None, tunnel_token: None },
    };
    if let Some(p) = port {
        conf.port = p;
    }
    if relay.is_some() {
        conf.relay = relay;
    }
    if tunnel_token.is_some() {
        conf.tunnel_token = tunnel_token;
    }
    std::fs::create_dir_all(crate::daemon::dir()).map_err(|e| e.to_string())?;
    std::fs::write(conf_path(), serde_json::to_string_pretty(&conf).unwrap_or_default()).map_err(|e| e.to_string())?;
    Ok(conf)
}

/// Turn it off. The token goes with it: turning it on again needs the Worker's `DASH_TOKEN` set again.
pub fn disable() {
    let _ = std::fs::remove_file(conf_path());
}

// ---- Opening the deck from the phone ----

#[derive(Serialize, Deserialize)]
struct AppLaunch {
    exe: PathBuf,
    cwd: PathBuf,
}

fn app_path() -> PathBuf {
    crate::daemon::dir().join("app.json")
}

/// Called by each deck window at start: how to open the deck again (same program, same folder, so
/// the same `mygdeck.json` and projects).
pub fn remember_app() {
    let (Ok(exe), Ok(cwd)) = (std::env::current_exe(), std::env::current_dir()) else { return };
    let _ = std::fs::create_dir_all(crate::daemon::dir());
    let _ = std::fs::write(app_path(), serde_json::to_string(&AppLaunch { exe, cwd }).unwrap_or_default());
}

static LAST_OPEN: Mutex<Option<std::time::Instant>> = Mutex::new(None);

/// Open the deck window on the PC unless one is open (or was just opened). Ok(true): launched.
fn open_app(hub: &Hub) -> Result<bool, String> {
    if hub.window_open() {
        return Ok(false);
    }
    let mut last = LAST_OPEN.lock().unwrap();
    if last.is_some_and(|t| t.elapsed() < Duration::from_secs(60)) {
        return Ok(false); // still starting: a window takes a few seconds to attach
    }
    let app: AppLaunch = std::fs::read_to_string(app_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .ok_or("PC에서 MYG Deck을 한 번 열어 두어야 원격으로 열 수 있습니다")?;
    let mut child = Command::new(&app.exe).current_dir(&app.cwd).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e| format!("MYG Deck을 열지 못했습니다: {e}"))?;
    // A window that closes on its own right away leaves a trace for `mygdeck-cli mobile` users.
    thread::spawn(move || {
        let started = std::time::Instant::now();
        let status = child.wait();
        if started.elapsed() < Duration::from_secs(30) {
            let log = crate::daemon::dir().join("logs");
            let _ = std::fs::create_dir_all(&log);
            let _ = std::fs::write(log.join("open-app.log"), format!("{:?} after {:?}: {}\n", status, started.elapsed(), app.exe.display()));
        }
    });
    *last = Some(std::time::Instant::now());
    Ok(true)
}

/// Start the daemon at login while the dashboard is on, so the phone can reach the PC (and open the
/// deck) before anyone opens it. `exe` is the deck program, which takes `--start-daemon`.
pub fn autostart(exe: Option<&std::path::Path>) -> Result<(), String> {
    #[cfg(windows)]
    {
        const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
        let mut c = Command::new("reg");
        match exe {
            Some(exe) => c.args(["add", KEY, "/v", "mygdeck", "/t", "REG_SZ", "/d", &format!("\"{}\" --start-daemon", exe.display()), "/f"]),
            None => c.args(["delete", KEY, "/v", "mygdeck", "/f"]),
        };
        let out = c.output().map_err(|e| e.to_string())?;
        if exe.is_some() && !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
    }
    #[cfg(target_os = "macos")]
    {
        let plist = crate::config::home().join("Library/LaunchAgents/com.mygdeck.daemon.plist");
        match exe {
            Some(exe) => {
                let _ = std::fs::create_dir_all(plist.parent().unwrap_or(&plist));
                let body = format!(
                    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n<key>Label</key><string>com.mygdeck.daemon</string>\n<key>ProgramArguments</key><array><string>{}</string><string>--start-daemon</string></array>\n<key>RunAtLoad</key><true/>\n</dict></plist>\n",
                    exe.display()
                );
                std::fs::write(&plist, body).map_err(|e| e.to_string())?;
            }
            None => {
                let _ = std::fs::remove_file(&plist);
            }
        }
    }
    let _ = exe;
    Ok(())
}

fn new_token() -> Result<String, String> {
    // This token guards a port the tunnel exposes to the internet: OS randomness.
    let mut b = [0u8; 20];
    getrandom::getrandom(&mut b).map_err(|e| e.to_string())?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

/// A started listener and its tunnel; `stop` ends both.
pub struct Running {
    conf: Conf,
    stop: Arc<AtomicBool>,
    tunnel: Arc<Tunnel>,
}

#[derive(Default)]
struct Tunnel {
    status: Mutex<String>,
    child: Mutex<Option<Child>>,
}

impl Tunnel {
    fn set(&self, s: impl Into<String>) {
        *self.status.lock().unwrap() = s.into();
    }
}

fn stop(r: &Running) {
    r.stop.store(true, Ordering::SeqCst);
    if let Some(mut c) = r.tunnel.child.lock().unwrap().take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    // Wake the blocking accept so the listener thread sees the flag and frees the port.
    let _ = TcpStream::connect_timeout(&([127, 0, 0, 1], r.conf.port).into(), Duration::from_millis(300));
}

/// Daemon exit: end the tunnel with it, or cloudflared would outlive the daemon.
pub fn shutdown(hub: &Arc<Hub>) {
    if let Some(r) = hub.mobile.lock().unwrap().take() {
        stop(&r);
    }
}

fn state(r: &Running) -> Value {
    json!({ "port": r.conf.port, "tunnel": *r.tunnel.status.lock().unwrap() })
}

/// Match the daemon's listener and tunnel to `mobile.json`: start, restart on change, or stop.
pub fn apply(hub: &Arc<Hub>) -> Result<Value, String> {
    let want = read_conf();
    let mut cur = hub.mobile.lock().unwrap();
    if let Some(r) = cur.as_ref() {
        if want.as_ref() == Some(&r.conf) {
            return Ok(state(r));
        }
        stop(r);
        *cur = None;
        thread::sleep(Duration::from_millis(100));
    }
    let Some(conf) = want else { return Ok(Value::Null) };
    let listener = TcpListener::bind(("127.0.0.1", conf.port)).map_err(|e| format!("포트 {}을(를) 열지 못했습니다: {e}", conf.port))?;
    let flag = Arc::new(AtomicBool::new(false));
    let (h, f, token) = (hub.clone(), flag.clone(), Arc::new(conf.token.clone()));
    thread::spawn(move || {
        for stream in listener.incoming() {
            if f.load(Ordering::SeqCst) {
                break;
            }
            let Ok(stream) = stream else { continue };
            let (h, token) = (h.clone(), token.clone());
            thread::spawn(move || handle(&h, &token, stream));
        }
    });
    let tunnel = Arc::new(Tunnel::default());
    match &conf.tunnel_token {
        Some(tt) => {
            let (t, f, tt) = (tunnel.clone(), flag.clone(), tt.clone());
            thread::spawn(move || run_tunnel(&t, &f, &tt));
        }
        None => tunnel.set("터널 꺼짐 (터널 토큰 없음, docs/mobile.md)"),
    }
    let r = Running { conf, stop: flag, tunnel };
    let out = state(&r);
    *cur = Some(r);
    Ok(out)
}

// ---- Cloudflare named tunnel ----

fn cloudflared() -> Command {
    let candidates: &[&str] = if cfg!(windows) {
        &[r"C:\Program Files (x86)\cloudflared\cloudflared.exe", r"C:\Program Files\cloudflared\cloudflared.exe"]
    } else {
        &["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"]
    };
    // The daemon may predate the install, so its PATH may not have it yet.
    let exe = candidates.iter().find(|p| std::path::Path::new(p).is_file()).copied().unwrap_or("cloudflared");
    let mut c = Command::new(exe);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: the daemon has no console to share
    }
    c
}

/// Sleep `secs` unless the dashboard is turned off first; false when it was.
fn nap(stop: &AtomicBool, secs: u64) -> bool {
    for _ in 0..secs {
        if stop.load(Ordering::SeqCst) {
            return false;
        }
        thread::sleep(Duration::from_secs(1));
    }
    !stop.load(Ordering::SeqCst)
}

/// Keep the named tunnel connected while the dashboard is on. The Worker reaches this PC through it
/// (Workers VPC), so the tunnel needs no public hostname. Failed starts back off up to 5 minutes.
fn run_tunnel(t: &Arc<Tunnel>, stop: &AtomicBool, tunnel_token: &str) {
    let mut wait = 10;
    while !stop.load(Ordering::SeqCst) {
        t.set("터널 연결 중");
        let started = std::time::Instant::now();
        // The token goes in the environment, not the command line other processes can read.
        let spawned = cloudflared()
            .args(["tunnel", "--no-autoupdate", "run"])
            .env("TUNNEL_TOKEN", tunnel_token)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn();
        let mut child = match spawned {
            Ok(c) => c,
            Err(e) => {
                t.set(format!("cloudflared를 실행하지 못했습니다 ({e}). 설치: winget install --id Cloudflare.cloudflared"));
                if !nap(stop, 60) {
                    return;
                }
                continue;
            }
        };
        let Some(err) = child.stderr.take() else { return };
        *t.child.lock().unwrap() = Some(child);
        if stop.load(Ordering::SeqCst) {
            if let Some(mut c) = t.child.lock().unwrap().take() {
                let _ = c.kill();
            }
            return;
        }
        let mut connected = false;
        let mut last_error = String::new();
        // cloudflared logs to stderr; read all of it (a full pipe would stall it).
        for line in BufReader::new(err).lines().map_while(Result::ok) {
            if line.contains("Registered tunnel connection") {
                if !connected {
                    t.set("연결됨");
                }
                connected = true;
            } else if line.contains(" ERR ") || line.starts_with("failed") {
                last_error = line.chars().take(200).collect();
            }
        }
        if let Some(mut c) = t.child.lock().unwrap().take() {
            let _ = c.wait();
        }
        if stop.load(Ordering::SeqCst) {
            return;
        }
        // A tunnel that ran for a while just dropped: retry soon. Repeated failures wait longer.
        wait = if connected && started.elapsed() > Duration::from_secs(120) { 10 } else { (wait * 2).min(300) };
        let why = if last_error.is_empty() { "터널이 끊겼습니다".to_string() } else { last_error };
        t.set(format!("{why} · {wait}초 뒤 다시 연결"));
        if !nap(stop, wait) {
            return;
        }
    }
}

// ---- HTTP ----

struct Req {
    method: String,
    path: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

impl Req {
    fn cookie(&self, name: &str) -> Option<&str> {
        self.headers.get("cookie")?.split(';').find_map(|kv| kv.trim().strip_prefix(name)?.strip_prefix('='))
    }
}

pub fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => {
                match u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("zz"), 16) {
                    Ok(v) => {
                        out.push(v);
                        i += 2;
                    }
                    Err(_) => out.push(b'%'),
                }
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn read_req(stream: &TcpStream) -> Option<Req> {
    let mut r = BufReader::new(stream.try_clone().ok()?);
    let mut first = String::new();
    r.read_line(&mut first).ok()?;
    let mut parts = first.split_whitespace();
    let (method, target) = (parts.next()?.to_string(), parts.next()?.to_string());
    let mut headers = HashMap::new();
    let mut total = first.len();
    loop {
        let mut l = String::new();
        if r.read_line(&mut l).ok()? == 0 {
            return None;
        }
        total += l.len();
        if total > 16 * 1024 {
            return None;
        }
        let l = l.trim_end();
        if l.is_empty() {
            break;
        }
        if let Some((k, v)) = l.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    let len: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    if len > MAX_BODY {
        return None;
    }
    let mut body = vec![0; len];
    r.read_exact(&mut body).ok()?;
    let (path, qs) = target.split_once('?').unwrap_or((&target, ""));
    let query = qs.split('&').filter_map(|kv| kv.split_once('=')).map(|(k, v)| (pct_decode(k), pct_decode(v))).collect();
    Some(Req { method, path: path.to_string(), query, headers, body })
}

fn respond(mut s: &TcpStream, status: &str, ctype: &str, extra: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n{extra}\r\n",
        body.len()
    );
    let _ = s.write_all(head.as_bytes());
    let _ = s.write_all(body);
}

fn json_reply(s: &TcpStream, v: Result<Value, (&str, String)>) {
    match v {
        Ok(v) => respond(s, "200 OK", "application/json; charset=utf-8", "Cache-Control: no-store\r\n", v.to_string().as_bytes()),
        Err((status, msg)) => respond(s, status, "application/json; charset=utf-8", "Cache-Control: no-store\r\n", json!({ "error": msg }).to_string().as_bytes()),
    }
}

fn ct_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

struct Asset {
    path: &'static str,
    ctype: &'static str,
    body: &'static [u8],
}

const ASSETS: &[Asset] = &[
    Asset { path: "/", ctype: "text/html; charset=utf-8", body: include_bytes!("../../src/mobile/index.html") },
    Asset { path: "/app.js", ctype: "text/javascript; charset=utf-8", body: include_bytes!("../../src/mobile/app.js") },
    Asset { path: "/app.css", ctype: "text/css; charset=utf-8", body: include_bytes!("../../src/mobile/app.css") },
    Asset { path: "/logic.js", ctype: "text/javascript; charset=utf-8", body: include_bytes!("../../src/logic.js") },
    Asset { path: "/xterm.js", ctype: "text/javascript; charset=utf-8", body: include_bytes!("../../node_modules/@xterm/xterm/lib/xterm.js") },
    Asset { path: "/manifest.webmanifest", ctype: "application/manifest+json", body: include_bytes!("../../src/mobile/manifest.webmanifest") },
    Asset { path: "/icon.png", ctype: "image/png", body: include_bytes!("../icons/128x128@2x.png") },
];

fn etag(body: &[u8]) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    body.hash(&mut h);
    format!("\"{:016x}\"", h.finish())
}

fn handle(hub: &Arc<Hub>, token: &str, stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let Some(req) = read_req(&stream) else { return };
    let s = &stream;

    // The link from `mygdeck-cli mobile` carries the token once; keep it as a cookie and drop it
    // from the address bar. Lax, not Strict: the link is usually opened from another app.
    if req.method == "GET" && req.path == "/" {
        if let Some(k) = req.query.get("k") {
            if ct_eq(k, token) {
                let cookie = format!("Set-Cookie: {COOKIE}={token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax\r\nLocation: /\r\n");
                return respond(s, "303 See Other", "text/plain", &cookie, b"");
            }
        }
    }
    if req.method == "GET" {
        if let Some(a) = ASSETS.iter().find(|a| a.path == req.path) {
            let tag = etag(a.body);
            if req.headers.get("if-none-match") == Some(&tag) {
                return respond(s, "304 Not Modified", a.ctype, &format!("ETag: {tag}\r\n"), b"");
            }
            return respond(s, "200 OK", a.ctype, &format!("ETag: {tag}\r\nCache-Control: no-cache\r\n"), a.body);
        }
    }
    if !req.path.starts_with("/api/") {
        return respond(s, "404 Not Found", "text/plain", "", b"not found");
    }
    if !req.cookie(COOKIE).is_some_and(|k| ct_eq(k, token)) {
        return json_reply(s, Err(("401 Unauthorized", "unauthorized".into())));
    }
    // Writes need a header a cross-site form cannot send.
    if req.method == "POST" && req.headers.get("x-mygdeck").map(String::as_str) != Some("1") {
        return json_reply(s, Err(("403 Forbidden", "missing header".into())));
    }
    let q = |k: &str| req.query.get(k).cloned().unwrap_or_default();
    let body: Value = serde_json::from_slice(&req.body).unwrap_or(Value::Null);
    let agent = |id: &str| -> Result<String, (&str, String)> {
        if id.contains("#agent|") && hub.list().as_array().is_some_and(|l| l.iter().any(|v| v["id"] == id)) {
            Ok(id.to_string())
        } else {
            Err(("404 Not Found", "세션이 끝났습니다".into()))
        }
    };
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/api/list") => json_reply(s, Ok(agents(&hub.list()))),
        ("GET", "/api/turn") => json_reply(
            s,
            agent(&q("id")).and_then(|id| {
                let path = hub.transcript(&id).ok_or(("404 Not Found", "대화 기록이 없습니다".to_string()))?;
                let turn = crate::turn::read_turn(path).map_err(|e| ("500 Internal Server Error", e))?;
                Ok(serde_json::to_value(turn).unwrap_or(Value::Null))
            }),
        ),
        // New output since an offset: the phone polls (a relay need not carry event streams).
        ("GET", "/api/screen") => json_reply(
            s,
            agent(&q("id")).and_then(|id| hub.output_since(&id, q("from").parse().unwrap_or(0)).map_err(|e| ("404 Not Found", e))),
        ),
        ("GET", "/api/status") => json_reply(s, Ok(json!({ "window": hub.window_open() }))),
        // The phone found no deck window: open it on the PC (its projects and agents come back).
        ("POST", "/api/open") => json_reply(s, open_app(hub).map(|opened| json!({ "opened": opened })).map_err(|e| ("409 Conflict", e))),
        ("POST", "/api/send") => {
            let text = body["text"].as_str().unwrap_or("");
            json_reply(
                s,
                agent(body["id"].as_str().unwrap_or("")).and_then(|id| {
                    if text.trim().is_empty() {
                        return Err(("400 Bad Request", "빈 메시지".into()));
                    }
                    hub.send_to(&id, text).map(|_| Value::Null).map_err(|e| ("409 Conflict", e))
                }),
            )
        }
        // Menu answers and Esc: a few short key sequences, typed one by one like the deck's buttons.
        ("POST", "/api/keys") => {
            let keys: Vec<String> = body["keys"].as_array().into_iter().flatten().filter_map(|k| k.as_str().map(String::from)).collect();
            json_reply(
                s,
                agent(body["id"].as_str().unwrap_or("")).and_then(|id| {
                    if keys.is_empty() || keys.len() > 20 || keys.iter().any(|k| k.is_empty() || k.len() > 8) {
                        return Err(("400 Bad Request", "잘못된 키".into()));
                    }
                    for (i, k) in keys.iter().enumerate() {
                        if i > 0 {
                            thread::sleep(Duration::from_millis(60));
                        }
                        hub.write(&id, k.as_bytes()).map_err(|e| ("409 Conflict", e))?;
                    }
                    Ok(Value::Null)
                }),
            )
        }
        _ => json_reply(s, Err(("404 Not Found", "not found".into()))),
    }
}

/// Agent sessions only, with what the page needs. Shells stay on the PC.
pub fn agents(list: &Value) -> Value {
    let rows = list.as_array().into_iter().flatten().filter(|v| v["id"].as_str().is_some_and(|id| id.contains("#agent|")));
    Value::Array(
        rows.map(|v| {
            json!({
                "id": v["id"], "cwd": v["cwd"], "status": v["status"], "text": v["text"], "tool": v["tool"],
                "idle_secs": v["idle_secs"], "hooked": v["hooked"], "cols": v["cols"], "rows": v["rows"],
                "has_turn": v["transcript"].is_string(),
            })
        })
        .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_query_and_compares_tokens() {
        assert_eq!(pct_decode("C%3A%2Fw%2Fa%23agent%7Cx+y"), "C:/w/a#agent|x y");
        assert_eq!(pct_decode("%ED%95%9C"), "한");
        assert_eq!(pct_decode("100%"), "100%");
        assert_eq!(pct_decode("%zz"), "%zz");
        assert!(ct_eq("abc", "abc") && !ct_eq("abc", "abd") && !ct_eq("abc", "ab"));
    }

    #[test]
    fn lists_agents_only() {
        let list = json!([
            { "id": "C:/w/a#agent|1", "cwd": "C:/w/a", "status": "working", "transcript": "x.jsonl" },
            { "id": "C:/w/a#shell|2", "cwd": "C:/w/a", "status": "idle" },
        ]);
        let a = agents(&list);
        assert_eq!(a.as_array().unwrap().len(), 1);
        assert_eq!(a[0]["has_turn"], true);
    }

    fn get(port: u16, path: &str, cookie: &str) -> String {
        let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(c, "GET {path} HTTP/1.1\r\nHost: x\r\nCookie: {cookie}\r\n\r\n").unwrap();
        let mut out = String::new();
        let _ = c.read_to_string(&mut out);
        out
    }

    #[test]
    fn serves_page_and_guards_the_api() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let hub = crate::daemon::start(listener, "t".into());
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let (h, token) = (hub.clone(), "secret".to_string());
        let l = TcpListener::bind(("127.0.0.1", port)).unwrap();
        thread::spawn(move || {
            for st in l.incoming().flatten() {
                let (h, t) = (h.clone(), token.clone());
                thread::spawn(move || handle(&h, &t, st));
            }
        });
        assert!(get(port, "/", "").starts_with("HTTP/1.1 200"));
        assert!(get(port, "/api/list", "").starts_with("HTTP/1.1 401"));
        assert!(get(port, "/api/list", "mygdeck_k=wrong").starts_with("HTTP/1.1 401"));
        let login = get(port, "/?k=secret", "");
        assert!(login.starts_with("HTTP/1.1 303") && login.contains("Set-Cookie: mygdeck_k=secret"), "{login}");
        let list = get(port, "/api/list", "a=b; mygdeck_k=secret");
        assert!(list.starts_with("HTTP/1.1 200") && list.ends_with("[]"), "{list}");
        assert!(get(port, "/api/screen?id=nope", "mygdeck_k=secret").starts_with("HTTP/1.1 404"));
    }
}
