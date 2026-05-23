// Claude Code setup state machine. Drives the banner above the message
// input and the gating of the input itself.
//
// Login flow:
//   1. User opens the dialog (from the banner or `/login`).
//   2. `loadAuthMethods()` calls `agents_list_auth_methods` against the
//      default agent (claude-agent-acp). The adapter advertised these in
//      its ACP `initialize` response.
//   3. User picks one. `runAuthMethod()` invokes `agents_run_auth_method`
//      which spawns the subprocess spec the adapter handed us. For the
//      Subscription path that's the adapter's vendored Node CLI with
//      `--cli auth login --claudeai` — it runs a localhost-loopback OAuth
//      flow (no copy/paste), opens the browser, catches the callback,
//      writes credentials to `~/.claude/.credentials.json`, exits.
//   4. On the `atlas:auth-run:done` event we re-probe `claude_status`. If
//      authenticated, we close the dialog. If not, surface the message
//      with a Retry button.

import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";
import { useDevFlagsStore } from "@/features/settings/stores/dev-flags-store";
import {
  agents,
  ensureDefaultAgent,
  listenAuthRunDone,
  type AuthMethodWire,
} from "@/features/chat/lib/agents-api";
import {
  claudeSetup,
  listenClaudeInstallDone,
  listenClaudeInstallProgress,
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
/** How long the green "Installed ✓" flash lingers before re-checking. */
const SUCCESS_FLASH_MS = 800;

/** Status of the in-flight auth subprocess. The dialog reads this to
 *  render: chooser (`idle`), waiting (`running`), or failure (`failed`).
 *  Success drops back to `idle` and `phase: "ready"` on the parent. */
export type AuthRunState =
  | { phase: "idle" }
  | { phase: "running"; methodId: string }
  | { phase: "failed"; message: string };

interface ClaudeSetupState {
  phase: ClaudeSetupPhase;
  version: string | null;
  authSummary: string | null;
  installLog: string[];
  installError: string | null;
  /** True while a login dialog should be visible. */
  loginDialogOpen: boolean;
  /** Methods loaded from the ACP adapter's initialize response. Empty
   *  until `loadAuthMethods()` resolves (which happens on dialog open). */
  authMethods: AuthMethodWire[];
  /** Sub-state for the in-flight subprocess (if any). */
  authRun: AuthRunState;
  actions: {
    refreshStatus: () => Promise<void>;
    install: () => Promise<void>;
    /** Populate `authMethods` from the live ACP adapter. Called when the
     *  dialog opens; cheap subsequent calls are no-ops (cached on the
     *  Rust side). */
    loadAuthMethods: () => Promise<void>;
    /** Invoke a method from `authMethods` by id. */
    runAuthMethod: (methodId: string) => Promise<void>;
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
    // Module-level handles so duplicate install or auth cycles can't
    // stack up. Each new flow tears down its predecessor's listeners.
    let installUnlistens: Array<() => void> = [];
    let authUnlistens: Array<() => void> = [];

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

    function clearAuthListeners() {
      for (const u of authUnlistens) {
        try {
          u();
        } catch {
          // ignore
        }
      }
      authUnlistens = [];
    }

    async function applyStatus(status: ClaudeStatus) {
      set({
        version: status.version,
        authSummary: status.auth_summary,
        phase: phaseFromStatus(status),
      });
    }

    async function refreshStatus(): Promise<void> {
      const current = get().phase;
      if (current === "installing" || current === "install-success") {
        return;
      }
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

    async function loadAuthMethods(): Promise<void> {
      if (useDevFlagsStore.getState().triggerClaudeInstall) {
        // Simulated chooser — exercise the dialog without an ACP agent.
        set({
          authMethods: [
            {
              id: "simulated-subscription",
              name: "Claude Subscription",
              description: "[simulated] Use Claude subscription",
              terminalCommand: null,
              terminalArgs: null,
              terminalLabel: null,
            },
            {
              id: "simulated-console",
              name: "Anthropic Console",
              description: "[simulated] API usage billing",
              terminalCommand: null,
              terminalArgs: null,
              terminalLabel: null,
            },
          ],
        });
        return;
      }
      try {
        const agent = await ensureDefaultAgent();
        const methods = await agents.listAuthMethods(agent.agent_id);
        set({ authMethods: methods });
      } catch (e) {
        console.warn("loadAuthMethods failed:", e);
        set({
          authMethods: [],
          authRun: {
            phase: "failed",
            message: `Couldn't load sign-in methods: ${String(e)}`,
          },
        });
      }
    }

    async function runAuthMethod(methodId: string): Promise<void> {
      clearAuthListeners();
      set({
        phase: "authing",
        authRun: { phase: "running", methodId },
      });

      // Dev override: skip the real spawn, flash a brief running state,
      // then mark ready so the post-auth UI is exercisable.
      if (useDevFlagsStore.getState().triggerClaudeInstall) {
        await new Promise((r) => setTimeout(r, 800));
        set({
          phase: "ready",
          loginDialogOpen: false,
          authSummary: "[simulated] Logged in",
          authRun: { phase: "idle" },
        });
        return;
      }

      // Subscribe to the done event BEFORE invoking so we never miss a
      // fast-completing run.
      const doneUnlisten = await listenAuthRunDone((p) => {
        clearAuthListeners();
        if (!p.success) {
          set({
            phase: "not-authed",
            authRun: {
              phase: "failed",
              message:
                p.message ?? "Sign-in subprocess didn't complete successfully.",
            },
          });
          return;
        }
        // Re-probe status. The subprocess wrote credentials to disk
        // before exiting, so the next `claude_status` should report
        // authenticated.
        void (async () => {
          try {
            const status = await claudeSetup.status();
            await applyStatus(status);
            if (get().phase === "ready") {
              set({
                loginDialogOpen: false,
                authRun: { phase: "idle" },
              });
            } else {
              set({
                authRun: {
                  phase: "failed",
                  message:
                    "Sign-in finished but the CLI still reports unauthenticated. Try again.",
                },
              });
            }
          } catch (e) {
            set({
              authRun: {
                phase: "failed",
                message: `Couldn't verify status: ${String(e)}`,
              },
            });
          }
        })();
      });
      authUnlistens = [doneUnlisten];

      try {
        const agent = await ensureDefaultAgent();
        await agents.runAuthMethod(agent.agent_id, methodId);
      } catch (e) {
        clearAuthListeners();
        set({
          phase: "not-authed",
          authRun: {
            phase: "failed",
            message: `Couldn't start sign-in: ${String(e)}`,
          },
        });
      }
    }

    return {
      phase: "checking",
      version: null,
      authSummary: null,
      installLog: [],
      installError: null,
      loginDialogOpen: false,
      authMethods: [],
      authRun: { phase: "idle" },
      actions: {
        refreshStatus,
        install,
        loadAuthMethods,
        runAuthMethod,
        openLoginDialog: () =>
          set({
            loginDialogOpen: true,
            authRun: { phase: "idle" },
          }),
        closeLoginDialog: () => {
          clearAuthListeners();
          set({
            loginDialogOpen: false,
            authRun: { phase: "idle" },
          });
          if (get().phase === "authing") {
            set({ phase: "not-authed" });
          }
        },
      },
    };
  }),
);
