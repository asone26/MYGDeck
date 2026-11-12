//! Console front end for the deck's sessions (`mygdeck-cli status`, `mygdeck-cli send`).
//! A separate binary because the app itself is a GUI program without a console.
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(mygdeck_lib::cli::run(&args));
}
