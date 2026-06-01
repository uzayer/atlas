//! Native window controls that Tauri's cross-platform API doesn't cover.

/// Perform the macOS window "zoom" (the green-button / double-click-title
/// behaviour). Tauri's `toggleMaximize()` does NOT map to AppKit's zoom on
/// macOS, so a double-click on our custom titlebar appeared to do nothing.
/// We call `-[NSWindow performZoom:]` directly instead.
///
/// AppKit calls must run on the main thread, so the message is dispatched
/// via `run_on_main_thread`. No-op on non-macOS.
#[tauri::command]
pub fn window_zoom(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let win = window.clone();
        window
            .run_on_main_thread(move || {
                if let Ok(ptr) = win.ns_window() {
                    // `ns_window()` returns the NSWindow as a `*mut c_void`.
                    use objc2::runtime::AnyObject;
                    let ns = ptr as *mut AnyObject;
                    if ns.is_null() {
                        return;
                    }
                    unsafe {
                        let _: () = objc2::msg_send![
                            &*ns,
                            performZoom: core::ptr::null_mut::<AnyObject>()
                        ];
                    }
                }
            })
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
    }
    Ok(())
}
