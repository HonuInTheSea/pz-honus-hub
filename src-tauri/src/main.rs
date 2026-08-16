// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if pz_honus_hub_lib::run_pzmap2dzi_worker_if_requested() {
        return;
    }
    pz_honus_hub_lib::run()
}
