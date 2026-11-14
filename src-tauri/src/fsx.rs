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

/// Extract the `hunk_index`-th unified diff hunk along with its file header so `git apply -R` can revert just that hunk.
pub fn single_hunk_patch(diff: &str, hunk_index: usize) -> Option<String> {
    let mut header = Vec::new();
    let mut hunks: Vec<Vec<&str>> = Vec::new();
    for line in diff.lines() {
        if line.starts_with("@@ ") {
            hunks.push(vec![line]);
        } else if let Some(cur) = hunks.last_mut() {
            cur.push(line);
        } else {
            header.push(line);
        }
    }
    let hunk = hunks.get(hunk_index)?;
    let mut out = header.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    out.push_str(&hunk.join("\n"));
    out.push('\n');
    Some(out)
}

/// Revert only one hunk of a file's uncommitted diff against HEAD.
#[tauri::command]
pub fn git_discard_hunk(root: String, rel: String, hunk_index: usize) -> Result<(), String> {
    let path = safe_join(&root, &rel)?;
    if rel.trim_matches(|c| c == '/' || c == '.').is_empty() || path.is_dir() {
        return Err("not a file".into());
    }
    let diff = run_git(&root, &["--literal-pathspecs", "diff", "HEAD", "--", &rel])?;
    let patch = single_hunk_patch(&diff, hunk_index).ok_or("hunk not found")?;
    let mut child = std::process::Command::new("git")
        .args(["-C", &root, "apply", "-R", "--whitespace=nowarn", "-"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        stdin.write_all(patch.as_bytes()).map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
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

/// "커밋": commit selected files, or every change when `files` is omitted/empty.
#[tauri::command]
pub fn git_save(root: String, message: String, files: Option<Vec<String>>) -> Result<String, String> {
    match files {
        Some(list) if !list.is_empty() => {
            let mut args = vec!["--literal-pathspecs", "add", "-A", "--"];
            for f in &list {
                args.push(f.as_str());
            }
            run_git(&root, &args)?;
            let mut cargs = vec!["--literal-pathspecs", "commit", "-m", message.as_str(), "--"];
            for f in &list {
                cargs.push(f.as_str());
            }
            run_git(&root, &cargs)
        }
        _ => {
            run_git(&root, &["add", "-A"])?;
            run_git(&root, &["commit", "-m", &message])
        }
    }
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

#[derive(Serialize)]
pub struct BranchInfo {
    pub branch: String,
    pub pr_url: Option<String>,
}

/// Convert a git remote URL (`git@github.com:o/r.git` or `https://github.com/o/r.git`) to a web compare/PR URL.
pub fn remote_compare_url(remote: &str, branch: &str) -> Option<String> {
    let r = remote.trim().trim_end_matches(".git");
    if branch.is_empty() || branch == "HEAD" {
        return None;
    }
    let slug = |host: &str| -> Option<&str> {
        r.strip_prefix(&format!("https://{host}/"))
            .or_else(|| r.strip_prefix(&format!("http://{host}/")))
            .or_else(|| r.strip_prefix(&format!("git@{host}:")))
    };
    if let Some(repo) = slug("github.com") {
        return Some(format!("https://github.com/{repo}/compare/{branch}?expand=1"));
    }
    if let Some(repo) = slug("gitlab.com") {
        return Some(format!("https://gitlab.com/{repo}/-/merge_requests/new?merge_request[source_branch]={branch}"));
    }
    None
}

/// Current git branch and (if origin is GitHub/GitLab) a one-click PR/Compare URL.
#[tauri::command]
pub fn git_branch_info(root: String) -> Option<BranchInfo> {
    let branch = git(&root, &["rev-parse", "--abbrev-ref", "HEAD"])?.trim().to_string();
    if branch.is_empty() {
        return None;
    }
    let pr_url = git(&root, &["remote", "get-url", "origin"]).and_then(|u| remote_compare_url(&u, &branch));
    Some(BranchInfo { branch, pr_url })
}

/// Create and switch to a new git branch (`git checkout -b <name>`).
#[tauri::command]
pub fn git_new_branch(root: String, name: String) -> Result<String, String> {
    let clean = name.trim();
    if clean.is_empty() || clean.starts_with('-') || clean.contains("..") || clean.chars().any(|c| c.is_whitespace()) {
        return Err("올바른 브랜치 이름을 입력하세요 (공백·..·선행 - 불가)".into());
    }
    run_git(&root, &["checkout", "-b", clean])?;
    Ok(clean.to_string())
}

/// List local git branches, current branch first.
#[tauri::command]
pub fn git_branches(root: String) -> Vec<String> {
    git(&root, &["for-each-ref", "--format=%(refname:short)", "refs/heads/"])
        .map(|s| s.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default()
}

/// Switch to an existing local git branch (`git checkout <name>`).
#[tauri::command]
pub fn git_switch_branch(root: String, name: String) -> Result<String, String> {
    let clean = name.trim();
    if clean.is_empty() || clean.starts_with('-') || clean.contains("..") || clean.chars().any(|c| c.is_whitespace()) {
        return Err("올바른 브랜치 이름을 입력하세요".into());
    }
    run_git(&root, &["checkout", clean])?;
    Ok(clean.to_string())
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

/// Create a GitHub PR draft/PR using `gh pr create`.
#[tauri::command]
pub fn git_create_pr(root: String, title: String, body: String) -> Result<String, String> {
    let mut cmd = std::process::Command::new("gh");
    cmd.args(["pr", "create", "--title", title.trim(), "--body", body.trim(), "--draft"])
        .current_dir(&root);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().map_err(|e| format!("gh CLI 실행 실패 (GitHub CLI가 설치되어 있는지 확인하세요): {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() { format!("gh pr create 실패 ({})", out.status) } else { err });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Capture a non-intrusive git snapshot before an agent turn (`git stash create` if dirty, else `HEAD`).
#[tauri::command]
pub fn git_checkpoint_create(root: String) -> Option<String> {
    let stash = git(&root, &["stash", "create"]).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    stash.or_else(|| git(&root, &["rev-parse", "HEAD"]).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
}

/// Restore tracked files to a previously captured checkpoint (`stash` commit or `HEAD` commit).
#[tauri::command]
pub fn git_checkpoint_restore(root: String, rev: String) -> Result<(), String> {
    let rev = rev.trim();
    if rev.is_empty() {
        return Err("empty checkpoint".into());
    }
    if git(&root, &["rev-parse", "--verify", "--quiet", &format!("{rev}^2")]).is_some() {
        run_git(&root, &["reset", "--hard", "HEAD"])?;
        run_git(&root, &["stash", "apply", "--index", rev]).or_else(|_| run_git(&root, &["stash", "apply", rev]))?;
    } else {
        run_git(&root, &["reset", "--hard", rev])?;
    }
    Ok(())
}

/// Files modified since a checkpoint commit (`git diff --name-only <rev>`).
#[tauri::command]
pub fn git_changed_since(root: String, rev: String) -> Vec<String> {
    let clean = rev.trim();
    if clean.is_empty() || clean.starts_with('-') || !clean.chars().all(|c| c.is_ascii_hexdigit()) {
        return vec![];
    }
    git(&root, &["diff", "--name-only", clean])
        .map(|s| s.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default()
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
        copy_env_files(&top, &dir);
        return Ok(path);
    }
    Err("worktree 이름을 정하지 못했습니다".into())
}

fn copy_env_files(src: &std::path::Path, dst: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(src) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let s = name.to_string_lossy();
        if !s.starts_with(".env") || s.ends_with(".example") || s.ends_with(".sample") {
            continue;
        }
        let from = entry.path();
        let to = dst.join(&name);
        if from.is_file() && !to.exists() {
            let _ = std::fs::copy(&from, &to);
        }
    }
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
        git_save(root.clone(), "first".into(), None).unwrap();
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
        git_save(root.clone(), "first".into(), None).unwrap();
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
        git_save(root.clone(), "first".into(), None).unwrap();

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

    #[test]
    fn discards_single_hunk() {
        let dir = std::env::temp_dir().join(format!("mygdeck-hunk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().to_string();
        let g = |args: &[&str]| run_git(&root, args).unwrap();
        g(&["init", "-q"]);
        g(&["config", "user.email", "t@t"]);
        g(&["config", "user.name", "t"]);
        g(&["config", "core.autocrlf", "false"]);
        let orig = (1..=20).map(|i| format!("line{i}")).collect::<Vec<_>>().join("\n") + "\n";
        std::fs::write(dir.join("m.txt"), &orig).unwrap();
        git_save(root.clone(), "init".into(), None).unwrap();

        let edited = orig.replace("line2\n", "TWO\n").replace("line19\n", "NINETEEN\n");
        std::fs::write(dir.join("m.txt"), &edited).unwrap();
        git_discard_hunk(root.clone(), "m.txt".into(), 0).unwrap();
        let after = std::fs::read_to_string(dir.join("m.txt")).unwrap();
        assert!(after.contains("line2\n") && after.contains("NINETEEN\n"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn builds_pr_compare_url() {
        assert_eq!(
            remote_compare_url("git@github.com:org/repo.git", "feat/x").as_deref(),
            Some("https://github.com/org/repo/compare/feat/x?expand=1")
        );
        assert_eq!(
            remote_compare_url("https://gitlab.com/org/repo", "main").as_deref(),
            Some("https://gitlab.com/org/repo/-/merge_requests/new?merge_request[source_branch]=main")
        );
        assert_eq!(remote_compare_url("https://example.com/a/b", "main"), None);
    }

    #[test]
    fn creates_and_restores_checkpoint() {
        let dir = std::env::temp_dir().join(format!("mygdeck-cp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().to_string();
        let g = |args: &[&str]| run_git(&root, args).unwrap();
        g(&["init", "-q"]);
        g(&["config", "user.email", "t@t"]);
        g(&["config", "user.name", "t"]);
        g(&["config", "core.autocrlf", "false"]);
        std::fs::write(dir.join("a.txt"), "v1\n").unwrap();
        git_save(root.clone(), "init".into(), None).unwrap();

        std::fs::write(dir.join("a.txt"), "v2\n").unwrap();
        let cp = git_checkpoint_create(root.clone()).unwrap();
        std::fs::write(dir.join("a.txt"), "v3\n").unwrap();
        git_checkpoint_restore(root.clone(), cp).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "v2\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn commits_selected_files_only() {
        let dir = std::env::temp_dir().join(format!("mygdeck-sel-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().to_string();
        let g = |args: &[&str]| run_git(&root, args).unwrap();
        g(&["init", "-q"]);
        g(&["config", "user.email", "t@t"]);
        g(&["config", "user.name", "t"]);
        std::fs::write(dir.join("a.txt"), "1\n").unwrap();
        std::fs::write(dir.join("b.txt"), "1\n").unwrap();
        git_save(root.clone(), "init".into(), None).unwrap();

        std::fs::write(dir.join("a.txt"), "2\n").unwrap();
        std::fs::write(dir.join("b.txt"), "2\n").unwrap();
        git_save(root.clone(), "only a".into(), Some(vec!["a.txt".into()])).unwrap();
        let st = git_status(root.clone());
        assert_eq!(st.len(), 1);
        assert_eq!(st[0].path, "b.txt");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
