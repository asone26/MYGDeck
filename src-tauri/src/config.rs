//! `mygdeck.json`: project list restored on launch (spec 5.1). CLI path arguments override it.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Project {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec_file: Option<String>,
    /// Custom launch command, for agents without an adapter (e.g. `ssh host claude`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
pub struct Config {
    #[serde(default)]
    pub projects: Vec<Project>,
    /// Keys this version does not know about survive a save.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Serialize)]
pub struct Loaded {
    config: Config,
    source: String,
}

pub fn home() -> PathBuf {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_default()
}

fn expand(p: &str) -> String {
    match p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        Some(rest) => home().join(rest).to_string_lossy().into_owned(),
        None => p.to_string(),
    }
}

fn read(path: &PathBuf) -> Option<Config> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

#[tauri::command]
pub fn load_config() -> Loaded {
    let local = std::env::current_dir().unwrap_or_default().join("mygdeck.json");
    let source = if local.is_file() { local } else { home().join("mygdeck.json") };
    let mut config = read(&source).unwrap_or_default();
    // Only existing folders count: launchers such as `tauri dev` append their own flags and values.
    let args: Vec<String> = std::env::args().skip(1).map(|a| expand(&a)).filter(|a| std::path::Path::new(a).is_dir()).collect();
    if !args.is_empty() {
        config.projects = args.into_iter().map(|path| Project { path, ..Default::default() }).collect();
    }
    for p in &mut config.projects {
        p.path = expand(&p.path);
    }
    Loaded { config, source: source.to_string_lossy().into_owned() }
}

#[tauri::command]
pub fn save_config(source: String, projects: Vec<Project>) -> Result<(), String> {
    let path = PathBuf::from(&source);
    let mut config = read(&path).unwrap_or_default();
    config.projects = projects;
    let text = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_unknown_keys_and_expands_home() {
        let c: Config = serde_json::from_str(r#"{"projects":[{"path":"~/w/a","agent":"codex"}],"budget_usd_monthly":0}"#).unwrap();
        assert_eq!(c.projects[0].agent.as_deref(), Some("codex"));
        assert!(serde_json::to_string(&c).unwrap().contains("budget_usd_monthly"));
        assert!(expand("~/w/a").ends_with("a") && !expand("~/w/a").starts_with('~'));
        assert_eq!(expand("C:/x"), "C:/x");
    }
}
