//! Copies the directory pointed to by `ATLAS_KB_WEB` (or the local
//! `./web/` fallback) into `$OUT_DIR/web/` so `include_dir!` at compile
//! time can embed its contents. Re-runs whenever the env var or any
//! source file changes.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let dest = out_dir.join("web");

    let src = env::var("ATLAS_KB_WEB")
        .map(PathBuf::from)
        .unwrap_or_else(|_| manifest_dir.join("web"));

    println!("cargo:rerun-if-env-changed=ATLAS_KB_WEB");
    println!("cargo:rerun-if-changed={}", src.display());

    if dest.exists() {
        let _ = fs::remove_dir_all(&dest);
    }
    fs::create_dir_all(&dest).expect("create dest");
    if src.exists() {
        copy_dir(&src, &dest);
    } else {
        // Empty placeholder so include_dir! at compile time sees a dir.
        fs::write(dest.join("index.html"), "<!doctype html><h1>Empty</h1>").ok();
    }
}

fn copy_dir(src: &Path, dst: &Path) {
    fs::create_dir_all(dst).expect("mkdir dst");
    for entry in fs::read_dir(src).expect("read src").flatten() {
        let path = entry.path();
        let target = dst.join(entry.file_name());
        if path.is_dir() {
            copy_dir(&path, &target);
        } else {
            fs::copy(&path, &target).expect("copy file");
        }
    }
}
