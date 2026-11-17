//! Project file access, shell runner, search, and environment checks.
use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

const MAX_FILE: u64 = 2 << 20;
const MAX_FILES: usize = 20_000;

pub use crate::git::*;
pub use crate::worktree::*;

/// Join a frontend-supplied relative path, refusing anything that leaves the project root.
pub fn safe_join(root: &str, rel: &str) -> Result<PathBuf, String> {
    let p = Path::new(rel);
    if p.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
        return Err("path outside project".into());
    }
    Ok(Path::new(root).join(p))
}

#[derive(Serialize)]
pub struct Entry {
    name: String,
    dir: bool,
}

#[tauri::command]
pub fn list_dir(root: String, rel: String) -> Result<Vec<Entry>, String> {
    let dir = safe_join(&root, &rel)?;
    let mut out: Vec<Entry> = std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            (name != ".git").then(|| Entry { dir: e.file_type().map(|t| t.is_dir()).unwrap_or(false), name })
        })
        .collect();
    out.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

/// All project files for quick open: tracked + untracked-but-not-ignored, or a plain walk outside git.
#[tauri::command]
pub fn list_files(root: String) -> Vec<String> {
    if let Some(out) = git(&root, &["ls-files", "-co", "--exclude-standard", "-z"]) {
        return out.split('\0').filter(|s| !s.is_empty()).take(MAX_FILES).map(String::from).collect();
    }
    let mut out = Vec::new();
    let mut stack = vec![PathBuf::new()];
    while let Some(rel) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(Path::new(&root).join(&rel)) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if matches!(name.as_str(), ".git" | "node_modules" | "target" | "dist") {
                continue;
            }
            let child = rel.join(&name);
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                stack.push(child);
            } else if out.len() < MAX_FILES {
                out.push(child.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    out
}

#[tauri::command]
pub fn read_file(root: String, rel: String) -> Result<String, String> {
    let path = safe_join(&root, &rel)?;
    let len = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if len > MAX_FILE {
        return Err(format!("too large ({} KB)", len / 1024));
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.iter().take(8000).any(|b| *b == 0) {
        return Err("binary file".into());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[derive(Serialize)]
pub struct CmdResult {
    pub ok: bool,
    pub code: i32,
    pub output: String,
}

/// Run a project-configured shell command (worktree setup or post-turn verification) in `root`.
#[tauri::command]
pub fn run_shell_cmd(root: String, cmd: String) -> Result<CmdResult, String> {
    let trimmed = cmd.trim();
    if trimmed.is_empty() {
        return Err("empty command".into());
    }
    let mut command = if cfg!(windows) {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", trimmed]);
        c
    } else {
        let mut c = std::process::Command::new("sh");
        c.args(["-lc", trimmed]);
        c
    };
    let out = command.current_dir(&root).output().map_err(|e| e.to_string())?;
    let mut combined = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !stderr.is_empty() {
        if !combined.is_empty() && !combined.ends_with('\n') {
            combined.push('\n');
        }
        combined.push_str(&stderr);
    }
    // Keep only the tail so large test logs never bloat IPC.
    if combined.len() > 8192 {
        let mut start = combined.len() - 8192;
        while !combined.is_char_boundary(start) {
            start += 1;
        }
        combined = format!("…\n{}", &combined[start..]);
    }
    Ok(CmdResult {
        ok: out.status.success(),
        code: out.status.code().unwrap_or(-1),
        output: combined.trim().to_string(),
    })
}

#[derive(Serialize, Debug)]
pub struct SearchHit {
    pub path: String,
    pub line: u32,
    pub text: String,
}

/// Lightweight case-insensitive text search across project files (skips files > 512 KB and binary files).
#[tauri::command]
pub fn search_in_files(root: String, query: String) -> Vec<SearchHit> {
    let q = query.trim().to_lowercase();
    if q.len() < 2 {
        return vec![];
    }
    let mut hits = Vec::new();
    for rel in list_files(root.clone()) {
        let Ok(path) = safe_join(&root, &rel) else { continue };
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        if meta.len() > 512 * 1024 {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&path) else { continue };
        for (i, line) in content.lines().enumerate() {
            if line.to_lowercase().contains(&q) {
                hits.push(SearchHit {
                    path: rel.clone(),
                    line: (i + 1) as u32,
                    text: line.trim().chars().take(120).collect(),
                });
                if hits.len() >= 50 {
                    return hits;
                }
            }
        }
    }
    hits
}

#[derive(Serialize)]
pub struct Spec {
    name: String,
    content: String,
}

#[tauri::command]
pub fn read_spec(root: String, preferred: Option<String>) -> Option<Spec> {
    let candidates = preferred.into_iter().chain(["MASTER_SPEC.md", "master.md", "CLAUDE.md", "README.md"].map(String::from));
    for name in candidates {
        if let Ok(content) = read_file(root.clone(), name.clone()) {
            return Some(Spec { name, content });
        }
    }
    None
}

/// Save a pasted image to the temp folder and return its path, so any agent can read it as a file.
/// shortcut: bytes arrive as a JSON number array, fine for screenshots; use a raw IPC body if big images get slow.
#[tauri::command]
pub fn save_paste(bytes: Vec<u8>, ext: String) -> Result<String, String> {
    if ext.is_empty() || ext.len() > 5 || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("bad image type".into());
    }
    let dir = std::env::temp_dir().join("mygdeck-paste");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis();
    let path = dir.join(format!("paste-{ms}.{ext}"));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Open a project file with the OS default app (HTML → browser), like a double-click in Explorer.
#[tauri::command]
pub fn open_file(root: String, rel: String) -> Result<(), String> {
    tauri_plugin_opener::open_path(safe_join(&root, &rel)?, None::<&str>).map_err(|e| e.to_string())
}

/// Rename a file or folder in place. `name` is a bare name: no folders, never the project root itself.
#[tauri::command]
pub fn rename_file(root: String, rel: String, name: String) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
        return Err("쓸 수 없는 이름입니다".into());
    }
    if !Path::new(&rel).components().any(|c| matches!(c, Component::Normal(_))) {
        return Err("path outside project".into());
    }
    let from = safe_join(&root, &rel)?;
    let to = from.parent().ok_or("path outside project")?.join(name);
    // Windows paths ignore case, so a case-only rename "exists" already: allow that one.
    let same = from.file_name().is_some_and(|f| f.to_string_lossy().eq_ignore_ascii_case(name));
    if to.exists() && !same {
        return Err("같은 이름이 이미 있습니다".into());
    }
    std::fs::rename(&from, &to).map_err(|e| e.to_string())
}

fn b64_encode(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

/// Read an image file as a base64 data URL for the viewer preview.
#[tauri::command]
pub fn read_file_base64(root: String, rel: String) -> Result<String, String> {
    let path = safe_join(&root, &rel)?;
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_FILE {
        return Err("파일이 너무 큽니다 (2MB 초과)".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        _ => "application/octet-stream",
    };
    Ok(format!("data:{mime};base64,{}", b64_encode(&bytes)))
}

/// Create an empty file or directory inside the project.
#[tauri::command]
pub fn create_file(root: String, rel: String, is_dir: bool) -> Result<(), String> {
    let rel = rel.trim().trim_start_matches(['/', '\\']);
    if rel.is_empty() || rel.split(['/', '\\']).any(|s| s == ".git" || s == "." || s == "..") {
        return Err("만들 수 없는 경로입니다".into());
    }
    let path = safe_join(&root, rel)?;
    if path.exists() {
        return Err("같은 이름이 이미 있습니다".into());
    }
    if is_dir {
        std::fs::create_dir_all(&path).map_err(|e| e.to_string())
    } else {
        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, "").map_err(|e| e.to_string())
    }
}

/// Delete a file or folder inside the project (refuses root and `.git`).
#[tauri::command]
pub fn delete_file(root: String, rel: String) -> Result<(), String> {
    if !Path::new(&rel).components().any(|c| matches!(c, Component::Normal(_)))
        || rel.split(['/', '\\']).any(|s| s == ".git")
    {
        return Err("삭제할 수 없는 경로입니다".into());
    }
    let path = safe_join(&root, &rel)?;
    if path.is_dir() {
        std::fs::remove_dir_all(&path).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(&path).map_err(|e| e.to_string())
    }
}

/// Reveal a file or folder in the OS file manager.
#[tauri::command]
pub fn reveal_in_os(root: String, rel: String) -> Result<(), String> {
    let path = safe_join(&root, &rel)?;
    #[cfg(target_os = "windows")]
    {
        let arg = format!("/select,{}", path.to_string_lossy().replace('/', "\\"));
        Command::new("explorer").arg(arg).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").args(["-R", &path.to_string_lossy()]).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = if path.is_dir() { path.as_path() } else { path.parent().unwrap_or(path.as_path()) };
        Command::new("xdg-open").arg(dir).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_project_scripts(root: String) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(Path::new(&root).join("package.json")) else {
        return vec![];
    };
    let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) else {
        return vec![];
    };
    val.get("scripts")
        .and_then(|s| s.as_object())
        .map(|m| m.keys().take(8).cloned().collect())
        .unwrap_or_default()
}

#[derive(Serialize)]
pub struct DoctorItem {
    name: String,
    ok: bool,
    detail: String,
}

#[tauri::command]
pub fn doctor_check() -> Vec<DoctorItem> {
    let tools = [("git", "--version"), ("gh", "--version"), ("claude", "--version"), ("codex", "--version"), ("gemini", "--version")];
    tools
        .iter()
        .map(|(bin, flag)| {
            let mut c = Command::new(bin);
            c.arg(flag);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                c.creation_flags(0x0800_0000);
            }
            match c.output() {
                Ok(out) if out.status.success() => {
                    let line = String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or("설치됨").trim().to_string();
                    DoctorItem { name: (*bin).into(), ok: true, detail: line }
                }
                _ => DoctorItem { name: (*bin).into(), ok: false, detail: "설치되지 않았거나 PATH에 없음".into() },
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rename_stays_in_place_and_refuses_bad_names() {
        let dir = std::env::temp_dir().join(format!("mygdeck-rename-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub/a.txt"), "x").unwrap();
        std::fs::write(dir.join("sub/b.txt"), "y").unwrap();
        let root = dir.to_string_lossy().to_string();
        let r = |rel: &str, name: &str| rename_file(root.clone(), rel.into(), name.into());
        assert!(r("sub/a.txt", "../evil.txt").is_err());
        assert!(r("sub/a.txt", "b.txt").is_err()); // would overwrite
        assert!(r("", "x").is_err()); // the project root itself
        assert!(r("../x", "y").is_err());
        r("sub/a.txt", "c.txt").unwrap();
        assert!(dir.join("sub/c.txt").is_file() && !dir.join("sub/a.txt").exists());
        r("sub/c.txt", "C.txt").unwrap(); // case-only rename
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rejects_escaping_paths() {
        assert!(safe_join("/p", "../etc/passwd").is_err());
        assert!(safe_join("/p", "/etc/passwd").is_err());
        assert!(safe_join("/p", "src/../../x").is_err());
        assert!(safe_join("/p", "src/main.rs").is_ok());
    }

    #[test]
    fn creates_deletes_and_reads_base64_safely() {
        assert_eq!(b64_encode(b"Man"), "TWFu");
        assert_eq!(b64_encode(b"Ma"), "TWE=");
        assert_eq!(b64_encode(b"M"), "TQ==");

        let dir = std::env::temp_dir().join(format!("mygdeck-fsops-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().to_string();

        assert!(create_file(root.clone(), ".git/hook".into(), false).is_err());
        assert!(create_file(root.clone(), "../evil.txt".into(), false).is_err());
        create_file(root.clone(), "sub/img.png".into(), false).unwrap();
        std::fs::write(dir.join("sub/img.png"), [137u8, 80, 78, 71]).unwrap();
        let url = read_file_base64(root.clone(), "sub/img.png".into()).unwrap();
        assert!(url.starts_with("data:image/png;base64,"));

        assert!(delete_file(root.clone(), ".git".into()).is_err());
        assert!(delete_file(root.clone(), "".into()).is_err());
        delete_file(root.clone(), "sub/img.png".into()).unwrap();
        assert!(!dir.join("sub/img.png").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
