//! Read-only project file access for the explorer, code viewer and spec viewer.
use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

const MAX_FILE: u64 = 2 << 20;
const MAX_FILES: usize = 20_000;

fn git(root: &str, args: &[&str]) -> Option<String> {
    let mut c = Command::new("git");
    c.args(args).current_dir(root);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = c.output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

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

#[derive(Serialize, Debug, PartialEq)]
pub struct FileStatus {
    path: String,
    code: char,
}

#[tauri::command]
pub fn git_status(root: String) -> Vec<FileStatus> {
    git(&root, &["status", "--porcelain=v1", "-z", "--untracked-files=all"])
        .map(|s| parse_status(&s))
        .unwrap_or_default()
}

/// Parse `git status --porcelain=v1 -z` into A (added/untracked), M (modified), D (deleted).
pub fn parse_status(z: &str) -> Vec<FileStatus> {
    let mut out = Vec::new();
    let mut parts = z.split('\0');
    while let Some(e) = parts.next() {
        if e.len() < 4 {
            continue;
        }
        let xy = &e[..2];
        if xy.starts_with('R') || xy.starts_with('C') {
            parts.next(); // original path of a rename/copy
        }
        let code = if xy.contains('D') {
            'D'
        } else if xy == "??" || xy.contains('A') {
            'A'
        } else {
            'M'
        };
        out.push(FileStatus { path: e[3..].to_string(), code });
        if out.len() >= 2000 {
            break;
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
pub struct Changed {
    all: bool,
    lines: Vec<u32>,
}

/// Lines changed against HEAD, for the viewer gutter. New files are marked entirely.
#[tauri::command]
pub fn changed_lines(root: String, rel: String) -> Result<Changed, String> {
    safe_join(&root, &rel)?;
    let st = git(&root, &["status", "--porcelain=v1", "-z", "--", &rel]).unwrap_or_default();
    if parse_status(&st).iter().any(|s| s.code == 'A') {
        return Ok(Changed { all: true, lines: vec![] });
    }
    let diff = git(&root, &["diff", "-U0", "HEAD", "--", &rel])
        .or_else(|| git(&root, &["diff", "-U0", "--", &rel]))
        .unwrap_or_default();
    Ok(Changed { all: false, lines: parse_hunks(&diff) })
}

/// New-side line numbers from `@@ -a,b +c,d @@` hunk headers.
pub fn parse_hunks(diff: &str) -> Vec<u32> {
    let mut out = Vec::new();
    for line in diff.lines().filter(|l| l.starts_with("@@")) {
        let Some(plus) = line.split(' ').find(|p| p.starts_with('+')) else { continue };
        let mut nums = plus[1..].split(',');
        let start: u32 = nums.next().and_then(|n| n.parse().ok()).unwrap_or(0);
        let count: u32 = nums.next().and_then(|n| n.parse().ok()).unwrap_or(1);
        out.extend(start..start + count);
    }
    out
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_escaping_paths() {
        assert!(safe_join("/p", "../etc/passwd").is_err());
        assert!(safe_join("/p", "/etc/passwd").is_err());
        assert!(safe_join("/p", "src/../../x").is_err());
        assert!(safe_join("/p", "src/main.rs").is_ok());
    }

    #[test]
    fn parses_porcelain_status() {
        let z = " M src/a.rs\0?? new.txt\0D  gone.rs\0R  b.rs\0old.rs\0A  added.rs\0";
        let codes: Vec<(String, char)> = parse_status(z).into_iter().map(|s| (s.path, s.code)).collect();
        assert_eq!(
            codes,
            [("src/a.rs", 'M'), ("new.txt", 'A'), ("gone.rs", 'D'), ("b.rs", 'M'), ("added.rs", 'A')]
                .map(|(p, c)| (p.to_string(), c))
        );
    }

    #[test]
    fn parses_hunk_headers() {
        let d = "@@ -1,2 +1,3 @@ fn x\n+a\n@@ -10 +12 @@\n@@ -20,3 +25,0 @@\n";
        assert_eq!(parse_hunks(d), vec![1, 2, 3, 12]);
    }
}
