// Thin TS wrapper around the `claude_setup` Tauri commands + their stream
// events. Mirrors `src/features/chat/lib/agents-api.ts` in shape.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface ClaudeStatus {
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  auth_summary: string | null;
}

export type ClaudeAuthMethod =
  | { kind: "api_key"; value: string }
  | { kind: "subscription" };

export interface ClaudeInstallProgress {
  stream: "stdout" | "stderr";
  line: string;
}

export interface ClaudeInstallDone {
  success: boolean;
  exit_code: number | null;
}

export const claudeSetup = {
  status: () => invoke<ClaudeStatus>("claude_status"),
  install: () => invoke<void>("claude_install"),
  authLogin: (method: ClaudeAuthMethod) =>
    invoke<void>("claude_auth_login", { method }),
};

export const listenClaudeInstallProgress = (
  handler: (p: ClaudeInstallProgress) => void,
): Promise<UnlistenFn> =>
  listen<ClaudeInstallProgress>("atlas:claude-install:progress", (e) =>
    handler(e.payload),
  );

export const listenClaudeInstallDone = (
  handler: (p: ClaudeInstallDone) => void,
): Promise<UnlistenFn> =>
  listen<ClaudeInstallDone>("atlas:claude-install:done", (e) =>
    handler(e.payload),
  );
