//! Session daemon: owns every agent and shell PTY so sessions outlive the window (closing or
//! reloading the deck no longer kills running agents). The window, the agent hooks and
//! `mygdeck-cli` all reach it on one loopback port: hook lines are `id\tevent\tjson`; everything
//! else is newline-delimited JSON that starts with a token hello.
use crate::pty::{build_command, is_editor_var, Utf8Carry, INHERITED_SESSION_VARS};
use portable_pty::{native_pty_system, ChildKiller, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Bump when the wire format changes; a window never drives a daemon of another version.
pub const PROTO: u64 = 1;
/// Output kept per session for replay when a window reattaches.
const KEEP: usize = 256 * 1024;
/// With no session and no window, the daemon quits after this long.
const IDLE_EXIT: Duration = Duration::from_secs(30);

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Info {
    pub port: u16,
    pub token: String,
    pub pid: u32,
    pub proto: u64,
}

pub fn dir() -> PathBuf {
    crate::config::home().join(".mygdeck")
}

fn info_path() -> PathBuf {
    dir().join("daemon.json")
}

pub fn read_info() -> Option<Info> {
    serde_json::from_str(&std::fs::read_to_string(info_path()).ok()?).ok()
}

fn new_token() -> String {
    let mut out = String::new();
    for _ in 0..2 {
        // RandomState is seeded from the OS per instance: enough for a loopback-only token.
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

struct Session {
    cwd: String,
    command: String,
    started: u64,
    /// Terminal size the window last set, so a phone can lay out the same screen.
    cols: u16,
    rows: u16,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    buf: String,
    /// Bytes of output ever produced; `buf` holds the last `buf.len()` of them. A poller asks for
    /// output after an offset it saw before.
    total: u64,
    /// The CLI turned on bracketed paste, so multi-line text can be sent as one input.
    bracketed: bool,
    last_output: Instant,
    /// Status comes from hooks once the first hook arrives; before that, from output activity.
    hooked: bool,
    status: String,
    text: String,
    tool: Value,
    transcript: Value,
}

pub struct Hub {
    port: u16,
    token: String,
    sessions: Mutex<HashMap<String, Session>>,
    clients: Mutex<Vec<(u64, Sender<String>)>>,
    next_client: Mutex<u64>,
    stop: AtomicBool,
    /// The phone dashboard's listener, when `mygdeck-cli mobile on` enabled it.
    pub(crate) mobile: Mutex<Option<crate::mobile::Running>>,
}

/// Keep the tail of the output, cut at a line start so replay does not begin mid-sequence.
pub fn trim_buf(buf: &mut String, keep: usize) {
    if buf.len() <= keep + keep / 4 {
        return;
    }
    let mut cut = buf.len() - keep;
    while !buf.is_char_boundary(cut) {
        cut += 1;
    }
    let cut = buf[cut..].find('\n').map_or(cut, |i| cut + i + 1);
    buf.drain(..cut);
}

/// Last bracketed-paste switch in a chunk: Some(true) on, Some(false) off, None unchanged.
pub fn bracketed_switch(s: &str) -> Option<bool> {
    match (s.rfind("\x1b[?2004h"), s.rfind("\x1b[?2004l")) {
        (Some(on), Some(off)) => Some(on > off),
        (Some(_), None) => Some(true),
        (None, Some(_)) => Some(false),
        (None, None) => None,
    }
}

fn norm(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// A CLI target names a project by its folder name or its full path.
pub fn matches_target(cwd: &str, target: &str) -> bool {
    let (c, t) = (norm(cwd), norm(target));
    !t.is_empty() && (c == t || c.rsplit('/').next() == Some(t.as_str()))
}

/// The text the CLI sees when the user pastes `text` (Enter is sent separately).
pub fn paste_bytes(text: &str, bracketed: bool) -> String {
    if bracketed {
        format!("\x1b[200~{text}\x1b[201~")
    } else {
        text.replace("\r\n", "\r").replace('\n', "\r")
    }
}

fn line(v: Value) -> String {
    let mut s = v.to_string();
    s.push('\n');
    s
}

impl Hub {
    fn broadcast(&self, msg: Value) {
        let s = line(msg);
        for (_, tx) in self.clients.lock().unwrap().iter() {
            let _ = tx.send(s.clone());
        }
    }

    fn busy(&self) -> bool {
        // With the phone dashboard on, the daemon stays up: it holds the tunnel the phone comes in by.
        !self.sessions.lock().unwrap().is_empty() || !self.clients.lock().unwrap().is_empty() || self.mobile.lock().unwrap().is_some()
    }

    /// A deck window is attached (only windows hold the event stream).
    pub(crate) fn window_open(&self) -> bool {
        !self.clients.lock().unwrap().is_empty()
    }

    fn spawn(self: &Arc<Self>, id: &str, cwd: &str, argv: &[String], cols: u16, rows: u16) -> Result<(), String> {
        if id.is_empty() {
            return Err("empty session id".into());
        }
        if self.sessions.lock().unwrap().contains_key(id) {
            return Err(format!("session {id} already exists"));
        }
        let mut cmd = build_command(argv)?;
        cmd.cwd(cwd);
        for k in INHERITED_SESSION_VARS {
            cmd.env_remove(k);
        }
        // An agent started with an editor's environment connects to that editor and receives its
        // open file and selection. The deck never forwards open files (spec 1.4 ⑧).
        for (k, _) in std::env::vars() {
            if is_editor_var(&k) {
                cmd.env_remove(k);
            }
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("MYGDECK_ID", id);
        cmd.env("MYGDECK_PORT", self.port.to_string());

        let size = PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 };
        let pair = native_pty_system().openpty(size).map_err(|e| e.to_string())?;
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let killer = child.clone_killer();
        self.sessions.lock().unwrap().insert(
            id.to_string(),
            Session {
                cwd: cwd.to_string(),
                command: argv.join(" "),
                started: now_secs(),
                cols: size.cols,
                rows: size.rows,
                master: pair.master,
                writer,
                killer,
                buf: String::new(),
                total: 0,
                bracketed: false,
                last_output: Instant::now(),
                hooked: false,
                status: "starting".into(),
                text: String::new(),
                tool: Value::Null,
                transcript: Value::Null,
            },
        );
        let (hub, rid) = (self.clone(), id.to_string());
        thread::spawn(move || {
            let mut buf = [0u8; 16384];
            let mut dec = Utf8Carry::default();
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let s = dec.push(&buf[..n]);
                if !s.is_empty() {
                    hub.output(&rid, s);
                }
            }
        });
        let (hub, wid) = (self.clone(), id.to_string());
        thread::spawn(move || {
            let code = child.wait().ok().map(|s| s.exit_code());
            // Dropping the master closes the pseudo console, which ends the reader thread.
            let mut map = hub.sessions.lock().unwrap();
            map.remove(&wid);
            hub.broadcast(json!({ "ev": "exit", "id": wid, "code": code }));
        });
        Ok(())
    }

    /// Buffer and broadcast under the session lock, so an attach replay never overlaps live data.
    fn output(&self, id: &str, s: String) {
        let mut map = self.sessions.lock().unwrap();
        let Some(x) = map.get_mut(id) else { return };
        x.buf.push_str(&s);
        x.total += s.len() as u64;
        trim_buf(&mut x.buf, KEEP);
        if let Some(b) = bracketed_switch(&s) {
            x.bracketed = b;
        }
        x.last_output = Instant::now();
        self.broadcast(json!({ "ev": "data", "id": id, "data": s }));
    }

    fn on_hook(&self, ev: crate::hooks::HookEvent) {
        let mut map = self.sessions.lock().unwrap();
        if let Some(x) = map.get_mut(&ev.id) {
            x.hooked = true;
            if ev.data["transcript"].is_string() {
                x.transcript = ev.data["transcript"].clone();
            }
            let msg = ev.data["message"].as_str().unwrap_or("");
            match ev.event.as_str() {
                "prompt" => (x.status, x.text) = ("working".into(), "작업 중".into()),
                "tool" => {
                    x.status = "working".into();
                    x.text = format!("{} {}", ev.data["tool"].as_str().unwrap_or(""), ev.data["detail"].as_str().unwrap_or("")).trim().into();
                    x.tool = ev.data.clone();
                }
                // An idle reminder after the turn ended is not a new request for the user.
                "notify" if !(x.status == "done" && !msg.to_lowercase().contains("permission")) => {
                    (x.status, x.text) = ("waiting".into(), msg.into());
                }
                "stop" => (x.status, x.text) = ("done".into(), "완료".into()),
                _ => {}
            }
        }
        self.broadcast(json!({ "ev": "hook", "id": ev.id, "event": ev.event, "data": ev.data }));
    }

    pub(crate) fn list(&self) -> Value {
        let map = self.sessions.lock().unwrap();
        let mut out: Vec<Value> = map
            .iter()
            .map(|(id, x)| {
                let status = if x.hooked {
                    x.status.clone()
                } else if x.last_output.elapsed() < Duration::from_secs(3) {
                    "working".into()
                } else {
                    "idle".into()
                };
                json!({
                    "id": id, "cwd": x.cwd, "command": x.command, "started": x.started,
                    "status": status, "text": x.text, "tool": x.tool, "transcript": x.transcript,
                    "idle_secs": x.last_output.elapsed().as_secs(),
                    "hooked": x.hooked, "cols": x.cols, "rows": x.rows,
                })
            })
            .collect();
        out.sort_by_key(|v| v["started"].as_u64());
        Value::Array(out)
    }

    fn with<T>(&self, id: &str, f: impl FnOnce(&mut Session) -> Result<T, String>) -> Result<T, String> {
        let mut map = self.sessions.lock().unwrap();
        f(map.get_mut(id).ok_or("session closed")?)
    }

    pub(crate) fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        self.with(id, |x| {
            x.writer.write_all(data).map_err(|e| e.to_string())?;
            x.writer.flush().map_err(|e| e.to_string())
        })
    }

    /// Transcript file the agent's hooks reported, if any.
    pub(crate) fn transcript(&self, id: &str) -> Option<String> {
        self.sessions.lock().unwrap().get(id)?.transcript.as_str().map(String::from)
    }

    /// Output after byte offset `from`, for pollers that cannot hold a stream open. When `from` is
    /// older than the kept buffer (or 0), the whole buffer comes back with `reset: true`.
    pub(crate) fn output_since(&self, id: &str, from: u64) -> Result<Value, String> {
        self.with(id, |x| {
            let start = x.total - x.buf.len() as u64;
            let (data, reset) = if from < start || from > x.total || from == 0 {
                (x.buf.as_str(), true)
            } else {
                let at = (from - start) as usize;
                // Offsets come from earlier replies, which end on whole chunks; guard anyway.
                (x.buf.get(at..).unwrap_or(x.buf.as_str()), !x.buf.is_char_boundary(at))
            };
            Ok(json!({ "data": data, "next": x.total, "reset": reset }))
        })
    }

    /// Paste `text` into a session, then press Enter. Refused while a hooked agent shows a
    /// permission menu: the text would pick one of its options.
    pub(crate) fn send_to(self: &Arc<Self>, id: &str, text: &str) -> Result<(), String> {
        let bracketed = self.with(id, |x| {
            if x.hooked && x.status == "waiting" {
                return Err("에이전트가 승인을 기다립니다. 먼저 선택지에 답하세요".to_string());
            }
            Ok(x.bracketed)
        })?;
        self.write(id, paste_bytes(text, bracketed).as_bytes())?;
        let (hub, eid) = (self.clone(), id.to_string());
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(80));
            let _ = hub.write(&eid, b"\r");
        });
        Ok(())
    }

    /// Type text into an agent CLI as a paste, then press Enter (for `mygdeck-cli send`).
    fn send_text(self: &Arc<Self>, target: &str, text: &str) -> Result<Value, String> {
        let id = {
            let map = self.sessions.lock().unwrap();
            let hits: Vec<(&String, &Session)> = map.iter().filter(|(id, x)| id.contains("#agent|") && matches_target(&x.cwd, target)).collect();
            match hits.as_slice() {
                [] => return Err(format!("'{target}' 프로젝트에서 실행 중인 에이전트가 없습니다")),
                [(id, _)] => (*id).clone(),
                _ => return Err(format!("'{target}'에 해당하는 프로젝트가 여럿입니다. 전체 경로로 지정하세요")),
            }
        };
        self.send_to(&id, text).map_err(|e| format!("'{target}': {e}"))?;
        Ok(json!({ "id": id }))
    }

    fn dispatch(self: &Arc<Self>, req: &Value, tx: &Sender<String>) -> Result<Value, String> {
        let s = |k: &str| req[k].as_str().unwrap_or("").to_string();
        let n = |k: &str| req[k].as_u64().unwrap_or(0).min(u16::MAX as u64) as u16;
        let id = s("id");
        match req["op"].as_str().unwrap_or("") {
            "spawn" => {
                let argv: Vec<String> = req["argv"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(String::from)).collect();
                self.spawn(&id, &s("cwd"), &argv, n("cols"), n("rows")).map(|_| Value::Null)
            }
            "write" => self.write(&id, s("data").as_bytes()).map(|_| Value::Null),
            "resize" => self.with(&id, |x| {
                let size = PtySize { rows: n("rows").max(2), cols: n("cols").max(10), pixel_width: 0, pixel_height: 0 };
                (x.cols, x.rows) = (size.cols, size.rows);
                x.master.resize(size).map_err(|e| e.to_string()).map(|_| Value::Null)
            }),
            "kill" => {
                if let Some(x) = self.sessions.lock().unwrap().get_mut(&id) {
                    let _ = x.killer.kill();
                }
                Ok(Value::Null)
            }
            "list" => Ok(self.list()),
            // The replay goes out on the event stream, in order with the live output after it.
            "attach" => self.with(&id, |x| {
                let _ = tx.send(line(json!({ "ev": "data", "id": id, "data": x.buf, "replay": true })));
                Ok(Value::Null)
            }),
            "send" => self.send_text(&s("target"), &s("text")),
            // `mygdeck-cli mobile on|off` applies the setting to a running daemon.
            "mobile" => crate::mobile::apply(self),
            "shutdown" => {
                for x in self.sessions.lock().unwrap().values_mut() {
                    let _ = x.killer.kill();
                }
                self.stop.store(true, Ordering::SeqCst);
                Ok(Value::Null)
            }
            op => Err(format!("unknown op '{op}'")),
        }
    }

    fn handle(self: &Arc<Self>, stream: TcpStream) {
        let Ok(read_half) = stream.try_clone() else { return };
        // Socket timeouts belong to each handle on Windows: set them on the one that reads.
        let _ = read_half.set_read_timeout(Some(Duration::from_secs(5)));
        let mut reader = BufReader::new(read_half);
        let mut first = String::new();
        if reader.read_line(&mut first).unwrap_or(0) == 0 {
            return;
        }
        let first = first.trim_end().to_string();
        if !first.starts_with('{') {
            for l in std::iter::once(first).chain(reader.lines().map_while(Result::ok)) {
                if let Some(ev) = crate::hooks::parse_line(&l) {
                    self.on_hook(ev);
                }
            }
            return;
        }
        let hello: Value = serde_json::from_str(&first).unwrap_or(Value::Null);
        if hello["token"].as_str() != Some(self.token.as_str()) {
            return;
        }
        let _ = reader.get_ref().set_read_timeout(None);
        let (tx, rx) = channel::<String>();
        let mut w = stream;
        thread::spawn(move || {
            for msg in rx {
                if w.write_all(msg.as_bytes()).is_err() {
                    break;
                }
            }
        });
        let cid = {
            let mut n = self.next_client.lock().unwrap();
            *n += 1;
            *n
        };
        // Only windows receive the live event stream; the CLI just asks and leaves.
        if hello["events"].as_bool().unwrap_or(true) {
            self.clients.lock().unwrap().push((cid, tx.clone()));
        }
        let _ = tx.send(line(json!({ "re": 0, "ok": { "proto": PROTO, "pid": std::process::id() } })));
        for l in reader.lines().map_while(Result::ok) {
            let Ok(req) = serde_json::from_str::<Value>(&l) else { continue };
            let res = self.dispatch(&req, &tx);
            if let Some(re) = req["re"].as_u64() {
                let msg = match res {
                    Ok(v) => json!({ "re": re, "ok": v }),
                    Err(e) => json!({ "re": re, "err": e }),
                };
                let _ = tx.send(line(msg));
            }
        }
        self.clients.lock().unwrap().retain(|(c, _)| *c != cid);
    }
}

