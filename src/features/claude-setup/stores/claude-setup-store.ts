// Claude Code setup state machine. Drives the banner above the message
// input and the gating of the input itself. See the plan file for the
// state-transition diagram.

import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";
import { useDevFlagsStore } from "@/features/settings/stores/dev-flags-store";
import {
  claudeSetup,
  listenClaudeInstallDone,
  listenClaudeInstallProgress,
  type ClaudeAuthMethod,
  type ClaudeStatus,
} from "../lib/claude-setup-api";

export type ClaudeSetupPhase =
  | "checking"
  | "not-installed"
  | "installing"
  | "install-success"
  | "install-failed"
  | "not-authed"
  | "authing"
  | "ready";

/** Cap the in-memory log so a chatty install doesn't bloat the store. */
const LOG_LINE_CAP = 50;
/** How fast we poll `claude_status` after kicking off the subscription
 *  OAuth flow. The CLI writes credentials once the browser callback
 *  arrives; this picks that up so the UI re-checks. */
const AUTH_POLL_MS = 1500;
/** How long the green "Installed ✓" flash lingers before re-checking. */
const SUCCESS_FLASH_MS = 800;

interface ClaudeSetupState {
  phase: ClaudeSetupPhase;
  version: string | null;
  authSummary: string | null;
  installLog: string[];
  installError: string | null;
  /** True while a login dialog should be visible (separate from `phase`
   *  so the dialog can stay open across an `authing` → poll cycle). */
  loginDialogOpen: boolean;
  actions: {
    refreshStatus: () => Promise<void>;
    install: () => Promise<void>;
    authLogin: (method: ClaudeAuthMethod) => Promise<void>;
    openLoginDialog: () => void;
    closeLoginDialog: () => void;
  };
}

function phaseFromStatus(status: ClaudeStatus): ClaudeSetupPhase {
  if (!status.installed) return "not-installed";
  if (!status.authenticated) return "not-authed";
  return "ready";
}

