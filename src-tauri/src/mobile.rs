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
use std::path::{Path, PathBuf};
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
        // Folders to add a project from: under the home folder or next to projects the deck knows.
        ("GET", "/api/dirs") => json_reply(s, list_dirs(hub, &q("path")).map_err(|e| ("404 Not Found", e))),
        ("POST", "/api/add") => json_reply(s, add_project(hub, body["path"].as_str().unwrap_or("")).map(|_| Value::Null).map_err(|e| ("409 Conflict", e))),
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

// ---- Adding a project from the phone ----

/// Where the phone may browse: the home folder and the parents of known projects.
fn roots(hub: &Hub) -> Vec<PathBuf> {
    let mut paths = crate::config::saved_paths();
    paths.extend(hub.list().as_array().into_iter().flatten().filter_map(|v| v["cwd"].as_str().map(String::from)));
    let mut out = vec![crate::config::home()];
    out.extend(paths.iter().filter_map(|p| Path::new(p).parent().map(Path::to_path_buf)));
    let mut seen = Vec::new();
    out.retain(|r| {
        let Some(key) = r.canonicalize().ok().filter(|_| r.is_dir()) else { return false };
        let fresh = !seen.contains(&key);
        seen.push(key);
        fresh
    });
    out
}

/// The root that holds `path` (itself or above it), compared after resolving `..` and links.
fn root_of(path: &Path, roots: &[PathBuf]) -> Option<PathBuf> {
    let real = path.canonicalize().ok()?;
    roots.iter().filter_map(|r| r.canonicalize().ok()).filter(|r| real.starts_with(r)).max_by_key(|r| r.as_os_str().len())
}

const PROJECT_MARKS: &[&str] = &[".git", "package.json", "Cargo.toml", "pyproject.toml", "go.mod", "CLAUDE.md", "AGENTS.md", "master.md"];
const SKIP_DIRS: &[&str] = &["node_modules", "target", "dist", "build", "AppData", "Library", "Applications"];

fn hidden(e: &std::fs::DirEntry) -> bool {
    let name = e.file_name().to_string_lossy().into_owned();
    if name.starts_with('.') || name.starts_with('$') || SKIP_DIRS.contains(&name.as_str()) {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if e.metadata().is_ok_and(|m| m.file_attributes() & 0x6 != 0) {
            return true; // hidden or system
        }
    }
    false
}

fn dir_row(path: &Path, name: String) -> Value {
    json!({ "name": name, "path": path.to_string_lossy(), "project": PROJECT_MARKS.iter().any(|m| path.join(m).exists()) })
}

fn list_dirs(hub: &Hub, path: &str) -> Result<Value, String> {
    let roots = roots(hub);
    if path.is_empty() {
        let dirs: Vec<Value> = roots
            .iter()
            .map(|r| dir_row(r, r.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| r.to_string_lossy().into_owned())))
            .collect();
        return Ok(json!({ "path": "", "parent": null, "dirs": dirs }));
    }
    let dir = PathBuf::from(path);
    let root = root_of(&dir, &roots).ok_or("이 폴더는 열 수 없습니다")?;
    let at_root = dir.canonicalize().is_ok_and(|d| d == root);
    let parent = if at_root { None } else { dir.parent().map(|p| p.to_string_lossy().into_owned()) };
    let mut dirs: Vec<(String, PathBuf)> = std::fs::read_dir(&dir)
        .map_err(|e| format!("폴더를 읽지 못했습니다: {e}"))?
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()) && !hidden(e))
        .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path()))
        .collect();
    dirs.sort_by_key(|(n, _)| n.to_lowercase());
    dirs.truncate(400);
    let dirs: Vec<Value> = dirs.into_iter().map(|(n, p)| dir_row(&p, n)).collect();
    Ok(json!({ "path": dir.to_string_lossy(), "parent": parent, "dirs": dirs }))
}

/// The deck window adds the card (as its own + button does), so the project is saved with the deck.
fn add_project(hub: &Hub, path: &str) -> Result<(), String> {
    let dir = PathBuf::from(path);
    if path.is_empty() || !dir.is_dir() || root_of(&dir, &roots(hub)).is_none() {
        return Err("이 폴더로는 프로젝트를 시작할 수 없습니다".into());
    }
    if !hub.window_open() {
        return Err("PC에서 MYG Deck 창이 열려 있지 않습니다. 잠시 뒤 다시 시도하세요".into());
    }
    hub.broadcast(json!({ "ev": "add-project", "path": path }));
    Ok(())
}

// ---- Push: tell the phone when an agent needs it ----

pub struct Note {
    title: String,
    body: String,
    tag: String,
    url: String,
    urgent: bool,
}

fn pct_encode(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

fn clip(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n - 1).collect::<String>() + "…"
    }
}