/// Accept connections on `listener` in the background.
pub fn start(listener: TcpListener, token: String) -> Arc<Hub> {
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let hub = Arc::new(Hub {
        port,
        token,
        sessions: Mutex::default(),
        clients: Mutex::default(),
        next_client: Mutex::default(),
        stop: AtomicBool::new(false),
        mobile: Mutex::default(),
    });
    let h = hub.clone();
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let h = h.clone();
            thread::spawn(move || h.handle(stream));
        }
    });
    hub
}

/// `mygdeck --daemon`: run until no window and no session is left for a while, or `shutdown`.
pub fn serve() {
    if read_info().is_some_and(|i| Client::connect(&i, false).is_ok()) {
        return; // another daemon already serves this user
    }
    let Ok(listener) = TcpListener::bind("127.0.0.1:0") else { return };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let info = Info { port, token: new_token(), pid: std::process::id(), proto: PROTO };
    let _ = std::fs::create_dir_all(dir());
    if std::fs::write(info_path(), serde_json::to_string(&info).unwrap_or_default()).is_err() {
        return;
    }
    let hub = start(listener, info.token.clone());
    let _ = crate::mobile::apply(&hub);
    let mut quiet_since = Instant::now();
    loop {
        thread::sleep(Duration::from_secs(1));
        if hub.stop.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(300)); // let the shutdown reply go out
            break;
        }
        if hub.busy() {
            quiet_since = Instant::now();
        } else if quiet_since.elapsed() >= IDLE_EXIT {
            break;
        }
    }
    crate::mobile::shutdown(&hub);
    if read_info().is_some_and(|i| i.pid == info.pid) {
        let _ = std::fs::remove_file(info_path());
    }
}

