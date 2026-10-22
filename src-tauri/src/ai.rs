//! AI connections (spec 4.5): the list lives in `mygdeck.json` under "connections", API keys only in the OS keychain.
use crate::config::{self, Config};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const SERVICE: &str = "mygdeck";
const OLLAMA: &str = "ollama";
const OLLAMA_URL: &str = "http://localhost:11434";

#[derive(Serialize, Deserialize, Clone)]
pub struct Connection {
    pub id: String,
    pub name: String,
    /// "openai" (any OpenAI-compatible server: OpenAI, Ollama, OpenRouter, Gemini...) or "anthropic".
    pub kind: String,
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    /// Free tier or local: the router tries these first.
    #[serde(default)]
    pub free: bool,
}

#[derive(Serialize)]
pub struct Listed {
    #[serde(flatten)]
    conn: Connection,
    has_key: bool,
}

fn entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, id).map_err(|e| e.to_string())
}

fn has_key(id: &str) -> bool {
    entry(id).and_then(|e| e.get_password().map_err(|e| e.to_string())).is_ok()
}

fn read() -> Config {
    std::fs::read_to_string(config::source_path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn conns(c: &Config) -> Vec<Connection> {
    c.extra.get("connections").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default()
}

fn write(mut c: Config, list: &[Connection]) -> Result<(), String> {
    c.extra.insert("connections".into(), serde_json::to_value(list).map_err(|e| e.to_string())?);
    let text = serde_json::to_string_pretty(&c).map_err(|e| e.to_string())?;
    std::fs::write(config::source_path(), text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ai_list() -> Vec<Listed> {
    conns(&read()).into_iter().map(|conn| Listed { has_key: has_key(&conn.id), conn }).collect()
}

/// Adds or updates a connection. `key` None keeps the stored key; an empty string removes it.
#[tauri::command]
pub fn ai_save(conn: Connection, key: Option<String>) -> Result<(), String> {
    if conn.id.trim().is_empty() || conn.base_url.trim().is_empty() {
        return Err("이름과 주소를 입력하세요.".into());
    }
    match key.as_deref() {
        Some("") => {
            let _ = entry(&conn.id)?.delete_credential();
        }
        Some(k) => entry(&conn.id)?.set_password(k).map_err(|e| e.to_string())?,
        None => {}
    }
    let c = read();
    let mut list = conns(&c);
    match list.iter_mut().find(|x| x.id == conn.id) {
        Some(x) => *x = conn,
        None => list.push(conn),
    }
    write(c, &list)
}

#[tauri::command]
pub fn ai_delete(id: String) -> Result<(), String> {
    let _ = entry(&id)?.delete_credential();
    let mut c = read();
    // A removed local connection must not come back at the next start.
    if id == OLLAMA {
        c.extra.insert("ollama_ignored".into(), Value::Bool(true));
    }
    let list: Vec<_> = conns(&c).into_iter().filter(|x| x.id != id).collect();
    write(c, &list)
}

/// Korean-strong models first, embedding models never.
fn pick_model(names: &[String]) -> Option<String> {
    let chat: Vec<_> = names.iter().filter(|n| !n.contains("embed")).collect();
    ["exaone", "gemma", "qwen"].iter().find_map(|p| chat.iter().find(|n| n.starts_with(p))).or(chat.first()).map(|n| n.to_string())
}

/// App start: a running local Ollama becomes a free connection without any setup (spec 4.5). Returns true when one was added.
#[tauri::command]
pub async fn ai_detect() -> bool {
    tauri::async_runtime::spawn_blocking(|| {
        let c = read();
        if c.extra.get("ollama_ignored") == Some(&Value::Bool(true)) || conns(&c).iter().any(|x| x.base_url.contains(":11434")) {
            return false;
        }
        let agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(2))).build().into();
        let tags: Value = match ureq::Agent::get(&agent, format!("{OLLAMA_URL}/api/tags")).call().and_then(|mut r| r.body_mut().read_json()) {
            Ok(v) => v,
            Err(_) => return false,
        };
        let names: Vec<String> = tags["models"].as_array().into_iter().flatten().filter_map(|m| m["name"].as_str().map(String::from)).collect();
        let Some(model) = pick_model(&names) else { return false };
        let mut list = conns(&c);
        list.push(Connection { id: OLLAMA.into(), name: "Ollama".into(), kind: "openai".into(), base_url: format!("{OLLAMA_URL}/v1"), model, free: true });
        write(c, &list).is_ok()
    })
    .await
    .unwrap_or(false)
}

/// Connections that hit a limit or rejected the key sit out until this time (spec 4.5: spill over to the next free one).
static COOLDOWN: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);

fn cooling(id: &str) -> Option<Duration> {
    let g = COOLDOWN.lock().ok()?;
    g.as_ref()?.get(id)?.checked_duration_since(Instant::now())
}

fn cool(id: &str, d: Duration) {
    if let Ok(mut g) = COOLDOWN.lock() {
        g.get_or_insert_with(HashMap::new).insert(id.into(), Instant::now() + d);
    }
}

const SYSTEM: &str = "결론부터 한국어로 짧게 답하세요. 서론·광고 문구 없이, 코드가 필요하면 복사 가능한 코드 블록만 덧붙이세요.";

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(Duration::from_secs(45))).build().into()
}

