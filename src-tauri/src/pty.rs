//! Terminal sessions as the window sees them. The PTYs live in the session daemon (daemon.rs) so
//! they survive the window; these commands forward to it and its events come back as Tauri events.
use crate::daemon::{self, PROTO};
use portable_pty::CommandBuilder;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

type Reply = Result<Value, String>;

/// The window's connection to the session daemon, opened on first use and reopened after a loss.
#[derive(Default)]
pub struct Daemon {
    conn: Mutex<Option<TcpStream>>,
    pending: Mutex<HashMap<u64, Sender<Reply>>>,
    seq: AtomicU64,
}

impl Daemon {
    fn ensure(&self, app: &AppHandle) -> Result<(), String> {
        let mut conn = self.conn.lock().unwrap();
        if conn.is_some() {
            return Ok(());
        }
        let info = daemon::ensure_running()?;
        let (stream, reader, hello) = daemon::open(&info, true)?;
        if hello["proto"].as_u64() != Some(PROTO) {
            return Err("세션 데몬 버전이 다릅니다. `mygdeck-cli daemon stop` 후 다시 여세요.".into());
        }
        let app = app.clone();
        thread::spawn(move || {
            for l in reader.lines().map_while(Result::ok) {
                let Ok(v) = serde_json::from_str::<Value>(&l) else { continue };
                if let Some(re) = v["re"].as_u64() {
                    let tx = app.state::<Daemon>().pending.lock().unwrap().remove(&re);
                    if let Some(tx) = tx {
                        let _ = tx.send(match v.get("err") {
                            Some(e) => Err(e.as_str().unwrap_or("error").to_string()),
                            None => Ok(v["ok"].clone()),
                        });
                    }
                    continue;
                }
                let name = match v["ev"].as_str() {
                    Some("data") => "pty-data",
                    Some("exit") => "pty-exit",
                    Some("hook") => "agent-hook",
                    _ => continue,
                };
                let _ = app.emit(name, v);
            }
            // The daemon went away: every session it held is gone with it.
            let d = app.state::<Daemon>();
            *d.conn.lock().unwrap() = None;
            for (_, tx) in d.pending.lock().unwrap().drain() {
                let _ = tx.send(Err("세션 데몬 연결이 끊겼습니다".into()));
            }
            let _ = app.emit("daemon-lost", ());
        });
        *conn = Some(stream);
        Ok(())
    }

    fn write_line(&self, app: &AppHandle, op: &Value) -> Result<(), String> {
        self.ensure(app)?;
        let mut conn = self.conn.lock().unwrap();
        let s = conn.as_mut().ok_or("세션 데몬 연결이 끊겼습니다")?;
        let mut l = op.to_string();
        l.push('\n');
        s.write_all(l.as_bytes()).map_err(|e| e.to_string())
    }

    /// Request with a reply.
    fn call(&self, app: &AppHandle, mut op: Value) -> Reply {
        let re = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        op["re"] = json!(re);
        let (tx, rx) = channel();
        self.pending.lock().unwrap().insert(re, tx);
        if let Err(e) = self.write_line(app, &op) {
            self.pending.lock().unwrap().remove(&re);
            return Err(e);
        }
        rx.recv_timeout(Duration::from_secs(15)).unwrap_or_else(|_| Err("세션 데몬이 응답하지 않습니다".into()))
    }

    /// Fire and forget: keystrokes and resizes must not wait for a round trip.
    fn cast(&self, app: &AppHandle, op: Value) -> Result<(), String> {
        self.write_line(app, &op)
    }
}

/// Runtime variables a running Claude Code session sets for its children. If the deck itself was
/// started from such a session, each card's agent would think it is a sub-session (and, e.g., stop
/// saving its transcript). Every card must be an independent top-level session.
/// shortcut: list taken from one observed parent session; extend if new session-scoped vars appear.
pub const INHERITED_SESSION_VARS: [&str; 15] = [
    "CLAUDECODE",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
    "CLAUDE_AGENT_SDK_VERSION",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_EMIT_STARTUP_TIMING",
    "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
    "CLAUDE_CODE_QUESTION_PREVIEW_FORMAT",
    "CLAUDE_CODE_ENABLE_TASKS",
];

