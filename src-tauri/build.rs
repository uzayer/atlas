fn main() {
    // Telemetry bakes the official PostHog key/host in at compile time via
    // `option_env!` (see `src/telemetry/mod.rs`). Cargo doesn't track env vars
    // read by `option_env!` unless we tell it to, so without these the embedded
    // value would go stale across rebuilds when `.env` changes. The build is
    // normally driven through `scripts/with-posthog-env.mjs`, which loads `.env`
    // into the environment before invoking the Tauri CLI.
    println!("cargo:rerun-if-env-changed=ATLAS_POSTHOG_KEY");
    println!("cargo:rerun-if-env-changed=ATLAS_POSTHOG_HOST");

    tauri_build::build()
}
