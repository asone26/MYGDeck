//! Crash log (B6): a panic leaves `~/.mygdeck/logs/crash-<time>.log` before the process aborts.
use std::time::{SystemTime, UNIX_EPOCH};

pub fn install() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = write(&format!("{info}\n\n{}", std::backtrace::Backtrace::force_capture()));
        default(info);
    }));
}

fn write(text: &str) -> std::io::Result<()> {
    let dir = crate::config::home().join(".mygdeck").join("logs");
    std::fs::create_dir_all(&dir)?;
    let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let role = std::env::args().nth(1).filter(|a| a.starts_with("--")).unwrap_or_else(|| "app".into());
    let body = format!("mygdeck {} ({role}) on {}\n{text}", env!("CARGO_PKG_VERSION"), std::env::consts::OS);
    std::fs::write(dir.join(format!("crash-{t}.log")), body)
}
