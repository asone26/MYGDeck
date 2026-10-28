pub mod adapters;
pub mod ai;
pub mod config;
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
        .manage(pty::Ptys::default())
        .manage(watch::Watchers::default())
        .setup(|app| {
            let port = hooks::listen(app.handle().clone())?;
            let claude_settings = hooks::write_claude_settings(app.handle())?;
            app.manage(hooks::HookInfo { port, claude_settings });
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
            pty::pty_reset,
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
            fsx::save_paste,
            fsx::open_file,
            fsx::rename_file,
            turn::read_turn,
            watch::watch_project,
            watch::unwatch_project,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build mygdeck")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<pty::Ptys>().kill_all();
            }
        });
}
