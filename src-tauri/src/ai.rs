//! AI connections (spec 4.5): the list lives in `mygdeck.json` under "connections", API keys only in the OS keychain.
use crate::config::{self, Config};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const SERVICE: &str = "mygdeck";

#[derive(Serialize, Deserialize, Clone)]
pub struct Connection {
    pub id: String,
    pub name: String,
    /// "openai" (any OpenAI-compatible server: OpenAI, OpenRouter, Gemini...), "anthropic",
    /// or "search" (Tavily: web search for the question path, never a chat model).
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
    /// Free tier or a server on this machine: what the pool may use.
    pooled: bool,
}

fn is_chat_pool(c: &Connection) -> bool {
    c.kind != "search" && (c.free || is_local(c)) && !c.model.is_empty()
}

fn is_local(c: &Connection) -> bool {
    c.base_url.contains("://localhost") || c.base_url.contains("://127.0.0.1")
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
    conns(&read()).into_iter().map(|conn| Listed { has_key: has_key(&conn.id), pooled: is_chat_pool(&conn), conn }).collect()
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
    let c = read();
    let list: Vec<_> = conns(&c).into_iter().filter(|x| x.id != id).collect();
    write(c, &list)
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

/// The Claude subscription CLI as the last question connection (spec 4.5: existing subscriptions count as free).
/// Needs no setup: if `claude` is on PATH, questions work.
fn subscription_cli() -> Option<std::path::PathBuf> {
    crate::pty::find_program("claude")
}

/// One-shot `claude -p` on the cheapest model: no tools, MCP, settings or hooks, and no saved session,
/// run from the temp dir so it never shows up in a project's `--continue`.
fn ask_cli(exe: &std::path::Path, prompt: &str) -> Result<String, String> {
    use std::io::{Read, Write};
    use std::process::{Command, Stdio};
    let is_script = exe.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
    let mut c = if is_script {
        let mut c = Command::new("cmd.exe");
        c.args(["/d", "/c", "claude"]);
        c
    } else {
        Command::new(exe)
    };
    c.args(["-p", "--model", "haiku", "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--setting-sources", ""])
        .args(["--disable-slash-commands", "--append-system-prompt", SYSTEM])
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for v in crate::pty::INHERITED_SESSION_VARS {
        c.env_remove(v);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = c.spawn().map_err(|e| format!("실행 실패: {e}"))?;
    // The prompt goes through stdin: no quoting problems through cmd.exe, no length limit.
    child.stdin.take().map(|mut s| s.write_all(prompt.as_bytes()));
    let mut out = child.stdout.take().ok_or("출력 없음")?;
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        s
    });
    let deadline = Instant::now() + Duration::from_secs(90);
    let status = loop {
        if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
            break s;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            return Err("응답 시간 초과".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let text = reader.join().unwrap_or_default().trim().to_string();
    if !status.success() || text.is_empty() {
        let mut err = String::new();
        if let Some(mut e) = child.stderr.take() {
            let _ = e.read_to_string(&mut err);
        }
        let why = err.lines().chain(text.lines()).find(|l| !l.trim().is_empty()).unwrap_or("빈 응답").trim();
        return Err(why.chars().take(200).collect());
    }
    Ok(text)
}

/// The question paths can answer: a free connection with a model, or the subscription CLI.
#[tauri::command]
pub fn ai_ready() -> bool {
    conns(&read()).iter().any(is_chat_pool) || subscription_cli().is_some()
}

#[derive(Serialize)]
pub struct Source {
    title: String,
    url: String,
}

#[derive(Serialize)]
pub struct Answer {
    text: String,
    via: String,
    sources: Vec<Source>,
    searched: bool,
}

/// Tavily web search; Err((cooldown, message)) like `chat`, so the pool logic can treat a full quota the same way.
fn search(conn: &Connection, key: &str, query: &str) -> Result<Vec<(Source, String)>, (Duration, String)> {
    let body = json!({"query": query, "max_results": 5, "search_depth": "basic"});
    let mut res = agent()
        .post(format!("{}/search", conn.base_url.trim_end_matches('/')))
        .header("Authorization", format!("Bearer {key}"))
        .send_json(body)
        .map_err(|e| (Duration::from_secs(30), format!("검색 연결 실패: {e}")))?;
    match res.status().as_u16() {
        429 | 432 | 433 => return Err((Duration::from_secs(3600), "검색 한도 초과".into())),
        401 | 403 => return Err((Duration::from_secs(3600), "검색 키가 거부됨".into())),
        c if c >= 400 => return Err((Duration::from_secs(120), format!("검색 서버 응답 {c}"))),
        _ => {}
    }
    let v: Value = res.body_mut().read_json().map_err(|e| (Duration::from_secs(30), e.to_string()))?;
    Ok(v["results"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| {
            let url = r["url"].as_str().filter(|u| u.starts_with("http"))?;
            let title = r["title"].as_str().unwrap_or(url);
            let content: String = r["content"].as_str().unwrap_or("").chars().take(700).collect();
            Some((Source { title: title.into(), url: url.into() }, content))
        })
        .collect())
}

/// Question plus numbered findings; the model must answer from them and cite by number.
fn with_findings(prompt: &str, hits: &[(Source, String)]) -> String {
    let found: String = hits.iter().enumerate().map(|(i, (s, c))| format!("[{}] {}
{c}
", i + 1, s.title)).collect();
    format!("아래 웹 검색 결과만 근거로 질문에 답하세요. 근거가 되는 문장 끝에 [번호]를 붙이고, 결과에 없는 내용은 모른다고 답하세요.

검색 결과:
{found}
질문: {prompt}")
}

/// Cheap tasks go to the free connections (those with a key or local, and a model) in order; a full or failing one sits out.
#[tauri::command]
pub async fn ai_ask(prompt: String, search: bool) -> Result<Answer, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let all = conns(&read());
        let pool: Vec<_> = all.iter().filter(|c| is_chat_pool(c)).collect();
        let cli = subscription_cli();
        if pool.is_empty() && cli.is_none() {
            return Err("모델이 지정된 무료 연결이 없습니다. 🔑에서 추가하세요.".to_string());
        }
        // Web findings first, when asked and a search connection with a key is ready; a failure only means "answered without search".
        let mut hits = Vec::new();
        if search {
            for c in all.iter().filter(|c| c.kind == "search" && cooling(&c.id).is_none()) {
                let Some(key) = entry(&c.id).ok().and_then(|e| e.get_password().ok()) else { continue };
                match self::search(c, &key, &prompt.chars().take(400).collect::<String>()) {
                    Ok(h) => {
                        hits = h;
                        break;
                    }
                    Err((d, _)) => cool(&c.id, d),
                }
            }
        }
        let asked = if hits.is_empty() { prompt.clone() } else { with_findings(&prompt, &hits) };
        let sources = |h: Vec<(Source, String)>| h.into_iter().map(|(s, _)| s).collect::<Vec<_>>();
        let mut last = String::new();
        let mut soonest: Option<Duration> = None;
        for c in pool {
            if let Some(left) = cooling(&c.id) {
                soonest = Some(soonest.map_or(left, |s| s.min(left)));
                continue;
            }
            let key = entry(&c.id).ok().and_then(|e| e.get_password().ok());
            match chat(c, key.as_deref(), &asked) {
                Ok(text) => {
                    let searched = !hits.is_empty();
                    return Ok(Answer { text, via: c.name.clone(), sources: sources(hits), searched });
                }
                Err((d, why)) => {
                    cool(&c.id, d);
                    last = format!("{}: {why}", c.name);
                }
            }
        }
        // Free API connections first; the subscription last, since it shares the coding agent's quota.
        if let Some(exe) = cli {
            match ask_cli(&exe, &asked) {
                Ok(text) => {
                    let searched = !hits.is_empty();
                    return Ok(Answer { text, via: "Claude 구독 (haiku)".into(), sources: sources(hits), searched });
                }
                Err(why) => last = format!("Claude 구독: {why}"),
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
    if conn.kind == "search" {
        // One real query (costs one free credit): the only way to prove the key works.
        let n = search(&conn, key.as_deref().ok_or("키가 없습니다.")?, "tauri").map_err(|(_, m)| m)?.len();
        return Ok(format!("연결됨 · 검색 결과 {n}건"));
    }
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

    /// Real call on the subscription (spends a little quota): `cargo test -- --ignored subscription`.
    #[test]
    #[ignore]
    fn subscription_cli_answers() {
        let exe = subscription_cli().expect("claude on PATH");
        let a = ask_cli(&exe, "1+1은? 숫자만").unwrap();
        assert!(a.contains('2'), "{a}");
    }

    #[test]
    fn findings_are_numbered_into_the_prompt() {
        let hits = vec![(Source { title: "Doc".into(), url: "https://x.dev".into() }, "내용".to_string())];
        let p = with_findings("질문?", &hits);
        assert!(p.contains("[1] Doc") && p.contains("질문: 질문?"));
    }

    #[test]
    fn search_connections_stay_out_of_the_chat_pool() {
        let mk = |kind: &str| Connection { id: "t".into(), name: "t".into(), kind: kind.into(), base_url: "http://localhost:1".into(), model: "m".into(), free: true };
        assert!(is_chat_pool(&mk("openai")));
        assert!(!is_chat_pool(&mk("search")));
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
        let c: Config = serde_json::from_str(r#"{"projects":[],"connections":[{"id":"o","name":"Local","kind":"openai","base_url":"http://localhost:8080/v1","free":true}]}"#).unwrap();
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
