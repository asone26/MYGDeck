//! Git turn checkpoints and parallel worktree lifecycle (`mygdeck/wtN`).
use crate::fsx::{git, run_git};
use std::path::{Path, PathBuf};

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

fn copy_env_files(src: &Path, dst: &Path) {
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