/// Synchronous connection for one-off requests (CLI, version checks).
pub struct Client {
    stream: TcpStream,
    reader: BufReader<TcpStream>,
    seq: u64,
}

impl Client {
    /// Connect and say hello; returns the daemon's hello reply.
    pub fn connect(info: &Info, events: bool) -> Result<(Client, Value), String> {
        let (stream, reader, hello) = open(info, events)?;
        Ok((Client { stream, reader, seq: 0 }, hello))
    }

    pub fn call(&mut self, mut op: Value) -> Result<Value, String> {
        self.seq += 1;
        op["re"] = json!(self.seq);
        self.stream.write_all(line(op).as_bytes()).map_err(|e| e.to_string())?;
        let mut l = String::new();
        loop {
            l.clear();
            if self.reader.read_line(&mut l).map_err(|e| e.to_string())? == 0 {
                return Err("세션 데몬 연결이 끊겼습니다".into());
            }
            let v: Value = serde_json::from_str(&l).unwrap_or(Value::Null);
            if v["re"].as_u64() == Some(self.seq) {
                return match v.get("err") {
                    Some(e) => Err(e.as_str().unwrap_or("error").to_string()),
                    None => Ok(v["ok"].clone()),
                };
            }
        }
    }
}

/// Open a connection and complete the hello; the reader is positioned after the hello reply.
pub fn open(info: &Info, events: bool) -> Result<(TcpStream, BufReader<TcpStream>, Value), String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], info.port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(500)).map_err(|e| e.to_string())?;
    stream.write_all(line(json!({ "op": "hello", "token": info.token, "events": events })).as_bytes()).map_err(|e| e.to_string())?;
    let read_half = stream.try_clone().map_err(|e| e.to_string())?;
    // Timeouts are per handle on Windows: only the hello waits, the event stream never times out.
    let _ = read_half.set_read_timeout(Some(Duration::from_secs(3)));
    let mut reader = BufReader::new(read_half);
    let mut l = String::new();
    reader.read_line(&mut l).map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_str(&l).map_err(|_| "세션 데몬이 응답하지 않습니다".to_string())?;
    let _ = reader.get_ref().set_read_timeout(None);
    Ok((stream, reader, v["ok"].clone()))
}

