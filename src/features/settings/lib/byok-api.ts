import { invoke } from "@tauri-apps/api/core";

/** Non-secret per-provider metadata returned by Rust (camelCase from serde). */
export interface ProviderKeyMeta {
  provider: string;
  last4: string;
  addedAt: string;
}

/**
 * BYOK keychain bridge. Secrets live in the OS keychain (Rust `byok.rs`); the
 * frontend only ever sees metadata via `list`. The raw key never reaches JS:
 * consumers that need it (the Model-Chat Rig backend) read it Rust-side via the
 * `byok_get` command. `last4` + `addedAt` are computed here so Rust never has
 * to slice the secret.
 */
export const byok = {
  list: () => invoke<ProviderKeyMeta[]>("byok_list"),

  set: (provider: string, key: string) =>
    invoke<void>("byok_set", {
      provider,
      key,
      last4: key.slice(-4),
      addedAt: new Date().toISOString(),
    }),

  delete: (provider: string) => invoke<void>("byok_delete", { provider }),
};
