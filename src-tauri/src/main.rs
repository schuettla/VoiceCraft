// Hide the console window in release builds; keep it in dev for backend logs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    voicecraft_lib::run()
}
