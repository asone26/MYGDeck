use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct Watchers(Mutex<HashMap<String, RecommendedWatcher>>);

/// `.git` is ignored on purpose: running `git status` touches the index and would loop forever.
fn ignored(p: &Path) -> bool {
    p.components().any(|c| matches!(c.as_os_str().to_str(), Some(".git" | "node_modules" | "target")))
}

#[tauri::command]
pub fn watch_project(app: AppHandle, watchers: State<Watchers>, id: String, root: String) -> Result<(), String> {
    let event_id = id.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        if let Ok(ev) = res {
            if !ev.paths.iter().all(|p| ignored(p)) {
                let _ = app.emit("fs-change", &event_id);
            }
        }
    })
    .map_err(|e| e.to_string())?;
    watcher.watch(Path::new(&root), RecursiveMode::Recursive).map_err(|e| e.to_string())?;
    watchers.0.lock().unwrap().insert(id, watcher);
    Ok(())
}

#[tauri::command]
pub fn unwatch_project(watchers: State<Watchers>, id: String) {
    watchers.0.lock().unwrap().remove(&id);
}
