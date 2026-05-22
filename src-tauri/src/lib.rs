mod commands;
mod logging;
mod state;

use std::sync::Arc;

use atlas_acp::AgentRegistry;
use commands::claude::ClaudeSessionIndex;
use commands::fileindex::FileIndexState;
use commands::papers::SavedPapersIndex;
use commands::sessions_watch::SessionsWatchState;
use commands::terminal::TerminalState;
use parking_lot::Mutex;
use state::{AppState, AppStateHandle};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Install a tracing subscriber that prints `tracing::info!` etc. to
    // stderr. Verbosity is controlled by `RUST_LOG`; see `logging.rs`.
    logging::init();

    // Strip CLAUDECODE so child ACP agents (canonical claude-code-acp) don't
    // refuse to start when Atlas was launched from a parent Claude Code shell.
    atlas_acp::sanitize_host_env();

    tauri::Builder::default()
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                // Transparent NSWindow + NSVisualEffectView blur. Combined
                // with `macos-private-api`, this propagates a transparent
                // background to the WKWebView's content NSView, so the
                // brief gap between window-shown and first React paint
                // shows a dark macOS material instead of the WebKit
                // default white. Mirrors Athas's
                // `src-tauri/src/commands/ui/window.rs:157-176` pattern.
                let _ = window
                    .set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));

                #[cfg(target_os = "macos")]
                {
                    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
                    if let Err(e) = apply_vibrancy(
                        &window,
                        NSVisualEffectMaterial::HudWindow,
                        None,
                        None,
                    ) {
                        tracing::warn!(
                            target: "atlas::boot",
                            "apply_vibrancy failed: {e}"
                        );
                    }
                }
            }
            // Pre-load the Rust-owned `AppState` (currentProject + recents)
            // before the webview starts loading — paid in parallel with the
            // WebView framework init, ~1ms on warm cache.
            let app_state: AppStateHandle = Arc::new(Mutex::new(AppState::load(&app.handle())));
            app.manage(app_state);
            commands::agents::install_manager(&app.handle());
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .manage(TerminalState::new())
        .manage(AgentRegistry::new())
        .manage(FileIndexState::new())
        .manage(SessionsWatchState::new())
        .manage(ClaudeSessionIndex::new())
        .manage(SavedPapersIndex::new())
        .invoke_handler(tauri::generate_handler![
            commands::terminal::terminal_create,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_close,
            commands::fs::read_directory,
            commands::fs::read_file_content,
            commands::fs::write_file_content,
            commands::git::git_status,
            commands::git::git_log,
            commands::git::git_diff_all,
            commands::git::git_diff_file,
            commands::git::git_stage,
            commands::git::git_unstage,
            commands::git::git_commit,
            commands::git::git_list_branches,
            commands::git::git_checkout,
            commands::git::git_create_branch,
            commands::git::git_delete_branch,
            commands::git::git_refs,
            commands::git::git_graph_signature,
            commands::github::search_github,
            commands::github::clone_github_repo,
            commands::github::list_cloned_repos,
            commands::github::read_repo_readme,
            commands::github::delete_cloned_repo,
            commands::analysis::analyze_project,
            // Legacy Claude-CLI subprocess commands (claude_run/stream/stop/check/version)
            // were replaced by ACP. Session-history readers below are still in use.
            commands::claude::list_claude_sessions,
            commands::claude::delete_claude_session,
            commands::claude::read_claude_session,
            commands::claude::claude_session_stats,
            commands::search::search_in_files,
            commands::research::search_arxiv,
            commands::research::search_semantic_scholar,
            commands::research::download_paper,
            commands::research::save_paper_to_knowledge,
            commands::research::fetch_trending_papers,
            commands::research::save_project_session,
            commands::research::load_project_session,
            commands::knowledge::list_knowledge,
            commands::knowledge::save_knowledge_note,
            commands::knowledge::delete_knowledge_note,
            commands::knowledge::create_knowledge_dir,
            commands::knowledge::log_interaction,
            commands::knowledge::get_recent_interactions,
            commands::knowledge::save_editor_state,
            commands::knowledge::load_editor_state,
            commands::knowledge::fetch_readable,
            commands::canvas::load_canvas,
            commands::canvas::save_canvas,
            commands::log::load_pinned_log,
            commands::log::append_pinned_log,
            commands::log::clear_pinned_log,
            commands::log::rewrite_pinned_log,
            commands::app_state::bootstrap_app_state,
            commands::app_state::save_app_state,
            commands::agents::agents_list_plugins,
            commands::agents::agents_list_running,
            commands::agents::agents_spawn,
            commands::agents::agents_kill,
            commands::agents::agents_new_session,
            commands::agents::agents_load_session,
            commands::agents::agents_snapshot,
            commands::agents::agents_send,
            commands::agents::agents_cancel,
            commands::agents::agents_set_mode,
            commands::agents::agents_set_model,
            commands::agents::agents_respond_permission,
            commands::fileindex::fileindex_open_project,
            commands::fileindex::fileindex_close_project,
            commands::fileindex::fileindex_search,
            commands::fileindex::fileindex_search_dirs,
            commands::fileindex::fileindex_status,
            commands::sessions_watch::sessions_watch_open,
            commands::sessions_watch::sessions_watch_close,
            commands::sessions_watch::sessions_watch_status,
            commands::papers::list_saved_papers,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Atlas");
}
