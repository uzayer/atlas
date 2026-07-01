//! Read file references off the system clipboard.
//!
//! When a user copies a file in Finder and pastes it into the chat input, the
//! WKWebView `paste` event exposes a `File` object but NOT its absolute path
//! (the web sandbox strips it). So the frontend asks Rust to read the native
//! pasteboard's file URLs directly and inserts those paths into the composer.

/// Absolute POSIX paths of the files currently on the clipboard, in pasteboard
/// order. Empty when the clipboard holds no file references — e.g. plain text,
/// or a raw screenshot bitmap that has no backing file on disk.
#[tauri::command]
pub fn clipboard_file_paths() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        macos_file_paths()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
}

#[cfg(target_os = "macos")]
fn macos_file_paths() -> Vec<String> {
    use objc2::rc::autoreleasepool;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::msg_send;
    use std::ffi::{CStr, CString};

    autoreleasepool(|_| unsafe {
        let (Some(pb_class), Some(str_class)) = (
            AnyClass::get(c"NSPasteboard"),
            AnyClass::get(c"NSString"),
        ) else {
            return Vec::new();
        };

        // [NSPasteboard generalPasteboard]
        let pb: *mut AnyObject = msg_send![pb_class, generalPasteboard];
        if pb.is_null() {
            return Vec::new();
        }

        // @"NSFilenamesPboardType" — the classic file-list type Finder writes on
        // a Cmd-C of one or more files. `propertyListForType:` yields an
        // NSArray<NSString*> of POSIX paths.
        let Ok(type_c) = CString::new("NSFilenamesPboardType") else {
            return Vec::new();
        };
        let type_str: *mut AnyObject =
            msg_send![str_class, stringWithUTF8String: type_c.as_ptr()];
        if type_str.is_null() {
            return Vec::new();
        }

        let plist: *mut AnyObject = msg_send![pb, propertyListForType: type_str];
        if plist.is_null() {
            return Vec::new();
        }

        let count: usize = msg_send![plist, count];
        let mut out = Vec::with_capacity(count);
        for i in 0..count {
            let s: *mut AnyObject = msg_send![plist, objectAtIndex: i];
            if s.is_null() {
                continue;
            }
            let c: *const std::os::raw::c_char = msg_send![s, UTF8String];
            if c.is_null() {
                continue;
            }
            let path = CStr::from_ptr(c).to_string_lossy().into_owned();
            if !path.is_empty() {
                out.push(path);
            }
        }
        out
    })
}