pub fn is_editor_var(k: &str) -> bool {
    k.starts_with("VSCODE_")
        || k.starts_with("CURSOR_")
        || matches!(k, "TERM_PROGRAM" | "TERM_PROGRAM_VERSION" | "CLAUDE_CODE_SSE_PORT" | "ENABLE_IDE_INTEGRATION")
}


/// `{settings}` and `{hook_exe}` in an adapter's command become the deck's hook settings and hook program.
pub fn expand_command(command: &str, settings: &str, hook_exe: &str) -> Vec<String> {
    split_command(command).into_iter().map(|a| a.replace("{settings}", settings).replace("{hook_exe}", hook_exe)).collect()
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn pty_spawn(
    app: AppHandle,
    d: State<Daemon>,
    hooks: State<crate::hooks::HookInfo>,
    id: String,
    cwd: String,
    command: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let argv = expand_command(&command, &hooks.claude_settings, &hooks.hook_exe);
    d.call(&app, json!({ "op": "spawn", "id": id, "cwd": cwd, "argv": argv, "cols": cols, "rows": rows })).map(|_| ())
}

#[tauri::command]
pub fn pty_write(app: AppHandle, d: State<Daemon>, id: String, data: String) -> Result<(), String> {
    d.cast(&app, json!({ "op": "write", "id": id, "data": data }))
}

#[tauri::command]
pub fn pty_resize(app: AppHandle, d: State<Daemon>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    d.cast(&app, json!({ "op": "resize", "id": id, "cols": cols, "rows": rows }))
}

#[tauri::command]
pub fn pty_kill(app: AppHandle, d: State<Daemon>, id: String) -> Result<(), String> {
    d.cast(&app, json!({ "op": "kill", "id": id }))
}

/// Sessions still running in the daemon, e.g. from before the window was closed or reloaded.
#[tauri::command]
pub fn pty_list(app: AppHandle, d: State<Daemon>) -> Result<Value, String> {
    d.call(&app, json!({ "op": "list" }))
}

/// Ask for a session's buffered output; it arrives as one `pty-data` event with `replay: true`.
#[tauri::command]
pub fn pty_attach(app: AppHandle, d: State<Daemon>, id: String) -> Result<(), String> {
    d.call(&app, json!({ "op": "attach", "id": id })).map(|_| ())
}

/// The user's interactive shell, used for the per-project shell panel.
#[tauri::command]
pub fn default_shell() -> String {
    if cfg!(windows) {
        if find_program("pwsh").is_some() { "pwsh -NoLogo".into() } else { "powershell.exe -NoLogo".into() }
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    }
}

/// Resolve the program on PATH. Windows `.cmd` shims (npm-installed CLIs) must run through cmd.exe.
pub fn build_command(argv: &[String]) -> Result<CommandBuilder, String> {
    let (prog, args) = argv.split_first().ok_or("empty command")?;
    let found = find_program(prog).ok_or_else(|| format!("'{prog}' not found on PATH"))?;
    let is_script = cfg!(windows)
        && found
            .extension()
            .map(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
            .unwrap_or(false);
    let mut cmd = if is_script {
        let mut c = CommandBuilder::new("cmd.exe");
        // shortcut: args with spaces or quotes are not cmd-escaped; fine for agent CLIs, revisit if users pass such args to .cmd shims.
        c.args(["/d", "/c", prog.as_str()]);
        c
    } else {
        CommandBuilder::new(found)
    };
    cmd.args(args);
    Ok(cmd)
}

pub fn find_program(name: &str) -> Option<PathBuf> {
    let p = Path::new(name);
    if p.is_absolute() || p.components().count() > 1 {
        return p.is_file().then(|| p.to_path_buf());
    }
    let mut exts: Vec<String> = Vec::new();
    if !cfg!(windows) || p.extension().is_some() {
        exts.push(String::new());
    }
    if cfg!(windows) {
        let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
        exts.extend(pathext.split(';').filter(|e| !e.is_empty()).map(str::to_lowercase));
    }
    for dir in std::env::split_paths(&std::env::var_os("PATH")?) {
        for ext in &exts {
            let candidate = dir.join(format!("{name}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Split a command line on whitespace, honoring single and double quotes.
pub fn split_command(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    for ch in s.chars() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => cur.push(ch),
            None if ch == '"' || ch == '\'' => {
                quote = Some(ch);
                started = true;
            }
            None if ch.is_whitespace() => {
                if started {
                    out.push(std::mem::take(&mut cur));
                    started = false;
                }
            }
            None => {
                cur.push(ch);
                started = true;
            }
        }
    }
    if started {
        out.push(cur);
    }
    out
}

/// Turns a byte stream into UTF-8 strings without breaking characters split across reads.
#[derive(Default)]
pub struct Utf8Carry(Vec<u8>);

impl Utf8Carry {
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.0.extend_from_slice(bytes);
        match std::str::from_utf8(&self.0) {
            Ok(s) => {
                let s = s.to_owned();
                self.0.clear();
                s
            }
            Err(e) if e.error_len().is_none() => {
                // Incomplete character at the end: emit the valid part, keep the tail.
                let valid = e.valid_up_to();
                let s = String::from_utf8_lossy(&self.0[..valid]).into_owned();
                self.0.drain(..valid);
                s
            }
            Err(_) => {
                let s = String::from_utf8_lossy(&self.0).into_owned();
                self.0.clear();
                s
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use portable_pty::{native_pty_system, PtySize};
    use std::io::{Read, Write};

    #[test]
    fn utf8_carry_keeps_split_characters() {
        let bytes = "가나".as_bytes(); // 6 bytes
        let mut d = Utf8Carry::default();
        assert_eq!(d.push(&bytes[..4]), "가");
        assert_eq!(d.push(&bytes[4..]), "나");
        assert_eq!(d.push(b"ok"), "ok");
    }

    #[test]
    fn editor_vars_are_dropped() {
        assert!(is_editor_var("VSCODE_PID") && is_editor_var("TERM_PROGRAM") && is_editor_var("CLAUDE_CODE_SSE_PORT"));
        assert!(!is_editor_var("PATH") && !is_editor_var("CLAUDE_CODE_USE_BEDROCK"));
    }

    #[test]
    fn split_command_handles_quotes() {
        assert_eq!(split_command("claude --settings \"C:/a b/x.json\""), ["claude", "--settings", "C:/a b/x.json"]);
        assert_eq!(split_command("  ssh  host 'claude -c' "), ["ssh", "host", "claude -c"]);
        assert_eq!(split_command("x \"\""), ["x", ""]);
    }

    #[test]
    fn pty_runs_a_real_process() {
        let argv: Vec<String> = if cfg!(windows) {
            ["cmd.exe", "/d", "/c", "echo mygdeck-ok"].map(String::from).to_vec()
        } else {
            ["sh", "-c", "echo mygdeck-ok"].map(String::from).to_vec()
        };
        let pair = native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        let child = pair.slave.spawn_command(build_command(&argv).unwrap()).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        // Keep draining until EOF: on Windows the child cannot exit while its output is unread.
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut all = String::new();
            let mut sent = false;
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 { break; }
                let chunk = String::from_utf8_lossy(&buf[..n]);
                // ConPTY asks for the cursor position first; xterm.js answers this in the app.
                if chunk.contains("\x1b[6n") {
                    let _ = writer.write_all(b"\x1b[1;1R");
                }
                all.push_str(&chunk);
                if !sent && all.contains("mygdeck-ok") {
                    sent = tx.send(true).is_ok();
                }
            }
            if !sent {
                let _ = tx.send(false);
                eprintln!("pty output was: {all:?}");
            }
        });
        let ok = rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap_or(false);
        let mut killer = child.clone_killer();
        let _ = killer.kill(); // never block the test run on process teardown
        drop(pair.master);
        assert!(ok, "pty output did not arrive");
    }
}
