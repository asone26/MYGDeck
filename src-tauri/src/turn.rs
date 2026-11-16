//! The last turn of an agent conversation, read from its transcript file (spec 3.2 ④-1).
//! Claude Code writes one JSON object per line; a turn starts at the user's prompt.
use serde::Serialize;
use serde_json::Value;
use std::io::{Read, Seek, SeekFrom};

/// Long sessions grow large; the last turn is always near the end.
const TAIL: u64 = 8 << 20;

#[derive(Serialize, Default, Debug, PartialEq)]
pub struct ToolRun {
    pub id: String,
    pub name: String,
    pub detail: String,
    pub error: Option<String>,
    /// How many texts came before it: tools and texts interleave in the order the CLI showed them.
    pub at: usize,
}

/// One item of the agent's to-do list (Claude Code's TodoWrite), as the CLI shows it.
#[derive(Serialize, Default, Debug, PartialEq)]
pub struct Todo {
    pub content: String,
    pub status: String,
    pub active: String,
}

#[derive(Serialize, Default, Debug)]
pub struct Turn {
    pub prompt: String,
    pub texts: Vec<String>,
    pub tools: Vec<ToolRun>,
    /// The latest to-do list written in this turn (each TodoWrite replaces the whole list).
    pub todos: Vec<Todo>,
    /// Tokens the model saw on its last call: input + cache read + cache creation.
    pub context_tokens: u64,
    /// Model of the last call (e.g. "claude-opus-5-5"): picks the context window (adapter `context_limits`).
    pub model: String,
}

#[tauri::command]
pub fn read_turn(path: String) -> Result<Turn, String> {
    // Transcripts live under the user's home (e.g. ~/.claude/projects); refuse anything else.
    let p = std::path::Path::new(&path);
    if p.extension().and_then(|e| e.to_str()) != Some("jsonl") || !p.starts_with(crate::config::home()) {
        return Err("not a transcript file".into());
    }
    let mut f =std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    let start = len.saturating_sub(TAIL);
    f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&buf);
    // When we started mid-file, the first line is partial.
    let body = if start > 0 { text.split_once('\n').map(|x| x.1).unwrap_or("") } else { &text };
    Ok(parse_turn(body))
}

