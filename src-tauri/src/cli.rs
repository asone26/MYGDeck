//! `mygdeck-cli`: the deck's sessions from any terminal (status, send), through the session daemon.
use crate::daemon::{read_info, Client};
use serde_json::{json, Value};

const HELP: &str = "mygdeck-cli — mygdeck 세션을 터미널에서 다루기

사용법:
  mygdeck-cli status [--json]          실행 중인 에이전트·셸 세션과 상태
  mygdeck-cli send <프로젝트> <메시지>  에이전트에 메시지 입력 (폴더 이름 또는 전체 경로)
  mygdeck-cli daemon stop              세션 데몬과 모든 세션 종료";

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
            let Some(mut c) = connect() else { return fail("실행 중인 mygdeck 세션이 없습니다") };
            match c.call(json!({ "op": "send", "target": target, "text": words.join(" ") })) {
                Ok(_) => 0,
                Err(e) => fail(&e),
            }
        }
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
