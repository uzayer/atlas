#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Replace the system allocator with mimalloc — affects every `String::new`,
// `Vec::push`, Tauri internal alloc, etc. across the process. The biggest
// startup wins come from the allocation-heavy phase of WebView init, plugin
// registration, and the IPC bridge setup.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn main() {
    atlas_lib::run()
}