/// A copy of this executable outside the build folder. The daemon and the hooks run from it, so a
/// rebuild can replace the original while sessions keep running.
pub fn stable_exe() -> PathBuf {
    let Ok(exe) = std::env::current_exe() else { return PathBuf::from("mygdeck") };
    let Ok(meta) = std::fs::metadata(&exe) else { return exe };
    let mtime = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs());
    let bin = dir().join("bin");
    let ext = exe.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let target = bin.join(format!("mygdeck-{:x}-{:x}{ext}", meta.len(), mtime));
    if !target.is_file() {
        let tmp = bin.join(format!("tmp-{}{ext}", std::process::id()));
        let copied = std::fs::create_dir_all(&bin).is_ok() && std::fs::copy(&exe, &tmp).is_ok() && std::fs::rename(&tmp, &target).is_ok();
        if !copied {
            let _ = std::fs::remove_file(&tmp);
            return exe;
        }
    }
    // Older copies go once nothing runs them (a running one is locked on Windows; that is fine).
    for e in std::fs::read_dir(&bin).into_iter().flatten().flatten() {
        if e.path() != target && e.file_name().to_string_lossy().starts_with("mygdeck-") {
            let _ = std::fs::remove_file(e.path());
        }
    }
    target
}

fn spawn_daemon(exe: &Path) -> Result<(), String> {
    use std::process::{Command, Stdio};
    let mut c = Command::new(exe);
    c.arg("--daemon").current_dir(crate::config::home()).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED: u32 = 0x0000_0008 | 0x0000_0200; // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        const BREAKAWAY: u32 = 0x0100_0000; // CREATE_BREAKAWAY_FROM_JOB: survive a terminal closing the deck's job
        c.creation_flags(DETACHED | BREAKAWAY);
        let mut child = match c.spawn() {
            Ok(ch) => ch,
            Err(_) => {
                c.creation_flags(DETACHED);
                c.spawn().map_err(|e| e.to_string())?
            }
        };
        thread::spawn(move || child.wait());
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0);
        let mut child = c.spawn().map_err(|e| e.to_string())?;
        thread::spawn(move || child.wait());
    }
    Ok(())
}

