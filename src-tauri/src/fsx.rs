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

/// Like `git()`, but keeps git's own message for the user when it fails.
fn run_git(root: &str, args: &[&str]) -> Result<String, String> {
    let mut c = Command::new("git");
    c.args(args).current_dir(root);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    let out = c.output().map_err(|e| e.to_string())?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if out.status.success() { Ok(text) } else { Err(text.trim().to_string()) }
}

/// Diff of tracked changes, the input for an auto commit message (empty before the first commit).
#[tauri::command]
pub fn git_diff(root: String) -> String {
    run_git(&root, &["diff", "HEAD"]).unwrap_or_default()
}

/// True when the last commit has `rel` as a file (false before the first commit).
fn in_head(root: &str, rel: &str) -> bool {
    git(root, &["--literal-pathspecs", "cat-file", "-t", &format!("HEAD:{rel}")]).is_some_and(|t| t.trim() == "blob")
}

#[derive(Serialize)]
pub struct FileDiff {
    diff: String,
    /// Not known to git yet: there is no diff, the whole file is new.
    untracked: bool,
}

/// One file's changes against the last commit, for the review view in the code viewer.
#[tauri::command]
pub fn file_diff(root: String, rel: String) -> Result<FileDiff, String> {
    let path = safe_join(&root, &rel)?;
    let diff = git(&root, &["--literal-pathspecs", "diff", "HEAD", "--", &rel])
        .or_else(|| git(&root, &["--literal-pathspecs", "diff", "--", &rel]))
        .unwrap_or_default();
    let untracked = diff.is_empty()
        && path.is_file()
        && git(&root, &["--literal-pathspecs", "ls-files", "--", &rel]).is_some_and(|s| s.trim().is_empty());
    Ok(FileDiff { diff, untracked })
}

