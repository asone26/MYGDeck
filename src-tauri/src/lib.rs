pub mod adapters;
pub mod ai;
pub mod cli;
pub mod config;
pub mod crash;
pub mod daemon;
pub mod fsx;
pub mod hooks;
pub mod pty;
pub mod turn;
pub mod watch;

use tauri::Manager;

pub fn run() {
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            config::load_config,
            config::save_config,
            adapters::list_adapters,
            ai::ai_list,
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
            fsx::git_push,
            fsx::git_ahead,
            fsx::git_shortstat,
            fsx::git_worktree_add,
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