/// The running daemon's address, starting one if needed. A daemon of another protocol version is
/// replaced only when it runs nothing; otherwise its sessions would be lost.
pub fn ensure_running() -> Result<Info, String> {
    if let Some(i) = read_info() {
        if let Ok((mut c, hello)) = Client::connect(&i, false) {
            if hello["proto"].as_u64() == Some(PROTO) {
                return Ok(i);
            }
            let n = c.call(json!({ "op": "list" })).ok().and_then(|v| v.as_array().map(Vec::len)).unwrap_or(0);
            if n > 0 {
                return Err(format!("이전 버전의 세션 데몬이 세션 {n}개를 실행 중입니다. `mygdeck-cli daemon stop`으로 끈 뒤 다시 여세요."));
            }
            let _ = c.call(json!({ "op": "shutdown" }));
            thread::sleep(Duration::from_millis(1500));
        }
    }
    spawn_daemon(&stable_exe())?;
    for _ in 0..80 {
        thread::sleep(Duration::from_millis(100));
        if let Some(i) = read_info() {
            if Client::connect(&i, false).is_ok() {
                return Ok(i);
            }
        }
    }
    Err("세션 데몬을 시작하지 못했습니다".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_keeps_tail_from_a_line_start() {
        let mut b = "aaaa\nbbbb\ncccc\n".to_string();
        trim_buf(&mut b, 6);
        assert_eq!(b, "cccc\n");
        let mut small = "가나다".to_string();
        trim_buf(&mut small, 100);
        assert_eq!(small, "가나다");
        let mut k = "가".repeat(100);
        trim_buf(&mut k, 10); // no newline: cut lands on a char boundary
        assert!(k.len() <= 12 && k.chars().all(|c| c == '가'));
    }

    #[test]
    fn helpers() {
        assert_eq!(bracketed_switch("x\x1b[?2004hy"), Some(true));
        assert_eq!(bracketed_switch("\x1b[?2004h..\x1b[?2004l"), Some(false));
        assert_eq!(bracketed_switch("plain"), None);
        assert!(matches_target("C:\\work\\MYGDeck\\", "mygdeck"));
        assert!(matches_target("C:/work/a", "c:\\work\\a"));
        assert!(!matches_target("C:/work/ab", "a") && !matches_target("C:/work/a", ""));
        assert_eq!(paste_bytes("a\nb", false), "a\rb");
        assert_eq!(paste_bytes("a\nb", true), "\x1b[200~a\nb\x1b[201~");
    }

    fn recv_until(rx: &std::sync::mpsc::Receiver<Value>, mut pred: impl FnMut(&Value) -> bool) -> Option<Value> {
        let end = Instant::now() + Duration::from_secs(10);
        while let Some(left) = end.checked_duration_since(Instant::now()) {
            match rx.recv_timeout(left) {
                Ok(v) if pred(&v) => return Some(v),
                Ok(_) => {}
                Err(_) => return None,
            }
        }
        None
    }

    #[test]
    fn daemon_runs_lists_replays_and_tracks_hooks() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let _hub = start(listener, "t0k".into());
        let info = Info { port, token: "t0k".into(), pid: 0, proto: PROTO };
        assert!(Client::connect(&Info { token: "bad".into(), ..info.clone() }, false).is_err());

        // A window: events arrive on its stream, requests are answered by "re".
        let (mut w, reader, hello) = open(&info, true).unwrap();
        assert_eq!(hello["proto"], PROTO);
        let (tx, rx) = channel::<Value>();
        thread::spawn(move || {
            for l in reader.lines().map_while(Result::ok) {
                let _ = tx.send(serde_json::from_str(&l).unwrap_or(Value::Null));
            }
        });
        let argv: Vec<&str> = if cfg!(windows) { vec!["cmd.exe", "/d", "/k", "echo mygdeck-daemon-ok"] } else { vec!["sh", "-c", "echo mygdeck-daemon-ok; sleep 30"] };
        let id = "C:/w/proj#agent|t1";
        w.write_all(line(json!({ "re": 1, "op": "spawn", "id": id, "cwd": std::env::temp_dir(), "argv": argv, "cols": 80, "rows": 24 })).as_bytes()).unwrap();
        assert!(recv_until(&rx, |v| v["re"] == 1).unwrap().get("err").is_none());
        // ConPTY asks for the cursor position before printing; xterm.js answers it in the app.
        let mut seen = String::new();
        let got = recv_until(&rx, |v| {
            let d = v["data"].as_str().unwrap_or("");
            if d.contains("\x1b[6n") {
                let _ = w.write_all(line(json!({ "op": "write", "id": id, "data": "\x1b[1;1R" })).as_bytes());
            }
            seen.push_str(d);
            seen.contains("mygdeck-daemon-ok")
        });
        assert!(got.is_some(), "no output: {seen:?}");

        // A hook line updates the session status.
        crate::hooks::send_to(id, &port.to_string(), "tool", r#"{"tool_name":"Edit","tool_input":{"file_path":"a.rs"}}"#);
        assert!(recv_until(&rx, |v| v["ev"] == "hook").is_some());
        let (mut cli, _) = Client::connect(&info, false).unwrap();
        let list = cli.call(json!({ "op": "list" })).unwrap();
        assert_eq!(list[0]["id"], id);
        assert_eq!(list[0]["status"], "working");
        assert_eq!(list[0]["text"], "Edit a.rs");

        // Reattach: the buffered output comes back as one replay event.
        w.write_all(line(json!({ "re": 2, "op": "attach", "id": id })).as_bytes()).unwrap();
        let replay = recv_until(&rx, |v| v["replay"] == true).unwrap();
        assert!(replay["data"].as_str().unwrap().contains("mygdeck-daemon-ok"));

        // CLI send finds the agent by its project folder.
        let tmp = std::env::temp_dir().to_string_lossy().into_owned();
        assert_eq!(cli.call(json!({ "op": "send", "target": tmp, "text": "echo x" })).unwrap()["id"], id);
        assert!(cli.call(json!({ "op": "send", "target": "nope", "text": "x" })).is_err());

        // An idle window connection outlives the hello timeouts (3 s client, 5 s daemon).
        thread::sleep(Duration::from_secs(6));
        assert_eq!(cli.call(json!({ "op": "list" })).unwrap()[0]["id"], id);
        w.write_all(line(json!({ "op": "kill", "id": id })).as_bytes()).unwrap();
        assert!(recv_until(&rx, |v| v["ev"] == "exit" && v["id"] == id).is_some(), "no exit event");
        assert_eq!(cli.call(json!({ "op": "list" })).unwrap(), json!([]));
    }
}