/// What a status change says on the phone: a question (urgent) or a finished turn (quiet).
pub fn note(id: &str, cwd: &str, before: &str, after: &str, text: &str, tool: &Value) -> Option<Note> {
    if !id.contains("#agent|") || before == after {
        return None;
    }
    let name = Path::new(cwd).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| cwd.to_string());
    let (title, body, urgent) = match after {
        "waiting" => (format!("{name} · 응답 필요"), waiting_text(text, tool), true),
        "done" if before == "working" => (format!("{name} · 완료"), "다음 지시를 기다립니다".to_string(), false),
        _ => return None,
    };
    Some(Note { title, body: clip(&body, 160), tag: id.to_string(), url: format!("/#{}", pct_encode(id)), urgent })
}

fn waiting_text(msg: &str, tool: &Value) -> String {
    let lower = msg.to_lowercase();
    if lower.contains("permission") {
        let t = tool["tool"].as_str().unwrap_or("");
        if !t.is_empty() {
            return format!("허용 요청: {t} {}", tool["detail"].as_str().unwrap_or("")).trim_end().to_string();
        }
        if let Some(rest) = lower.find("permission to use ").and_then(|i| msg.get(i + 18..)) {
            return format!("{} 사용 허용을 기다립니다", rest.trim_end_matches('.'));
        }
    }
    if lower.contains("waiting for your input") || msg.is_empty() {
        return "다음 지시를 기다립니다".into();
    }
    msg.to_string()
}

/// Ask the relay to push `n` to the subscribed phones. Off the caller's thread; failures are dropped.
pub fn notify(hub: &Hub, n: Note) {
    let target = hub.mobile.lock().unwrap().as_ref().and_then(|r| r.conf.relay.clone().map(|u| (u, r.conf.token.clone())));
    let Some((relay, token)) = target else { return };
    thread::spawn(move || {
        let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(Duration::from_secs(15))).build().into();
        let body = json!({ "title": n.title, "body": n.body, "tag": n.tag, "url": n.url, "urgent": n.urgent });
        let _ = agent.post(format!("{}/push/notify", relay.trim_end_matches('/'))).header("x-mygdeck-token", &token).send_json(body);
    });
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

    #[test]
    fn push_notes_on_questions_and_finished_turns() {
        let tool = json!({ "tool": "Bash", "detail": "npm test" });
        let n = note("C:/w/app#agent|1", "C:/w/app", "working", "waiting", "Claude needs your permission to use Bash", &tool).unwrap();
        assert_eq!(n.title, "app · 응답 필요");
        assert_eq!(n.body, "허용 요청: Bash npm test");
        assert!(n.urgent);
        assert_eq!(n.url, "/#C%3A%2Fw%2Fapp%23agent%7C1");
        assert_eq!(pct_decode(&n.url[2..]), "C:/w/app#agent|1");
        let d = note("C:/w/app#agent|1", "C:/w/app", "working", "done", "완료", &Value::Null).unwrap();
        assert!(!d.urgent && d.title == "app · 완료");
        assert!(note("C:/w/app#agent|1", "C:/w/app", "waiting", "waiting", "", &Value::Null).is_none());
        assert!(note("C:/w/app#agent|1", "C:/w/app", "starting", "done", "", &Value::Null).is_none());
        assert!(note("C:/w/app#shell|1", "C:/w/app", "working", "waiting", "", &Value::Null).is_none());
        assert_eq!(waiting_text("Claude is waiting for your input", &Value::Null), "다음 지시를 기다립니다");
        assert_eq!(waiting_text("Claude needs your permission to use Edit.", &Value::Null), "Edit 사용 허용을 기다립니다");
    }

    #[test]
    fn browses_only_under_the_roots() {
        let base = std::env::temp_dir().join(format!("mygdeck-dirs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("app/.git")).unwrap();
        std::fs::create_dir_all(base.join("notes")).unwrap();
        std::fs::create_dir_all(base.join(".cache")).unwrap();
        std::fs::create_dir_all(base.join("node_modules")).unwrap();
        let roots = vec![base.clone()];
        assert!(root_of(&base.join("app"), &roots).is_some());
        assert!(root_of(&base.join("app/../.."), &roots).is_none());
        assert!(root_of(&std::env::temp_dir(), &roots).is_none());
        let names: Vec<String> = std::fs::read_dir(&base).unwrap().flatten().filter(|e| !hidden(e)).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert!(names.contains(&"app".to_string()) && names.contains(&"notes".to_string()) && names.len() == 2, "{names:?}");
        assert_eq!(dir_row(&base.join("app"), "app".into())["project"], true);
        assert_eq!(dir_row(&base.join("notes"), "notes".into())["project"], false);
        let _ = std::fs::remove_dir_all(&base);
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