fn content_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(items) => items.iter().filter_map(|i| i.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

fn tool_detail(input: &Value) -> String {
    [
        "file_path", "command", "pattern", "path", "url", "description",
        "CommandLine", "Path", "TargetFile", "Pattern", "Query", "Url",
    ]
        .iter()
        .find_map(|k| input.get(*k).and_then(Value::as_str))
        .unwrap_or("")
        .chars()
        .take(300)
        .collect()
}

fn agy_user_prompt(raw: &str) -> String {
    if let Some((_, rest)) = raw.split_once("<USER_REQUEST>") {
        if let Some((inner, _)) = rest.split_once("</USER_REQUEST>") {
            return inner.trim().to_string();
        }
    }
    raw.split("<ADDITIONAL_METADATA>").next().unwrap_or(raw).trim().to_string()
}

/// Text the harness injects as a user row (newer Claude Code marks the origin; older ones only the wrapper tag).
fn is_notice(row: &Value, prompt: &str) -> bool {
    let origin = row.pointer("/origin/kind").and_then(Value::as_str);
    let p = prompt.trim_start();
    origin.is_some_and(|k| k != "human")
        || ["<task-notification", "<agent-message", "<system-reminder", "[SYSTEM NOTIFICATION"].iter().any(|t| p.starts_with(t))
}

fn todos(list: &Value) -> Vec<Todo> {
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    list.as_array().into_iter().flatten().map(|t| Todo { content: s(t, "content"), status: s(t, "status"), active: s(t, "activeForm") }).collect()
}

pub fn parse_turn(jsonl: &str) -> Turn {
    let mut turn = Turn::default();
    for line in jsonl.lines() {
        let Ok(row) = serde_json::from_str::<Value>(line) else { continue };
        // Subagent traffic and meta notices are not part of what the user asked.
        if row.get("isSidechain").and_then(Value::as_bool) == Some(true) || row.get("isMeta").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        match row.get("type").and_then(Value::as_str) {
            Some("USER_INPUT") if row.get("source").and_then(Value::as_str) != Some("SYSTEM") => {
                let prompt = agy_user_prompt(row.get("content").and_then(Value::as_str).unwrap_or(""));
                if !prompt.is_empty() && !is_notice(&row, &prompt) {
                    turn = Turn { prompt, context_tokens: turn.context_tokens, model: std::mem::take(&mut turn.model), ..Default::default() };
                }
                continue;
            }
            Some("PLANNER_RESPONSE") => {
                if row.get("input_tokens").is_some() || row.get("cache_read_tokens").is_some() {
                    let n = |k: &str| row.get(k).and_then(Value::as_u64).unwrap_or(0);
                    turn.context_tokens = n("input_tokens") + n("cache_read_tokens");
                }
                if let Some(m) = row.get("model").and_then(Value::as_str).filter(|m| !m.is_empty()) {
                    turn.model = m.into();
                }
                if let Some(t) = row.get("content").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                    turn.texts.push(t.into());
                }
                for tc in row.get("tool_calls").and_then(Value::as_array).into_iter().flatten() {
                    let name = tc.get("name").and_then(Value::as_str).unwrap_or("");
                    if name.is_empty() {
                        continue;
                    }
                    turn.tools.push(ToolRun {
                        id: String::new(),
                        name: name.into(),
                        detail: tool_detail(tc.get("args").unwrap_or(&Value::Null)),
                        error: None,
                        at: turn.texts.len(),
                    });
                }
                continue;
            }
            _ => {}
        }
        let Some(content) = row.pointer("/message/content") else { continue };
        match row.get("type").and_then(Value::as_str) {
            Some("user") => {
                let results: Vec<&Value> = content
                    .as_array()
                    .map(|a| a.iter().filter(|i| i.get("type").and_then(Value::as_str) == Some("tool_result")).collect())
                    .unwrap_or_default();
                if results.is_empty() {
                    let prompt = content_text(content);
                    // Task notices and subagent reports arrive as user rows: the agent keeps answering the same request.
                    if !prompt.trim().is_empty() && !is_notice(&row, &prompt) {
                        turn = Turn { prompt, context_tokens: turn.context_tokens, model: std::mem::take(&mut turn.model), ..Default::default() };
                    }
                }
                for r in results {
                    let id = r.get("tool_use_id").and_then(Value::as_str).unwrap_or("");
                    if r.get("is_error").and_then(Value::as_bool) == Some(true) {
                        if let Some(t) = turn.tools.iter_mut().find(|t| t.id == id) {
                            t.error = Some(content_text(r.get("content").unwrap_or(&Value::Null)).chars().take(600).collect());
                        }
                    }
                }
            }
            Some("assistant") => {
                if let Some(u) = row.pointer("/message/usage") {
                    let n = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
                    turn.context_tokens = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
                }
                // "<synthetic>" rows are the CLI's own notices, not a model call.
                if let Some(m) = row.pointer("/message/model").and_then(Value::as_str).filter(|m| !m.starts_with('<')) {
                    turn.model = m.into();
                }
                for item in content.as_array().into_iter().flatten() {
                    match item.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            let t = item.get("text").and_then(Value::as_str).unwrap_or("").trim().to_string();
                            if !t.is_empty() {
                                turn.texts.push(t);
                            }
                        }
                        Some("tool_use") if item.get("name").and_then(Value::as_str) == Some("TodoWrite") => {
                            turn.todos = todos(item.pointer("/input/todos").unwrap_or(&Value::Null));
                        }
                        Some("tool_use") => turn.tools.push(ToolRun {
                            id: item.get("id").and_then(Value::as_str).unwrap_or("").into(),
                            name: item.get("name").and_then(Value::as_str).unwrap_or("").into(),
                            detail: tool_detail(item.get("input").unwrap_or(&Value::Null)),
                            error: None,
                            at: turn.texts.len(),
                        }),
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    turn
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_the_last_turn() {
        let lines = [
            r#"{"type":"user","message":{"content":"first task"}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"old answer"}]}}"#,
            r#"{"type":"user","message":{"content":"run the tests"}}"#,
            r#"{"type":"assistant","message":{"model":"claude-opus-5-5","usage":{"input_tokens":2,"cache_read_input_tokens":40000,"cache_creation_input_tokens":300},"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"npm test","description":"run"}}]}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"Exit code 1\n2 tests failed"}]}}"#,
            r#"{"type":"user","isMeta":true,"message":{"content":"<system notice>"}}"#,
            r#"{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"subagent chatter"}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Two tests fail."}]}}"#,
            "not json",
        ]
        .join("\n");
        let t = parse_turn(&lines);
        assert_eq!(t.prompt, "run the tests");
        assert_eq!(t.texts, vec!["Two tests fail."]);
        assert_eq!(t.tools.len(), 1);
        assert_eq!(t.tools[0].detail, "npm test");
        assert_eq!(t.tools[0].at, 0);
        assert_eq!(t.tools[0].error.as_deref(), Some("Exit code 1\n2 tests failed"));
        assert_eq!(t.context_tokens, 40302);
        assert_eq!(t.model, "claude-opus-5-5");
    }

    #[test]
    fn notices_do_not_start_a_turn() {
        let lines = [
            r#"{"type":"user","origin":{"kind":"human"},"message":{"content":"리뷰 돌려줘"}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"맡겼습니다."}]}}"#,
            r#"{"type":"user","origin":{"kind":"task-notification"},"message":{"content":"<task-notification>\n<status>completed</status>"}}"#,
            r#"{"type":"user","message":{"content":"<agent-message from=\"a1\">report</agent-message>"}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"BLOCKING 0건입니다."}]}}"#,
        ]
        .join("\n");
        let t = parse_turn(&lines);
        assert_eq!(t.prompt, "리뷰 돌려줘");
        assert_eq!(t.texts, vec!["맡겼습니다.", "BLOCKING 0건입니다."]);
    }

    #[test]
    fn keeps_the_latest_todo_list_out_of_the_tools() {
        let lines = [
            r#"{"type":"user","message":{"content":"고쳐줘"}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"a","name":"TodoWrite","input":{"todos":[{"content":"원인 찾기","status":"in_progress","activeForm":"원인 찾는 중"}]}}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"b","name":"TodoWrite","input":{"todos":[{"content":"원인 찾기","status":"completed","activeForm":"원인 찾는 중"},{"content":"테스트","status":"in_progress","activeForm":"테스트 실행 중"}]}}]}}"#,
        ]
        .join("
");
        let t = parse_turn(&lines);
        assert!(t.tools.is_empty());
        assert_eq!(t.todos.len(), 2);
        assert_eq!(t.todos[1], Todo { content: "테스트".into(), status: "in_progress".into(), active: "테스트 실행 중".into() });
    }

    #[test]
    fn parses_agy_transcript_turns() {
        let lines = [
            r#"{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","content":"<USER_REQUEST>\nAGY GUI 확인\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime\n</ADDITIONAL_METADATA>"}"#,
            r#"{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","model":"gemini-4-hydrogen-medium","input_tokens":1000,"cache_read_tokens":500,"tool_calls":[{"name":"run_command","args":{"CommandLine":"cargo test"}}]}"#,
            r#"{"step_index":2,"source":"MODEL","type":"PLANNER_RESPONSE","model":"gemini-4-hydrogen-medium","input_tokens":1200,"cache_read_tokens":800,"content":"모두 통과했습니다."}"#,
        ]
        .join("\n");
        let t = parse_turn(&lines);
        assert_eq!(t.prompt, "AGY GUI 확인");
        assert_eq!(t.model, "gemini-4-hydrogen-medium");
        assert_eq!(t.context_tokens, 2000);
        assert_eq!(t.tools.len(), 1);
        assert_eq!(t.tools[0].name, "run_command");
        assert_eq!(t.tools[0].detail, "cargo test");
        assert_eq!(t.texts, vec!["모두 통과했습니다."]);
    }
}
