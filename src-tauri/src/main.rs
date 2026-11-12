// No console window on Windows, debug builds included (mygdeck.bat runs the debug build; nothing logs to stdout).
#![windows_subsystem = "windows"]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    mygdeck_lib::crash::install();
    match args.get(1).map(String::as_str) {
        // The same binary doubles as the agent hook command (see hooks.rs) and the session daemon.
        Some("--hook") => mygdeck_lib::hooks::send(args.get(2).map(String::as_str).unwrap_or(""), args.get(3).map(String::as_str)),
        Some("--daemon") => mygdeck_lib::daemon::serve(),
        // Login item for the phone dashboard: start the daemon (and its tunnel) without a window.
        Some("--start-daemon") => {
            let _ = mygdeck_lib::daemon::ensure_running();
        }
        _ => mygdeck_lib::run(),
    }
}
