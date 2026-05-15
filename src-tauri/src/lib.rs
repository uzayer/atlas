mod commands;

use atlas_acp::AgentRegistry;
use commands::terminal::TerminalState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Strip CLAUDECODE so child ACP agents (canonical claude-code-acp) don't
    // refuse to start when Atlas was launched from a parent Claude Code shell.
    atlas_acp::sanitize_host_env();

    tauri::Builder::default()
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 255)));
            }
            Ok(())
        })
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .manage(TerminalState::new())
        .manage(AgentRegistry::new())
        .invoke_handler(tauri::generate_handler![
            commands::chat::chat_send,
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
            commands::acp::acp_known_specs,
            commands::acp::acp_list_agents,
            commands::acp::acp_spawn_agent,
            commands::acp::acp_kill_agent,
            commands::acp::acp_new_session,
            commands::acp::acp_send_prompt,
            commands::acp::acp_cancel_turn,
            commands::acp::acp_respond_permission,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Atlas");
}
