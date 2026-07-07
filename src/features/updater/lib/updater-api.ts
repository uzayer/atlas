import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface UpdateStatus {
  available: boolean;
  version: string | null;
  currentVersion: string;
}

export interface UpdateAvailable {
  version: string;
  currentVersion: string;
}

export interface UpdateProgress {
  downloaded: number;
  total: number;
}

export interface UpdateError {
  message: string;
  dmgOpened: boolean;
}

export interface UpdateChecking {
  checking: boolean;
}

export const updater = {
  /** Manual "Check for updates" — ignores the auto-update/ignored gates. */
  checkNow: () => invoke<UpdateStatus>("update_check_now"),
  /** Download + install the pending update. `relaunch` restarts into it now. */
  install: (relaunch: boolean) => invoke<void>("update_install", { relaunch }),
  /** Persist "don't prompt for this version again". */
  ignore: (version: string) => invoke<void>("update_ignore", { version }),
};

export const listenUpdateAvailable = (
  handler: (e: UpdateAvailable) => void,
): Promise<UnlistenFn> =>
  listen<UpdateAvailable>("atlas:update-available", (e) => handler(e.payload));

export const listenUpdateProgress = (
  handler: (e: UpdateProgress) => void,
): Promise<UnlistenFn> =>
  listen<UpdateProgress>("atlas:update-progress", (e) => handler(e.payload));

export const listenUpdateError = (
  handler: (e: UpdateError) => void,
): Promise<UnlistenFn> =>
  listen<UpdateError>("atlas:update-error", (e) => handler(e.payload));

export const listenUpdateChecking = (
  handler: (e: UpdateChecking) => void,
): Promise<UnlistenFn> =>
  listen<UpdateChecking>("atlas:update-checking", (e) => handler(e.payload));
