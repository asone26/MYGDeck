use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;
use tauri::{AppHandle, Emitter, Manager, State};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

/// Live PTY sessions, keyed by the id the frontend picked for each spawn.
#[derive(Default)]
pub struct Ptys(Mutex<HashMap<String, Session>>);

impl Ptys {
    pub fn kill_all(&self) {
        for (_, mut s) in self.0.lock().unwrap().drain() {
            let _ = s.killer.kill();
        }
    }
}

#[derive(Clone, serde::Serialize)]
struct Data {
    id: String,
    data: String,
}

#[derive(Clone, serde::Serialize)]
struct Exit {
    id: String,
    code: Option<u32>,
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn pty_spawn(
    app: AppHandle,
    ptys: State<Ptys>,
    hooks: State<crate::hooks::HookInfo>,
    id: String,
    cwd: String,
    command: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let mut argv = split_command(&command);
    for a in argv.iter_mut() {
        *a = a.replace("{settings}", &hooks.claude_settings);
    }
    let mut cmd = build_command(&argv)?;
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("MYGDECK_ID", &id);
    cmd.env("MYGDECK_PORT", hooks.port.to_string());

    let size = PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 };
    let pair = native_pty_system().openpty(size).map_err(err)?;
    let mut child = pair.slave.spawn_command(cmd).map_err(err)?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(err)?;
    let writer = pair.master.take_writer().map_err(err)?;
    let killer = child.clone_killer();
    ptys.0.lock().unwrap().insert(id.clone(), Session { master: pair.master, writer, killer });

    let (out_app, out_id) = (app.clone(), id.clone());
    thread::spawn(move || {
        let mut buf = [0u8; 16384];
        let mut dec = Utf8Carry::default();
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            let s = dec.push(&buf[..n]);
            if !s.is_empty() {
                let _ = out_app.emit("pty-data", Data { id: out_id.clone(), data: s });
            }
        }
    });
    thread::spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code());
        // Dropping the master closes the pseudo console, which ends the reader thread.
        app.state::<Ptys>().0.lock().unwrap().remove(&id);
        let _ = app.emit("pty-exit", Exit { id, code });
    });
    Ok(())
}

#[tauri::command]
pub fn pty_write(ptys: State<Ptys>, id: String, data: String) -> Result<(), String> {
    let mut map = ptys.0.lock().unwrap();
    let s = map.get_mut(&id).ok_or("session closed")?;
    s.writer.write_all(data.as_bytes()).map_err(err)?;
    s.writer.flush().map_err(err)
}

#[tauri::command]
pub fn pty_resize(ptys: State<Ptys>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let map = ptys.0.lock().unwrap();
    let s = map.get(&id).ok_or("session closed")?;
    let size = PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 };
    s.master.resize(size).map_err(err)
}

#[tauri::command]
pub fn pty_kill(ptys: State<Ptys>, id: String) {
    if let Some(mut s) = ptys.0.lock().unwrap().remove(&id) {
        let _ = s.killer.kill();
    }
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

    #[test]
    fn utf8_carry_keeps_split_characters() {
        let bytes = "가나".as_bytes(); // 6 bytes
        let mut d = Utf8Carry::default();
        assert_eq!(d.push(&bytes[..4]), "가");
        assert_eq!(d.push(&bytes[4..]), "나");
        assert_eq!(d.push(b"ok"), "ok");
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
