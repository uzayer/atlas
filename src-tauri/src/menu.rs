//! Native macOS application menu.
//!
//! Atlas previously shipped no menu, so Tauri installed its *default* menu —
//! whose Window ▸ Close item (Cmd+W) calls `performClose:` on the key window.
//! In the main webview that's harmless: the React hotkey handler
//! (`useHotkeys` in `App.tsx`) catches Cmd+W and `preventDefault()`s it, so
//! WebKit reports the key equivalent as handled and the menu never fires.
//!
//! But the embedded browser (`commands::browser`) is a *separate* native child
//! webview loading remote pages. Those pages don't preventDefault Cmd+W, so the
//! key equivalent fell through to the default Close item and tore down the whole
//! window — taking the app with it.
//!
//! Fix: define our own menu that mirrors the macOS standard (so Copy/Paste/etc.
//! still work in every webview) but replaces the predefined Close item with a
//! custom `atlas-close-tab` item. Its handler (wired in `lib.rs`) emits
//! `atlas:close-active-tab` to the main webview, which closes the active *tab*
//! instead of the window. The main-webview preventDefault path is unchanged, so
//! this only takes effect when a child webview has focus.

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};

/// Menu item id for the Cmd+W "close tab" action. Matched in the
/// `on_menu_event` handler in `lib.rs`.
pub const CLOSE_TAB_ID: &str = "atlas-close-tab";

pub fn build(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    // App menu (first submenu → becomes the macOS application menu).
    let app_menu = Submenu::with_items(
        app,
        "Atlas",
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(AboutMetadata::default()))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    // Standard Edit menu — provides Cmd+C/V/X/A/Z key equivalents that native
    // webviews (including the embedded browser) rely on.
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    // View menu — keep the standard fullscreen toggle (⌃⌘F) that the default
    // menu provided.
    let view_menu = Submenu::with_items(app, "View", true, &[&PredefinedMenuItem::fullscreen(app, None)?])?;

    // Window menu — Cmd+W is our custom "close tab" item, NOT the predefined
    // close-window (which would tear down the app from a focused child webview).
    let close_tab = MenuItem::with_id(app, CLOSE_TAB_ID, "Close Tab", true, Some("CmdOrCtrl+W"))?;
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &close_tab,
        ],
    )?;

    Menu::with_items(app, &[&app_menu, &edit_menu, &view_menu, &window_menu])
}
