mod commands;
mod logging;
mod state;

use std::sync::Arc;

use atlas_acp::AgentRegistry;
use commands::claude::ClaudeSessionIndex;
use commands::cli::CliLaunchState;
use commands::fileindex::FileIndexState;
use commands::git_watcher::GitWatcherState;
use commands::knowledge_links::KnowledgeLinksState;
use commands::knowledge_meta::KnowledgeMetaState;
use commands::mention_search::MentionCacheState;
use commands::recent_files::RecentFilesState;
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

    // Parse argv for an initial project path BEFORE tauri::Builder starts
    // so the webview boot path can read it via `cli_take_initial_project_path`.
    // Triggered by the `atlas <path>` shell helper at ~/.local/bin/atlas.
    let initial_project = commands::cli::parse_initial_project();

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
        .plugin(tauri_plugin_notification::init())
        .manage(TerminalState::new())
        .manage(AgentRegistry::new())
        .manage(FileIndexState::new())
        .manage(GitWatcherState::new())
        .manage(RecentFilesState::new())
        .manage(MentionCacheState::new())
        .manage(Arc::new(KnowledgeMetaState::new()))
        .manage(Arc::new(KnowledgeLinksState::new()))
        .manage(CliLaunchState::new(initial_project))
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
            commands::fs::ensure_atlas_gitignore,
            commands::fs::fs_create_file,
            commands::fs::fs_create_dir,
            commands::fs::fs_rename,
            commands::fs::fs_delete,
            commands::fs::fs_copy,
            commands::fs::fs_duplicate,
            commands::fs::fs_open_in_terminal,
            commands::fs::fs_add_to_gitignore,
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
            commands::git_graph::git_graph_build,
            commands::git_watcher::git_watch_start,
            commands::git_watcher::git_watch_stop,
            commands::git_watcher::git_watch_status,
            commands::mention_search::mention_search,
            commands::mention_search::mention_cache_set_knowledge,
            commands::mention_search::mention_cache_set_symbols,
            commands::mention_search::mention_cache_clear,
            commands::recent_files::recent_files_open_project,
            commands::recent_files::recent_files_close_project,
            commands::recent_files::recent_files_push,
            commands::recent_files::recent_files_list,
            commands::recent_files::recent_files_clear,
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
            commands::knowledge::knowledge_cover_upload,
            commands::knowledge::knowledge_cover_resolve,
            commands::knowledge_meta::knowledge_meta_load,
            commands::knowledge_meta::knowledge_meta_patch,
            commands::knowledge_meta::knowledge_meta_delete,
            commands::knowledge_meta::knowledge_meta_drop_project,
            commands::knowledge_links::knowledge_backlinks,
            commands::knowledge_links::knowledge_forwardlinks,
            commands::knowledge_links::knowledge_link_counts,
            commands::knowledge_links::knowledge_links_invalidate,
            commands::knowledge_links::knowledge_links_drop_project,
            commands::knowledge_links::knowledge_links_graph,
            commands::knowledge_export::knowledge_export_note_md,
            commands::knowledge_export::knowledge_export_note_html,
            commands::knowledge_export::knowledge_export_workspace_md,
            commands::knowledge_export::knowledge_export_workspace_html,
            commands::knowledge_export::knowledge_export_server,
            commands::canvas::load_canvas,
            commands::canvas::save_canvas,
            commands::log::load_pinned_log,
            commands::log::append_pinned_log,
            commands::log::clear_pinned_log,
            commands::log::rewrite_pinned_log,
            commands::app_state::bootstrap_app_state,
            commands::app_state::save_app_state,
            commands::compose_prompt::compose_prompt,
            commands::cli::cli_status,
            commands::cli::cli_install_helper,
            commands::cli::cli_take_initial_project_path,
            commands::claude_setup::claude_status,
            commands::claude_setup::claude_install,
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
            commands::agents::agents_list_auth_methods,
            commands::agents::agents_run_auth_method,
            commands::fileindex::fileindex_open_project,
            commands::fileindex::fileindex_close_project,
            commands::fileindex::fileindex_search,
            commands::fileindex::fileindex_search_dirs,
            commands::fileindex::fileindex_status,
            commands::sessions_watch::sessions_watch_open,
            commands::sessions_watch::sessions_watch_close,
            commands::sessions_watch::sessions_watch_status,
            commands::papers::list_saved_papers,
            commands::pomodoro::pomodoro_load,
            commands::pomodoro::pomodoro_save,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Atlas");
}