/// One chat call. Err((cooldown, message)): the pool moves on to the next connection.
fn chat(conn: &Connection, key: Option<&str>, prompt: &str) -> Result<String, (Duration, String)> {
    let base = conn.base_url.trim_end_matches('/');
    let anthropic = conn.kind == "anthropic";
    let sent = if anthropic {
        let body = json!({"model": conn.model, "max_tokens": 1024, "system": SYSTEM, "messages": [{"role": "user", "content": prompt}]});
        agent().post(format!("{base}/messages")).header("x-api-key", key.unwrap_or("")).header("anthropic-version", "2023-06-01").send_json(body)
    } else {
        let body = json!({"model": conn.model, "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt}]});
        let mut req = agent().post(format!("{base}/chat/completions"));
        if let Some(k) = key {
            req = req.header("Authorization", format!("Bearer {k}"));
        }
        req.send_json(body)
    };
    let mut res = sent.map_err(|e| (Duration::from_secs(30), format!("연결 실패: {e}")))?;
    let code = res.status().as_u16();
    if code == 429 {
        // Provider's own wait if it says so, else a minute.
        let wait = res.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok()).unwrap_or(60);
        return Err((Duration::from_secs(wait), "한도 초과".into()));
    }
    if code == 401 || code == 403 {
        return Err((Duration::from_secs(3600), "키가 거부됨".into()));
    }
    if code >= 400 {
        return Err((Duration::from_secs(120), format!("서버 응답 {code}")));
    }
    let v: Value = res.body_mut().read_json().map_err(|e| (Duration::from_secs(30), e.to_string()))?;
    let text = if anthropic { v.pointer("/content/0/text") } else { v.pointer("/choices/0/message/content") };
    text.and_then(Value::as_str).map(str::to_string).ok_or((Duration::from_secs(30), "빈 응답".into()))
}

#[derive(Serialize)]
pub struct Answer {
    text: String,
    via: String,
}

/// Cheap tasks go to the free connections (those with a key or local, and a model) in order; a full or failing one sits out.
#[tauri::command]
pub async fn ai_ask(prompt: String) -> Result<Answer, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let pool: Vec<_> = conns(&read()).into_iter().filter(|c| c.free && !c.model.is_empty()).collect();
        if pool.is_empty() {
            return Err("모델이 지정된 무료 연결이 없습니다. 🔑에서 추가하세요.".to_string());
        }
        let mut last = String::new();
        let mut soonest: Option<Duration> = None;
        for c in pool {
            if let Some(left) = cooling(&c.id) {
                soonest = Some(soonest.map_or(left, |s| s.min(left)));
                continue;
            }
            let key = entry(&c.id).ok().and_then(|e| e.get_password().ok());
            match chat(&c, key.as_deref(), &prompt) {
                Ok(text) => return Ok(Answer { text, via: c.name }),
                Err((d, why)) => {
                    cool(&c.id, d);
                    last = format!("{}: {why}", c.name);
                }
            }
        }
        match soonest {
            Some(s) if last.is_empty() => Err(format!("모든 무료 연결의 한도가 찼습니다. 약 {}초 뒤 다시 쓸 수 있습니다.", s.as_secs())),
            _ => Err(format!("모든 무료 연결이 실패했습니다 ({last})")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Lists models with the stored key: proves the address and key work without spending tokens.
#[tauri::command]
pub async fn ai_test(id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || test(id)).await.map_err(|e| e.to_string())?
}

fn test(id: String) -> Result<String, String> {
    let conn = conns(&read()).into_iter().find(|x| x.id == id).ok_or("연결을 찾을 수 없습니다.")?;
    let key = entry(&id)?.get_password().ok();
    let url = format!("{}/models", conn.base_url.trim_end_matches('/'));
    let mut req = ureq::get(&url);
    match (conn.kind.as_str(), &key) {
        ("anthropic", Some(k)) => req = req.header("x-api-key", k).header("anthropic-version", "2023-06-01"),
        (_, Some(k)) => req = req.header("Authorization", format!("Bearer {k}")),
        _ => {}
    }
    let mut res = req.call().map_err(|e| match e {
        ureq::Error::StatusCode(401 | 403) => "키가 거부되었습니다 (401/403).".to_string(),
        ureq::Error::StatusCode(c) => format!("서버 응답 {c}"),
        e => format!("연결 실패: {e}"),
    })?;
    let body: Value = res.body_mut().read_json().map_err(|e| e.to_string())?;
    let n = body.get("data").or_else(|| body.get("models")).and_then(Value::as_array).map_or(0, Vec::len);
    Ok(format!("연결됨 · 모델 {n}개"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_korean_strong_chat_model() {
        let n = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(pick_model(&n(&["nomic-embed-text", "qwen2.5:3b", "exaone3.5:7.8b"])).as_deref(), Some("exaone3.5:7.8b"));
        assert_eq!(pick_model(&n(&["llama3.2:3b"])).as_deref(), Some("llama3.2:3b"));
        assert_eq!(pick_model(&n(&["nomic-embed-text"])), None);
    }

    #[test]
    fn cooldown_skips_a_connection_until_it_expires() {
        cool("t-cool", Duration::from_secs(60));
        assert!(cooling("t-cool").is_some());
        cool("t-cool", Duration::ZERO);
        assert!(cooling("t-cool").is_none());
    }

    #[test]
    fn connections_round_trip_through_extra() {
        let c: Config = serde_json::from_str(r#"{"projects":[],"connections":[{"id":"o","name":"Ollama","kind":"openai","base_url":"http://localhost:11434/v1","free":true}]}"#).unwrap();
        let l = conns(&c);
        assert_eq!(l[0].id, "o");
        assert!(l[0].free && l[0].model.is_empty());
    }

    #[test]
    fn key_round_trips_through_the_os_keychain() {
        let id = "mygdeck-test-key";
        entry(id).unwrap().set_password("sk-test").unwrap();
        assert!(has_key(id));
        assert_eq!(entry(id).unwrap().get_password().unwrap(), "sk-test");
        entry(id).unwrap().delete_credential().unwrap();
        assert!(!has_key(id));
    }
}
