//! `mygdeck-cli`: the deck's sessions from any terminal (status, send), through the session daemon.
use crate::daemon::{read_info, Client};
use serde_json::{json, Value};

const HELP: &str = "mygdeck-cli — MYG Deck 세션을 터미널에서 다루기

사용법:
  mygdeck-cli status [--json]          실행 중인 에이전트·셸 세션과 상태
  mygdeck-cli send <프로젝트> <메시지>  에이전트에 메시지 입력 (폴더 이름 또는 전체 경로)
  mygdeck-cli daemon stop              세션 데몬과 모든 세션 종료
  mygdeck-cli mobile [on|off] [--port N] [--url 주소]  휴대폰 대시보드 켜기·끄기, 접속 링크 보기";

fn mobile_guide(conf: &crate::mobile::Conf, live: Result<Option<Value>, String>) -> String {
    let port = conf.port;
    let state = match live {
        Ok(Some(v)) => format!("켜짐 · 터널: {}", v["tunnel"].as_str().unwrap_or("?")),
        Ok(None) => "켜짐 (덱을 열면 함께 시작됩니다)".to_string(),
        Err(e) => format!("설정은 켜졌지만 시작하지 못했습니다: {e}"),
    };
    let phone = match &conf.relay {
        Some(url) => format!("휴대폰에서: {url}  (하루 한 번 비밀번호)"),
        None => "휴대폰 주소(Cloudflare Worker)가 아직 없습니다. docs/mobile.md의 설정 후:
  mygdeck-cli mobile on --url https://mygdeck.<계정>.workers.dev"
            .to_string(),
    };
    format!(
        "휴대폰 대시보드: {state}
  이 PC에서 확인: http://127.0.0.1:{port}/?k={}
{phone}

끄기: mygdeck-cli mobile off (다시 켜면 토큰이 바뀌므로 Worker의 DASH_TOKEN도 다시 넣어야 합니다)",
        conf.token
    )
}

/// The phone reaches the PC only through the daemon's tunnel, so with the dashboard on the daemon
/// runs from login on, window or not. The deck program (next to this one) starts it.
fn start_daemon_now_and_at_login() -> String {
    let exe = std::env::current_exe().map(|p| p.with_file_name(if cfg!(windows) { "mygdeck.exe" } else { "mygdeck" }));
    let Ok(exe) = exe.map_err(|e| e.to_string()).and_then(|p| if p.is_file() { Ok(p) } else { Err(format!("{} 없음", p.display())) }) else {
        return "로그인 시 자동 시작을 설정하지 못했습니다: MYG Deck 실행 파일을 찾지 못했습니다".into();
    };
    if connect().is_none() {
        let _ = std::process::Command::new(&exe).arg("--start-daemon").status();
    }
    match crate::mobile::autostart(Some(&exe)) {
        Ok(()) => "로그인 시 자동 시작: 켜짐 (덱을 닫아도 휴대폰에서 접속해 덱을 열 수 있습니다)".into(),
        Err(e) => format!("로그인 시 자동 시작을 설정하지 못했습니다: {e}"),
    }
}

/// Tell a running daemon to apply `mobile.json`; its reply has the tunnel state. None: no daemon now.
fn mobile_apply() -> Result<Option<Value>, String> {
    match connect() {
        Some(mut c) => c.call(json!({ "op": "mobile" })).map(Some).map_err(|e| {
            if e.starts_with("unknown op") {
                "지금 도는 세션 데몬이 이전 버전입니다. `mygdeck-cli daemon stop`(모든 세션 종료) 후 덱을 다시 열면 켜집니다".into()
            } else {
                e
            }
        }),
        None => Ok(None),
    }
}

