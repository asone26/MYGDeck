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
}

#[derive(Serialize, Default, Debug)]
pub struct Turn {
    pub prompt: String,
    pub texts: Vec<String>,
    pub tools: Vec<ToolRun>,
    /// Tokens the model saw on its last call: input + cache read + cache creation.
    pub context_tokens: u64,
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
    ["file_path", "command", "pattern", "path", "url", "description"]
        .iter()
        .find_map(|k| input.get(*k).and_then(Value::as_str))
        .unwrap_or("")
        .chars()
        .take(300)
        .collect()
}

pub fn parse_turn(jsonl: &str) -> Turn {
    let mut turn = Turn::default();
    for line in jsonl.lines() {
        let Ok(row) = serde_json::from_str::<Value>(line) else { continue };
        // Subagent traffic and meta notices are not part of what the user asked.
        if row.get("isSidechain").and_then(Value::as_bool) == Some(true) || row.get("isMeta").and_then(Value::as_bool) == Some(true) {
            continue;
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
                    if !prompt.trim().is_empty() {
                        turn = Turn { prompt, context_tokens: turn.context_tokens, ..Default::default() };
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
                for item in content.as_array().into_iter().flatten() {
                    match item.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            let t = item.get("text").and_then(Value::as_str).unwrap_or("").trim().to_string();
                            if !t.is_empty() {
                                turn.texts.push(t);
                            }
                        }
                        Some("tool_use") => turn.tools.push(ToolRun {
                            id: item.get("id").and_then(Value::as_str).unwrap_or("").into(),
                            name: item.get("name").and_then(Value::as_str).unwrap_or("").into(),
                            detail: tool_detail(item.get("input").unwrap_or(&Value::Null)),
                            error: None,
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
            r#"{"type":"assistant","message":{"usage":{"input_tokens":2,"cache_read_input_tokens":40000,"cache_creation_input_tokens":300},"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"npm test","description":"run"}}]}}"#,
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
        assert_eq!(t.tools[0].error.as_deref(), Some("Exit code 1\n2 tests failed"));
        assert_eq!(t.context_tokens, 40302);
    }
}