export const useClaudeSetupStore = createSelectors(
  create<ClaudeSetupState>((set, get) => {
    // Module-level handles so duplicate install or auth-poll cycles can't
    // stack up. Each new flow tears down its predecessor's listeners.
    let installUnlistens: Array<() => void> = [];
    let authPollTimer: ReturnType<typeof setInterval> | null = null;

    function clearInstallListeners() {
      for (const u of installUnlistens) {
        try {
          u();
        } catch {
          // ignore
        }
      }
      installUnlistens = [];
    }

    function stopAuthPoll() {
      if (authPollTimer !== null) {
        clearInterval(authPollTimer);
        authPollTimer = null;
      }
    }

    async function applyStatus(status: ClaudeStatus) {
      set({
        version: status.version,
        authSummary: status.auth_summary,
        phase: phaseFromStatus(status),
      });
    }

    async function refreshStatus(): Promise<void> {
      // Don't flip back to `checking` if we're mid-install/auth — the
      // transient phases own the banner during those flows.
      const current = get().phase;
      if (current === "installing" || current === "install-success") {
        return;
      }
      // Dev override: pin the banner to "not-installed" so we can
      // visually exercise the install + sign-in UI without touching the
      // real CLI on this machine.
      if (useDevFlagsStore.getState().triggerClaudeInstall) {
        set({
          phase: "not-installed",
          version: null,
          authSummary: null,
        });
        return;
      }
      set({ phase: "checking" });
      try {
        const status = await claudeSetup.status();
        await applyStatus(status);
      } catch (e) {
        // If the IPC itself fails (extremely rare), treat it as
        // not-installed so the user has a recovery affordance.
        console.warn("claude_status invoke failed:", e);
        set({
          phase: "not-installed",
          version: null,
          authSummary: null,
        });
      }
    }

    async function install(): Promise<void> {
      clearInstallListeners();
      set({
        phase: "installing",
        installLog: [],
        installError: null,
      });

      // Dev override: simulate the install lifecycle so the UI can be
      // exercised without curl-bashing the real installer on this machine.
      if (useDevFlagsStore.getState().triggerClaudeInstall) {
        const fakeLines = [
          "[simulated] Downloading claude-code-cli…",
          "[simulated] Verifying checksum…",
          "[simulated] Linking ~/.local/bin/claude…",
          "[simulated] Done.",
        ];
        for (const line of fakeLines) {
          await new Promise((r) => setTimeout(r, 350));
          set((s) => ({ installLog: [...s.installLog, line] }));
        }
        await new Promise((r) => setTimeout(r, 200));
        set({ phase: "install-success" });
        setTimeout(() => {
          // After the tick, drop into the auth-required state so the
          // sign-in dialog can be exercised too.
          set({ phase: "not-authed" });
        }, SUCCESS_FLASH_MS);
        return;
      }

      const progressUnlisten = await listenClaudeInstallProgress((p) => {
        set((s) => {
          const next = [...s.installLog, p.line];
          if (next.length > LOG_LINE_CAP) next.splice(0, next.length - LOG_LINE_CAP);
          return { installLog: next };
        });
      });
      const doneUnlisten = await listenClaudeInstallDone((p) => {
        if (p.success) {
          set({ phase: "install-success" });
          setTimeout(() => {
            void get().actions.refreshStatus();
          }, SUCCESS_FLASH_MS);
        } else {
          set({
            phase: "install-failed",
            installError:
              `Install exited with code ${p.exit_code ?? "(none)"}.` +
              " See the log above for details.",
          });
        }
        clearInstallListeners();
      });
      installUnlistens = [progressUnlisten, doneUnlisten];

      try {
        await claudeSetup.install();
      } catch (e) {
        clearInstallListeners();
        set({
          phase: "install-failed",
          installError: `Failed to start installer: ${String(e)}`,
        });
      }
    }

    async function authLogin(method: ClaudeAuthMethod): Promise<void> {
      stopAuthPoll();
      set({ phase: "authing" });

      // Dev override: simulate a brief auth handshake regardless of
      // method, then flip to ready so the post-sign-in UI is reachable.
      if (useDevFlagsStore.getState().triggerClaudeInstall) {
        await new Promise((r) => setTimeout(r, 700));
        set({
          phase: "ready",
          loginDialogOpen: false,
          authSummary: "[simulated] Logged in",
        });
        return;
      }

      try {
        await claudeSetup.authLogin(method);
      } catch (e) {
        set({
          phase: "not-authed",
          installError: `Sign-in failed: ${String(e)}`,
          loginDialogOpen: true,
        });
        return;
      }

      // API-key path completes synchronously on the Rust side — one
      // refresh is enough. Subscription path needs polling because the
      // CLI's browser callback writes credentials asynchronously.
      if (method.kind === "api_key") {
        await refreshStatus();
        if (get().phase === "ready") {
          set({ loginDialogOpen: false });
        }
        return;
      }

      // Subscription: poll until authed or until the user closes the
      // dialog. The poll auto-stops when phase flips to `ready` OR when
      // the dialog is dismissed.
      authPollTimer = setInterval(() => {
        if (!get().loginDialogOpen) {
          stopAuthPoll();
          return;
        }
        void (async () => {
          try {
            const status = await claudeSetup.status();
            if (status.authenticated) {
              stopAuthPoll();
              await applyStatus(status);
              set({ loginDialogOpen: false });
            }
          } catch {
            // ignore transient probe failures
          }
        })();
      }, AUTH_POLL_MS);
    }

    return {
      phase: "checking",
      version: null,
      authSummary: null,
      installLog: [],
      installError: null,
      loginDialogOpen: false,
      actions: {
        refreshStatus,
        install,
        authLogin,
        openLoginDialog: () => set({ loginDialogOpen: true }),
        closeLoginDialog: () => {
          stopAuthPoll();
          set({ loginDialogOpen: false });
          // If we were stuck in `authing` because of a cancelled
          // subscription flow, revert so the banner re-prompts.
          if (get().phase === "authing") {
            set({ phase: "not-authed" });
          }
        },
      },
    };
  }),
);
