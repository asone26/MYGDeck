// No console window on Windows, debug builds included (mygdeck.bat runs the debug build; nothing logs to stdout).
#![windows_subsystem = "windows"]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // The same binary doubles as the agent hook command (see hooks.rs).
    if args.get(1).map(String::as_str) == Some("--hook") {
        mygdeck_lib::hooks::send(args.get(2).map(String::as_str).unwrap_or(""));
        return;
    }
    mygdeck_lib::run();
}
