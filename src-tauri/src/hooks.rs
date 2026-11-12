//! Agent status via hooks. The agent runs this same binary as its hook command
//! (`mygdeck --hook <event>`), which forwards a trimmed payload to the session daemon's port.
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;
use tauri::{AppHandle, Manager};

pub struct HookInfo {
    /// Settings file passed to Claude Code with `--settings`, so the user's own settings stay untouched.
    pub claude_settings: String,
    /// Program agents run as their hook command (`{hook_exe}` in adapters, e.g. Codex `notify`).
    pub hook_exe: String,
}

#[derive(Clone, serde::Serialize, Debug, PartialEq)]
pub struct HookEvent {
    pub id: String,
    pub event: String,
    pub data: Value,
}

pub fn parse_line(line: &str) -> Option<HookEvent> {
    let mut parts = line.splitn(3, '\t');
    let id = parts.next()?.to_string();
    let event = parts.next()?.to_string();
    if id.is_empty() || event.is_empty() {
        return None;
    }
    let data = parts.next().and_then(|d| serde_json::from_str(d).ok()).unwrap_or(Value::Null);
    Some(HookEvent { id, event, data })
}

/// Entry point of the hook process. It must never disturb the agent: no output, always exit 0.
/// Claude Code pipes the payload on stdin; Codex `notify` passes it as the last argument.
pub fn send(event: &str, arg_payload: Option<&str>) {
    let (Ok(id), Ok(port)) = (std::env::var("MYGDECK_ID"), std::env::var("MYGDECK_PORT")) else {
        return;
    };
    let mut input = String::new();
    match arg_payload {
        Some(p) => input.push_str(p),
        None => {
            let _ = std::io::stdin().take(4 << 20).read_to_string(&mut input);
        }
    }
    send_to(&id, &port, event, &input);
}

pub fn send_to(id: &str, port: &str, event: &str, payload: &str) {
    let Ok(port) = port.parse::<u16>() else { return };
    let line = format!("{id}\t{event}\t{}\n", trim_payload(payload));
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    if let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) {
        let _ = s.write_all(line.as_bytes());
    }
}

fn clip(v: Option<&Value>, max: usize) -> Value {
    match v.and_then(Value::as_str) {
        Some(s) => Value::String(s.chars().take(max).collect()),
        None => Value::Null,
    }
}

/// Keep only what the deck shows. Tool inputs can carry whole file contents.
pub fn trim_payload(raw: &str) -> String {
    let v: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
    let input = v.get("tool_input");
    let detail = ["file_path", "command", "pattern", "description", "url", "path"]
        .iter()
        .find_map(|k| input.and_then(|t| t.get(*k)).filter(|x| x.is_string()));
    json!({
        "message": clip(v.get("message"), 200),
        "prompt": clip(v.get("prompt"), 300),
        "tool": clip(v.get("tool_name"), 60),
        "detail": clip(detail, 200),
        "transcript": clip(v.get("transcript_path"), 1000),
    })
    .to_string()
}

pub fn write_claude_settings(app: &AppHandle, exe: &str) -> Result<String, Box<dyn std::error::Error>> {
    let hook = |ev: &str| json!([{ "hooks": [{ "type": "command", "command": format!("\"{exe}\" --hook {ev}") }] }]);
    let mut tool = hook("tool");
    tool[0]["matcher"] = json!("*");
    let settings = json!({ "hooks": {
        "UserPromptSubmit": hook("prompt"),
        "PreToolUse": tool,
        "Notification": hook("notify"),
        "Stop": hook("stop"),
    }});
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("claude-hooks.json");
    std::fs::write(&path, settings.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;

    #[test]
    fn trims_large_tool_input() {
        let raw = json!({ "tool_name": "Write", "tool_input": { "file_path": "src/a.rs", "content": "x".repeat(100_000) } }).to_string();
        let out: Value = serde_json::from_str(&trim_payload(&raw)).unwrap();
        assert_eq!(out["tool"], "Write");
        assert_eq!(out["detail"], "src/a.rs");
        assert!(trim_payload(&raw).len() < 300);
        assert_eq!(serde_json::from_str::<Value>(&trim_payload("not json")).unwrap()["tool"], Value::Null);
    }

    #[test]
    fn hook_reaches_listener() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port().to_string();
        send_to("p1", &port, "notify", r#"{"message":"Claude needs your permission to use Bash"}"#);
        let (s, _) = l.accept().unwrap();
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line).unwrap();
        let ev = parse_line(line.trim_end()).unwrap();
        assert_eq!((ev.id.as_str(), ev.event.as_str()), ("p1", "notify"));
        assert_eq!(ev.data["message"], "Claude needs your permission to use Bash");
        assert!(parse_line("\tstop").is_none());
    }
}