/// "되돌리기": put one file back to the last commit. A file the last commit doesn't have is deleted.
#[tauri::command]
pub fn git_discard(root: String, rel: String) -> Result<(), String> {
    let path = safe_join(&root, &rel)?;
    if rel.trim_matches(|c| c == '/' || c == '.').is_empty() || path.is_dir() {
        return Err("not a file".into());
    }
    if in_head(&root, &rel) {
        return run_git(&root, &["--literal-pathspecs", "restore", "--source=HEAD", "--staged", "--worktree", "--", &rel]).map(|_| ());
    }
    let _ = git(&root, &["--literal-pathspecs", "rm", "--cached", "-q", "--ignore-unmatch", "--", &rel]);
    if path.is_file() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// "커밋": commit every change (untracked files too).
#[tauri::command]
pub fn git_save(root: String, message: String) -> Result<String, String> {
    run_git(&root, &["add", "-A"])?;
    run_git(&root, &["commit", "-m", &message])
}

/// "푸시": push; a branch without upstream gets one on origin.
#[tauri::command]
pub fn git_push(root: String) -> Result<String, String> {
    run_git(&root, &["push"]).or_else(|e| {
        if e.contains("upstream") { run_git(&root, &["push", "-u", "origin", "HEAD"]) } else { Err(e) }
    })
}

/// Commits on HEAD that no remote has yet (0 when there is no remote), to light up "푸시".
#[tauri::command]
pub fn git_ahead(root: String) -> u32 {
    if git(&root, &["remote"]).map_or(true, |r| r.trim().is_empty()) {
        return 0;
    }
    git(&root, &["rev-list", "--count", "HEAD", "--not", "--remotes"]).and_then(|s| s.trim().parse().ok()).unwrap_or(0)
}

/// Lines added and removed since HEAD, for the card header (B5). None before the first commit.
#[derive(Serialize, Debug, PartialEq)]
pub struct DiffStat {
    pub files: u32,
    pub added: u32,
    pub removed: u32,
}

/// Parse `git diff --shortstat`: " 3 files changed, 10 insertions(+), 2 deletions(-)".
pub fn parse_shortstat(s: &str) -> DiffStat {
    let num = |key: &str| {
        s.split(',').find(|p| p.contains(key)).and_then(|p| p.split_whitespace().next()).and_then(|n| n.parse().ok()).unwrap_or(0)
    };
    DiffStat { files: num("changed"), added: num("insertion"), removed: num("deletion") }
}

#[tauri::command]
pub fn git_shortstat(root: String) -> Option<DiffStat> {
    git(&root, &["diff", "--shortstat", "HEAD"]).map(|s| parse_shortstat(&s))
}

/// "worktree로 하나 더 열기" (B4): a sibling folder `<repo>-wtN` on a new branch `mygdeck/wtN` from
/// HEAD, so a second agent works on the same project without touching the first one's files.
#[tauri::command]
pub fn git_worktree_add(root: String) -> Result<String, String> {
    let top = run_git(&root, &["rev-parse", "--show-toplevel"]).map_err(|_| "git 저장소가 아닙니다".to_string())?;
    let top = PathBuf::from(top.trim());
    let name = top.file_name().map(|n| n.to_string_lossy().into_owned()).ok_or("저장소 이름을 알 수 없습니다")?;
    let parent = top.parent().ok_or("상위 폴더가 없습니다")?;
    let repo = top.to_string_lossy().into_owned();
    for n in 2..100 {
        let dir = parent.join(format!("{name}-wt{n}"));
        let branch = format!("mygdeck/wt{n}");
        if dir.exists() || git(&repo, &["rev-parse", "--verify", "--quiet", &branch]).is_some() {
            continue;
        }
        let path = dir.to_string_lossy().replace('\\', "/");
        run_git(&repo, &["worktree", "add", "-q", "-b", &branch, &path, "HEAD"])?;
        return Ok(path);
    }
    Err("worktree 이름을 정하지 못했습니다".into())
}

/// A deck worktree's branch (`mygdeck/wtN`) and the main working folder it came from.
fn worktree_origin(root: &str) -> Result<(String, String), String> {
    let branch = run_git(root, &["rev-parse", "--abbrev-ref", "HEAD"]).map_err(|_| "git 저장소가 아닙니다".to_string())?;
    let branch = branch.trim().to_string();
    if !branch.starts_with("mygdeck/wt") {
        return Err("덱이 만든 worktree가 아닙니다".into());
    }
    let list = run_git(root, &["worktree", "list", "--porcelain"])?;
    let main = list.lines().next().and_then(|l| l.strip_prefix("worktree ")).ok_or("원래 폴더를 찾지 못했습니다")?;
    Ok((branch, main.to_string()))
}

/// "원래 폴더에 합치기": merge the worktree's saved commits into the main folder's current branch.
/// Uncommitted work and conflicts are refused, never half-merged.
#[tauri::command]
pub fn git_worktree_merge(root: String) -> Result<(), String> {
    let (branch, main) = worktree_origin(&root)?;
    if !run_git(&root, &["status", "--porcelain"])?.trim().is_empty() {
        return Err("저장점(커밋)으로 만들지 않은 변경이 있습니다. 에이전트에게 커밋을 먼저 부탁하세요.".into());
    }
    if let Err(e) = run_git(&main, &["merge", "--no-edit", &branch]) {
        let _ = git(&main, &["merge", "--abort"]);
        return Err(format!("원래 폴더의 변경과 겹쳐서 합치지 않았습니다.\n\n{e}"));
    }
    Ok(())
}

/// "worktree 버리기": remove the folder; the branch goes too unless it holds unmerged commits.
/// Returns whether the branch was deleted. Uncommitted changes are refused.
#[tauri::command]
pub fn git_worktree_remove(root: String) -> Result<bool, String> {
    let (branch, main) = worktree_origin(&root)?;
    run_git(&main, &["worktree", "remove", &root]).map_err(|e| format!("worktree를 지우지 못했습니다(커밋하지 않은 변경이 있으면 지우지 않습니다).\n\n{e}"))?;
    Ok(git(&main, &["branch", "-d", &branch]).is_some())
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
    fn shortstat_and_worktree() {
        assert_eq!(parse_shortstat(" 3 files changed, 10 insertions(+), 2 deletions(-)\n"), DiffStat { files: 3, added: 10, removed: 2 });
        assert_eq!(parse_shortstat(" 1 file changed, 1 deletion(-)"), DiffStat { files: 1, added: 0, removed: 1 });
        assert_eq!(parse_shortstat(""), DiffStat { files: 0, added: 0, removed: 0 });

        let base = std::env::temp_dir().join(format!("mygdeck-wt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let dir = base.join("proj");
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().to_string();
        let g = |args: &[&str]| run_git(&root, args).unwrap();
        g(&["init", "-q"]);
        g(&["config", "user.email", "t@t"]);
        g(&["config", "user.name", "t"]);
        std::fs::write(dir.join("a.txt"), "v1\n").unwrap();
        git_save(root.clone(), "first".into()).unwrap();
        std::fs::write(dir.join("a.txt"), "v2\nv3\n").unwrap();
        assert_eq!(git_shortstat(root.clone()), Some(DiffStat { files: 1, added: 2, removed: 1 }));
        let wt = git_worktree_add(root.clone()).unwrap();
        assert!(wt.ends_with("proj-wt2"), "{wt}");
        assert_eq!(std::fs::read_to_string(format!("{wt}/a.txt")).unwrap().trim_end(), "v1"); // from HEAD, not the dirty copy
        assert!(git_worktree_add(root.clone()).unwrap().ends_with("proj-wt3"));
        assert!(git_worktree_add(base.to_string_lossy().into_owned()).is_err());

        // Merge refuses uncommitted work, then brings saved commits home; remove drops the merged branch.
        let w = |args: &[&str]| run_git(&wt, args).unwrap();
        std::fs::write(format!("{wt}/b.txt"), "new\n").unwrap();
        assert!(git_worktree_merge(wt.clone()).is_err());
        w(&["add", "-A"]);
        w(&["commit", "-qm", "b"]);
        git_worktree_merge(wt.clone()).unwrap();
        assert!(dir.join("b.txt").exists());
        assert!(git_worktree_merge(root.clone()).is_err()); // the main folder is not a deck worktree
        assert!(git_worktree_remove(wt.clone()).unwrap());
        assert!(!std::path::Path::new(&wt).exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn commit_then_push_sets_upstream() {
        let base = std::env::temp_dir().join(format!("mygdeck-git-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (dir, remote) = (base.join("work"), base.join("remote.git"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&remote).unwrap();
        run_git(&remote.to_string_lossy(), &["init", "-q", "--bare"]).unwrap();
        let root = dir.to_string_lossy().to_string();
        let g = |args: &[&str]| run_git(&root, args).unwrap();
        g(&["init", "-q"]);
        g(&["config", "user.email", "t@t"]);
        g(&["config", "user.name", "t"]);
        g(&["remote", "add", "origin", &remote.to_string_lossy()]);
        std::fs::write(dir.join("a.txt"), "v1").unwrap();
        git_save(root.clone(), "first".into()).unwrap();
        std::fs::write(dir.join("a.txt"), "v2").unwrap();
        assert!(git_diff(root.clone()).contains("+v2"));
        git_push(root.clone()).unwrap();
        assert!(g(&["log", "-1", "--format=%s", "@{u}"]).contains("first"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn file_diff_and_discard() {
        let dir = std::env::temp_dir().join(format!("mygdeck-discard-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        let root = dir.to_string_lossy().to_string();
        let g = |args: &[&str]| run_git(&root, args).unwrap();
        g(&["init", "-q"]);
        g(&["config", "user.email", "t@t"]);
        g(&["config", "user.name", "t"]);
        g(&["config", "core.autocrlf", "false"]);
        std::fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(dir.join("gone.txt"), "x\n").unwrap();
        git_save(root.clone(), "first".into()).unwrap();

        std::fs::write(dir.join("a.txt"), "one\nTWO\n").unwrap();
        std::fs::remove_file(dir.join("gone.txt")).unwrap();
        std::fs::write(dir.join("sub/new [1].txt"), "fresh\n").unwrap();
        let d = file_diff(root.clone(), "a.txt".into()).unwrap();
        assert!(d.diff.contains("-two") && d.diff.contains("+TWO") && !d.untracked);
        assert!(file_diff(root.clone(), "gone.txt".into()).unwrap().diff.contains("-x"));
        let n = file_diff(root.clone(), "sub/new [1].txt".into()).unwrap();
        assert!(n.diff.is_empty() && n.untracked);

        assert!(git_discard(root.clone(), "".into()).is_err());
        assert!(git_discard(root.clone(), "sub".into()).is_err());
        assert!(git_discard(root.clone(), "../a.txt".into()).is_err());
        git_discard(root.clone(), "a.txt".into()).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "one\ntwo\n");
        git_discard(root.clone(), "gone.txt".into()).unwrap();
        assert!(dir.join("gone.txt").is_file());
        git_discard(root.clone(), "sub/new [1].txt".into()).unwrap();
        assert!(!dir.join("sub/new [1].txt").exists());
        assert!(git_status(root.clone()).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_hunk_headers() {
        let d = "@@ -1,2 +1,3 @@ fn x\n+a\n@@ -10 +12 @@\n@@ -20,3 +25,0 @@\n";
        assert_eq!(parse_hunks(d), vec![1, 2, 3, 12]);
    }
}