fn mobile(args: &[&str]) -> i32 {
    let port = match args.iter().position(|a| *a == "--port") {
        Some(i) => match args.get(i + 1).and_then(|p| p.parse::<u16>().ok()).filter(|p| *p > 0) {
            Some(p) => Some(p),
            None => return fail("--port 뒤에 포트 번호를 적으세요"),
        },
        None => None,
    };
    let url = match args.iter().position(|a| *a == "--url") {
        Some(i) => match args.get(i + 1).filter(|u| u.starts_with("https://") || u.starts_with("http://")) {
            Some(u) => Some(u.trim_end_matches('/').to_string()),
            None => return fail("--url 뒤에 https://로 시작하는 주소를 적으세요"),
        },
        None => None,
    };
    match args.first().copied() {
        Some("off") => {
            crate::mobile::disable();
            let _ = crate::mobile::autostart(None);
            if let Err(e) = mobile_apply() {
                return fail(&e);
            }
            println!("휴대폰 대시보드를 껐습니다. 로그인 시 자동 시작도 해제했습니다. 휴대폰에서는 'PC에 연결할 수 없습니다'가 뜹니다.");
            0
        }
        // For setup: `mygdeck-cli mobile token | npx wrangler secret put DASH_TOKEN`.
        Some("token") => match crate::mobile::read_conf() {
            Some(c) => {
                print!("{}", c.token);
                0
            }
            None => fail("휴대폰 대시보드가 꺼져 있습니다. 먼저: mygdeck-cli mobile on"),
        },
        // The named tunnel's run token, read from stdin so it stays out of shell history.
        Some("tunnel-token") => {
            let mut t = String::new();
            if std::io::Read::read_to_string(&mut std::io::stdin(), &mut t).is_err() || t.trim().is_empty() {
                return fail("터널 토큰을 표준 입력으로 넘기세요");
            }
            match crate::mobile::enable(None, None, Some(t.trim().to_string())) {
                Ok(conf) => {
                    println!("{}", mobile_guide(&conf, mobile_apply()));
                    0
                }
                Err(e) => fail(&e),
            }
        }
        Some("on") | Some("--port") | Some("--url") => match crate::mobile::enable(port, url, None) {
            Ok(conf) => {
                let note = start_daemon_now_and_at_login();
                println!("{}\n{note}", mobile_guide(&conf, mobile_apply()));
                0
            }
            Err(e) => fail(&e),
        },
        None => match crate::mobile::read_conf() {
            Some(conf) => {
                println!("{}", mobile_guide(&conf, mobile_apply()));
                0
            }
            None => {
                println!("휴대폰 대시보드가 꺼져 있습니다. 켜려면: mygdeck-cli mobile on");
                0
            }
        },
        Some(other) => fail(&format!("알 수 없는 옵션 '{other}' (on, off, token, tunnel-token, --port N, --url 주소)")),
    }
}

fn connect() -> Option<Client> {
    read_info().and_then(|i| Client::connect(&i, false).ok()).map(|(c, _)| c)
}

fn label(v: &Value) -> String {
    let cwd = v["cwd"].as_str().unwrap_or("");
    let name = cwd.replace('\\', "/").trim_end_matches('/').rsplit('/').next().unwrap_or(cwd).to_string();
    let role = v["id"].as_str().and_then(|id| id.split('#').nth(1)).and_then(|r| r.split('|').next()).unwrap_or("?");
    format!("{name} ({role})")
}

/// Human-readable table of `list` output.
pub fn format_status(list: &Value) -> String {
    let rows = list.as_array().cloned().unwrap_or_default();
    if rows.is_empty() {
        return "실행 중인 세션이 없습니다.".into();
    }
    let names: Vec<String> = rows.iter().map(label).collect();
    let w = names.iter().map(|n| n.chars().count()).max().unwrap_or(0).max(8);
    let mut out = String::new();
    for (v, n) in rows.iter().zip(names) {
        let pad = w - n.chars().count();
        out.push_str(&format!("{n}{}  {:<8} {}\n", " ".repeat(pad), v["status"].as_str().unwrap_or(""), v["text"].as_str().unwrap_or("")));
    }
    out.trim_end().to_string()
}

/// Returns the process exit code.
pub fn run(args: &[String]) -> i32 {
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    match a.as_slice() {
        ["status", rest @ ..] => {
            let json_out = rest.contains(&"--json");
            let list = match connect() {
                Some(mut c) => match c.call(json!({ "op": "list" })) {
                    Ok(v) => v,
                    Err(e) => return fail(&e),
                },
                None => json!([]),
            };
            println!("{}", if json_out { list.to_string() } else { format_status(&list) });
            0
        }
        ["send", target, words @ ..] if !words.is_empty() => {
            let Some(mut c) = connect() else { return fail("실행 중인 MYG Deck 세션이 없습니다") };
            match c.call(json!({ "op": "send", "target": target, "text": words.join(" ") })) {
                Ok(_) => 0,
                Err(e) => fail(&e),
            }
        }
        ["mobile", rest @ ..] => mobile(rest),
        ["daemon", "stop"] => {
            if let Some(mut c) = connect() {
                if let Err(e) = c.call(json!({ "op": "shutdown" })) {
                    return fail(&e);
                }
            }
            0
        }
        _ => {
            println!("{HELP}");
            if a.is_empty() || matches!(a[0], "help" | "--help" | "-h") { 0 } else { 2 }
        }
    }
}

fn fail(msg: &str) -> i32 {
    eprintln!("mygdeck-cli: {msg}");
    1
}

#[cfg(test)]
mod tests {
    #[test]
    fn status_table() {
        let list = serde_json::json!([
            { "id": "C:/w/api#agent|x", "cwd": "C:/w/api", "status": "working", "text": "Edit a.rs" },
            { "id": "C:/w/web#shell|y", "cwd": "C:\\w\\web", "status": "idle", "text": "" },
        ]);
        let t = super::format_status(&list);
        assert!(t.contains("api (agent)  working  Edit a.rs"), "{t}");
        assert!(t.contains("web (shell)  idle"), "{t}");
        assert_eq!(super::format_status(&serde_json::json!([])), "실행 중인 세션이 없습니다.");
    }
}
