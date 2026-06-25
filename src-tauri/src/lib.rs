mod commands;
mod logging;
mod menu;
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

    let builder = tauri::Builder::default();

    // Single-instance — RELEASE ONLY. When the user runs `atlas <path>` while
    // Atlas is already open, the shell helper's `open -n` spawns a fresh
    // process; this plugin forwards that process's argv to the running
    // instance (firing this callback) and the duplicate exits.
    //
    // It is intentionally NOT registered in debug builds: otherwise
    // `tauri dev` is killed the instant it starts whenever the installed
    // /Applications/Atlas.app is running — the dev process is treated as the
    // "second instance", forwards its (empty) argv, and exits. Skipping it in
    // debug lets dev and the installed app coexist.
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        use tauri::Emitter;
        tracing::info!(target: "atlas::cli", "second-instance argv: {argv:?}");
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        // argv[0] is the executable path — strip it before parsing.
        let positional = argv.get(1..).unwrap_or(&[]);
        if let Some(path) = commands::cli::parse_project_path(positional) {
            let _ = app.emit("atlas:cli-open-project", path);
        }
    }));

    builder
        // Custom menu: replaces the default Window ▸ Close (Cmd+W) with a
        // "Close Tab" item so Cmd+W in a focused embedded browser webview closes
        // the tab instead of tearing down the window. See `menu.rs`.
        .menu(|handle| menu::build(handle))
        .on_menu_event(|app, event| {
            if event.id() == menu::CLOSE_TAB_ID {
                use tauri::Emitter;
                let _ = app.emit("atlas:close-active-tab", ());
            }
        })
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                // Opaque dark window background. Fills the brief gap between
                // window-shown and first React paint with the app's base
                // black instead of the WebKit default white.
                //
                // This was previously a transparent NSWindow + HudWindow
                // NSVisualEffectView blur (window_vibrancy). Removed: the live
                // backdrop blur forced the macOS WindowServer to recomposite
                // the whole window against everything behind it every frame,
                // which made Mission Control / Spaces transitions lag
                // system-wide whenever Atlas was the focused window. An opaque
                // window can be snapshotted as a flat texture, so the OS
                // animation stays smooth.
                let _ = window
                    .set_background_color(Some(tauri::window::Color(0, 0, 0, 255)));
            }
            // Pre-load the Rust-owned `AppState` (currentProject + recents)
            // before the webview starts loading — paid in parallel with the
            // WebView framework init, ~1ms on warm cache.
            let app_state: AppStateHandle = Arc::new(Mutex::new(AppState::load(&app.handle())));
            app.manage(app_state);
            commands::agents::install_manager(&app.handle());
            // Silent background refresh of model pricing from models.dev — first
            // launch populates the cache; later launches update only on change.
            commands::models_pricing::refresh_in_background(&app.handle());
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(commands::browser::BrowserState::new())
        .manage(TerminalState::new())
        .manage(commands::modelchat::ModelChatState::new())
        .manage(commands::review::ReviewState::new())
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
        .manage(commands::memory_chat::MemoryChatState::new())
        .manage(commands::memory_sharing::MemorySharingState::new())
        .manage(commands::shared_memory::SharedMemoryStore::new())
        // Drop a window's per-window index + mention caches when it closes, so
        // its file watcher stops and memory is freed (these states are keyed by
        // webview label for multi-window project scoping).
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let label = window.label();
                window.state::<FileIndexState>().drop_window(label);
                window.state::<MentionCacheState>().drop_window(label);
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::window::window_zoom,
            commands::clipboard::clipboard_file_paths,
            commands::window::set_window_title,
            commands::browser::browser_open_window,
            commands::browser::browser_embed_create,
            commands::browser::browser_embed_navigate,
            commands::browser::browser_embed_back,
            commands::browser::browser_embed_forward,
            commands::browser::browser_embed_reload,
            commands::browser::browser_embed_set_bounds,
            commands::browser::browser_embed_set_visible,
            commands::browser::browser_embed_destroy,
            commands::terminal::terminal_create,
            commands::terminal::terminal_zsh_dir,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_close,
            commands::terminal::terminal_resolve_path,
            commands::terminal::resolve_path,
            commands::terminal::terminal_path_complete,
            commands::terminal::terminal_list_commands,
            commands::fs::read_directory,
            commands::fs::read_file_content,
            commands::fs::read_file_base64,
            commands::fs::is_text_file,
            commands::fs::file_mtime_ms,
            commands::fs::asset_allow_dir,
            commands::fs::write_file_content,
            commands::fs::write_file_base64,
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
            commands::git::git_status_fresh,
            commands::git::git_log,
            commands::git::git_diff_all,
            commands::git::git_workspace_summary,
            commands::mission_control::mission_control_usage,
            commands::mission_control::mission_control_export_markdown,
            commands::mission_control::mission_control_write_file,
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
            // Extended source-control manager operations.
            commands::git_ops::git_branches_full,
            commands::git_ops::git_rename_branch,
            commands::git_ops::git_branch_delete,
            commands::git_ops::git_merge_branch,
            commands::git_ops::git_merge_preview,
            commands::git_ops::git_fetch,
            commands::git_ops::git_pull,
            commands::git_ops::git_push,
            commands::git_ops::git_publish_branch,
            commands::git_ops::git_remotes,
            commands::git_ops::git_remote_add,
            commands::git_ops::git_remote_remove,
            commands::git_ops::git_stash_list,
            commands::git_ops::git_stash_push,
            commands::git_ops::git_stash_paths,
            commands::git_ops::git_stash_apply,
            commands::git_ops::git_stash_pop,
            commands::git_ops::git_stash_drop,
            commands::git_ops::git_discard,
            commands::git_ops::git_delete_added,
            commands::git_ops::git_reset,
            commands::git_ops::git_revert,
            commands::git_ops::git_cherry_pick,
            commands::git_ops::git_commit_ex,
            commands::git_ops::git_diff_staged,
            commands::git_ops::git_diff_unstaged,
            commands::git_ops::git_tags,
            commands::git_ops::git_create_tag,
            commands::git_ops::git_delete_tag,
            commands::git_ops::git_show,
            commands::git_ops::git_inprogress,
            commands::git_ops::git_op_control,
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
            commands::recent_files::recent_files_rename,
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
            commands::gitdiff::git_diff_structured,
            commands::gitdiff::git_diff_line_status,
            commands::claude::delete_claude_session,
            commands::claude::read_claude_session,
            commands::claude::claude_session_stats,
            commands::claude::project_usage_stats,
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
            commands::knowledge::import_into_knowledge,
            commands::knowledge::delete_knowledge_note,
            commands::knowledge::create_knowledge_dir,
            commands::knowledge::log_interaction,
            commands::knowledge::get_recent_interactions,
            commands::knowledge::save_editor_state,
            commands::knowledge::load_editor_state,
            commands::knowledge::fetch_readable,
            commands::knowledge::knowledge_cover_upload,
            commands::knowledge::knowledge_cover_resolve,
            commands::knowledge::knowledge_cover_data_url,
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
            commands::knowledge_graph_layout::knowledge_graph_layout_load,
            commands::knowledge_graph_layout::knowledge_graph_layout_save,
            commands::canvas::load_canvas,
            commands::canvas::save_canvas,
            commands::log::load_pinned_log,
            commands::log::append_pinned_log,
            commands::log::clear_pinned_log,
            commands::log::rewrite_pinned_log,
            commands::log::load_project_log,
            commands::log::append_project_log,
            commands::log::clear_project_log,
            commands::app_state::bootstrap_app_state,
            commands::app_state::save_app_state,
            commands::compose_prompt::compose_prompt,
            commands::cli::cli_status,
            commands::cli::cli_install_helper,
            commands::cli::cli_take_initial_project_path,
            commands::claude_setup::claude_status,
            commands::claude_setup::claude_install,
            commands::node_setup::node_check,
            commands::node_setup::node_install,
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
            commands::agents::agents_set_effort,
            commands::agents::agents_set_compress,
            commands::mcp::mcp_list,
            commands::mcp::mcp_save,
            commands::models_pricing::models_pricing_get,
            commands::models_pricing::models_pricing_refresh,
            commands::agents::agents_respond_permission,
            commands::agents::agents_list_auth_methods,
            commands::agents::agents_run_auth_method,
            commands::agents::agents_authenticate,
            commands::agents::codex_status,
            commands::cersei::cersei_list_sessions,
            commands::cersei::cersei_session_transcript,
            commands::byok::byok_list,
            commands::byok::byok_set,
            commands::byok::byok_delete,
            commands::byok::byok_get,
            commands::modelchat::modelchat_models,
            commands::modelchat::modelchat_stream,
            commands::modelchat::modelchat_cancel,
            commands::review::review_providers,
            commands::review::review_base_branches,
            commands::review::review_start,
            commands::review::review_cancel,
            commands::review::review_list,
            commands::review::review_get,
            commands::modelchat_sessions::modelchat_sessions_list,
            commands::modelchat_sessions::modelchat_session_get,
            commands::modelchat_sessions::modelchat_session_save,
            commands::modelchat_sessions::modelchat_session_delete,
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
            commands::plans::plans_load,
            commands::plans::plans_append,
            commands::agent_memory::agent_memory_read,
            commands::agent_memory::list_codex_sessions,
            commands::memory_graph::memory_embed_status,
            commands::memory_graph::memory_embed_download,
            commands::memory_graph::memory_index_build,
            commands::memory_graph::memory_index_query,
            commands::memory_graph::memory_graph_layout_load,
            commands::memory_graph::memory_graph_layout_save,
            commands::memory_policy::memory_policies,
            commands::memory_policy::memory_policy_update,
            commands::memory_sharing::memory_sharing_get,
            commands::memory_sharing::memory_sharing_set,
            commands::memory_sharing::memory_summarizer_get,
            commands::memory_sharing::memory_summarizer_set,
            commands::shared_memory::memory_get_state,
            commands::shared_memory::memory_query,
            commands::shared_memory::memory_list_events,
            commands::shared_memory::memory_clear_project,
            commands::shared_memory::memory_append_event,
            commands::memory_timeline::memory_timeline,
            commands::memory_timeline::memory_timeline_cached,
            commands::memory_chat::memory_chat_model_status,
            commands::memory_chat::memory_chat_model_download,
            commands::memory_chat::memory_chat_model_load,
            commands::memory_chat::memory_chat_send,
            commands::memory_chat::memory_chat_cancel,
            commands::memory_chat::memory_chat_retrieve,
            commands::codebase_index::codebase_index_status,
            commands::codebase_index::codebase_index_build,
            commands::memory_chat_sessions::memory_chat_sessions_list,
            commands::memory_chat_sessions::memory_chat_session_get,
            commands::memory_chat_sessions::memory_chat_session_save,
            commands::memory_chat_sessions::memory_chat_session_delete,
            commands::pdf_annotations::pdf_annotations_load,
            commands::pdf_annotations::pdf_annotations_save,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Atlas");
}
