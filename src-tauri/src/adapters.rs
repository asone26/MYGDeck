//! Agent adapters are plain TOML data files (spec 5.3): built-ins plus `~/.mygdeck/adapters/*.toml`.
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Adapter {
    pub name: String,
    pub launch: String,
    #[serde(default)]
    pub hook_args: String,
    #[serde(default = "default_mention")]
    pub mention: String,
    #[serde(default)]
    pub model_cmd: String,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub clear_cmd: String,
    /// Context window in tokens; with hooks the deck rotates the session at 70% of it (spec 4.4). 0 = unknown.
    #[serde(default)]
    pub context_limit: u64,
    /// Keys that stop the agent's current work without quitting it (Esc for most agent CLIs).
    #[serde(default = "default_interrupt")]
    pub interrupt: String,
    #[serde(default)]
    pub commands: Vec<String>,
    /// "hooks" when the agent reports its state through hooks, otherwise "idle" (output-silence guess).
    #[serde(default = "default_status")]
    pub status: String,
    #[serde(default)]
    pub detected: bool,
}

fn default_mention() -> String {
    "@{path}".into()
}
fn default_interrupt() -> String {
    "\u{1b}".into()
}
fn default_status() -> String {
    "idle".into()
}

const BUILTIN: [&str; 3] = [
    include_str!("../adapters/claude-code.toml"),
    include_str!("../adapters/codex.toml"),
    include_str!("../adapters/gemini.toml"),
];

#[tauri::command]
pub fn list_adapters() -> Vec<Adapter> {
    let mut list: Vec<Adapter> = BUILTIN.iter().filter_map(|s| toml::from_str(s).ok()).collect();
    let user_dir = crate::config::home().join(".mygdeck").join("adapters");
    for entry in std::fs::read_dir(user_dir).into_iter().flatten().flatten() {
        let Ok(text) = std::fs::read_to_string(entry.path()) else { continue };
        let Ok(a) = toml::from_str::<Adapter>(&text) else { continue };
        list.retain(|x| x.name != a.name);
        list.push(a);
    }
    for a in &mut list {
        let prog = crate::pty::split_command(&a.launch).into_iter().next().unwrap_or_default();
        a.detected = !prog.is_empty() && crate::pty::find_program(&prog).is_some();
    }
    list
}

#[cfg(test)]
mod tests {
    #[test]
    fn builtin_adapters_parse() {
        for src in super::BUILTIN {
            let a: super::Adapter = toml::from_str(src).expect("adapter toml");
            assert!(!a.launch.is_empty(), "{}", a.name);
        }
    }
}
