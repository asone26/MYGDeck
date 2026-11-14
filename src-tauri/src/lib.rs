pub mod adapters;
pub mod ai;
pub mod cli;
pub mod config;
pub mod crash;
pub mod daemon;
pub mod fsx;
pub mod hooks;
pub mod mobile;
pub mod pty;
pub mod turn;
pub mod watch;

use tauri::Manager;

/// Apps opened from Finder or the Dock get launchd's bare PATH (/usr/bin:/bin:...), so agent CLIs
/// installed with Homebrew, npm or ~/.local are "not found". Take PATH from the user's login shell,
/// as Terminal does; the daemon and the agents inherit it. Launched from a terminal (TERM set), the
/// PATH is already right.
#[cfg(target_os = "macos")]
fn login_shell_path() {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::Duration;
    if std::env::var_os("TERM").is_some() {
        return;
    }
    const MARK: &str = "__MYGDECK_PATH__";
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let script = format!("printf '{MARK}%s{MARK}' \"$PATH\"");
    let Ok(mut child) = Command::new(shell).args(["-ilc", &script]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn() else {
        return;
    };
    let Some(mut stdout) = child.stdout.take() else { return };
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        let _ = tx.send(s);
    });
    // A slow or stuck shell profile must not hold the window back.
    let Ok(text) = rx.recv_timeout(Duration::from_secs(5)) else {
        let _ = child.kill();
        let _ = child.wait();
        return;
    };
    let _ = child.wait();
    if let Some(path) = text.split(MARK).nth(1).filter(|p| !p.is_empty()) {
        std::env::set_var("PATH", path);
    }
}

pub fn run() {
    #[cfg(target_os = "macos")]
    login_shell_path();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(pty::Daemon::default())
        .manage(watch::Watchers::default())
        .setup(|app| {
            // Hooks run from the daemon's stable copy of this program, so a rebuild cannot break them.
            let hook_exe = daemon::stable_exe().to_string_lossy().replace('\\', "/");
            let claude_settings = hooks::write_claude_settings(app.handle(), &hook_exe)?;
            app.manage(hooks::HookInfo { claude_settings, hook_exe });
            // How this window was started, so the phone dashboard can open the deck the same way.
            mobile::remember_app();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            config::load_config,
            config::save_config,
            adapters::list_adapters,
            ai::ai_list,
            ai::ai_ready,
            ai::ai_save,
            ai::ai_delete,
            ai::ai_test,
            ai::ai_ask,
            
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_list,
            pty::pty_attach,
            pty::default_shell,
            fsx::list_dir,
            fsx::list_files,
            fsx::git_status,
            fsx::read_file,
            fsx::changed_lines,
            fsx::read_spec,
            fsx::git_save,
            fsx::git_diff,
            fsx::file_diff,
            fsx::git_discard,
            fsx::git_discard_hunk,
            fsx::run_shell_cmd,
            fsx::git_push,
            fsx::git_ahead,
            fsx::git_shortstat,
            fsx::git_worktree_add,
            fsx::git_worktree_merge,
            fsx::git_worktree_remove,
            fsx::save_paste,
            fsx::open_file,
            fsx::rename_file,
            turn::read_turn,
            watch::watch_project,
            watch::unwatch_project,
        ])
        // Sessions belong to the daemon and keep running after the window closes.
        .run(tauri::generate_context!())
        .expect("failed to run mygdeck");
}
