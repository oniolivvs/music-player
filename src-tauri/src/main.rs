// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Desktop binary entry point — all the logic lives in the shared library
// (src/lib.rs) so the Android/iOS builds can boot the exact same app.
fn main() {
    music_player_lib::run()
}
