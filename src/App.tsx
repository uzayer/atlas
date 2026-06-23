import { startTransition, useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AppLayout } from "@/features/layout/components/app-layout";
import { AppContextMenu } from "@/components/app-context-menu";
import { CommandPalette } from "@/components/command-palette";
import { NewTabPalette } from "@/components/new-tab-palette";
import { LayoutSwitcher } from "@/features/layout/components/layout-switcher";
import { SearchOverlay } from "@/components/search-overlay";
import { useHotkeys } from "@/hooks/use-hotkey";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import {
  useProjectStore,
  type AppStateWire,
} from "@/features/project/stores/project-store";
import { useChatStore } from "@/features/chat/stores/chat-store";
import {
  listenAgents,
  resetDefaultAgent,
} from "@/features/chat/lib/agents-api";
import type { PendingPermission } from "@/types/acp";
import type { AgentDelta } from "@/types/agents";
import { SWITCHABLE_AGENTS } from "@/types/agent";
import { FilePicker } from "@/features/file-picker/components/file-picker";
import { HintOverlay } from "@/features/hint-nav/components/hint-overlay";
import { BrowserOverlayWatcher } from "@/features/browser/components/browser-overlay-watcher";
import { fileIndex, openFileIndex, markFileIndexClosed } from "@/features/file-picker/lib/file-picker-api";
import { activeWorkspaceId } from "@/features/workspaces/lib/active-workspace";
import { useWorkspaceStore } from "@/features/workspaces/stores/workspace-store";
import { pickAndAddWorkspace } from "@/features/workspaces/lib/pick-workspace";
import { flushAll } from "@/features/workspaces/lib/flush-registry";
import { captureSnapshot } from "@/features/workspaces/lib/workspace-snapshot";
import { useExplorerStore } from "@/features/explorer/stores/explorer-store";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  useRecentFilesStore,
  ensureRecentFilesListener,
  type RecentFile,
} from "@/features/chat/stores/recent-files-store";
import { useRecentChatsStore } from "@/features/workspaces/stores/recent-chats-store";
import { stripInjectedContext } from "@/features/chat/lib/atlas-context";
import { useClaudeSetupStore } from "@/features/claude-setup/stores/claude-setup-store";
import { useNodeSetupStore } from "@/features/node-setup/stores/node-setup-store";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { logEvent } from "@/features/log/lib/log";
import { warmMarkdownWorker } from "@/lib/markdown-cache";
import { useNotificationsStore } from "@/features/notifications/stores/notifications-store";
import { NotificationPanel } from "@/features/notifications/components/notification-panel";
import { Toaster } from "sonner";
import { clampScale, SCALE_STEP, DEFAULT_SCALE } from "@/features/settings/lib/ui-scale";

// Interface-zoom helpers (⌘+/⌘-/⌘0). They read + write the persisted
// `uiScale` setting; `updateSettings` applies it to the native WebView zoom.
function stepZoom(delta: number) {
  const { settings, actions } = useProjectStore.getState();
  actions.updateSettings({ uiScale: clampScale(settings.uiScale + delta) });
}
const zoomIn = () => stepZoom(SCALE_STEP);
const zoomOut = () => stepZoom(-SCALE_STEP);
const zoomReset = () =>
  useProjectStore.getState().actions.updateSettings({ uiScale: DEFAULT_SCALE });

export function App() {
  // Probe Claude Code (installed? authed?) on mount. Drives the banner
  // above the message composer and the hard-disabled state of the input
  // when the CLI isn't ready. Fast — two parallel subprocesses, totals
  // <100ms on a warm machine.
  useEffect(() => {
    // Probe the Node runtime first (the ACP agents launch via `npx`). If it's
    // missing or too old, the store auto-installs the latest LTS via the
    // bundled nvm in the background and re-runs ACP discovery when ready.
    void useNodeSetupStore.getState().actions.check();
    void useClaudeSetupStore.getState().actions.refreshStatus();
  }, []);

  // Refresh the `atlas` CLI helper at `~/.local/bin/atlas` on every
  // launch. Fire-and-forget; an older or hand-edited copy gets
  // replaced with the current version. Failures are non-fatal — the
  // app still works without the helper, the user just can't type
  // `atlas ./` in their terminal until they hit the install button
  // in Settings → General.
  useEffect(() => {
    void invoke("cli_install_helper").catch((e) => {
      console.warn("atlas CLI helper refresh failed:", e);
    });
  }, []);

  // Warm-launch CLI: when `atlas <path>` runs while Atlas is already open, the
  // Rust single-instance callback forwards the folder here. The app is already
  // hydrated, so we just ADD it to the workspace list and switch to it (no race
  // with hydration). `openProject` → `addWorkspace` dedupes by path.
  useEffect(() => {
    const unlisten = listen<string>("atlas:cli-open-project", (event) => {
      const path = event.payload;
      if (!path) return;
      logEvent({
        source: "atlas",
        kind: "cli-launch-open-project",
        summary: `Adding workspace from CLI (warm launch): ${path}`,
        status: "success",
        payload: { path },
      });
      void useProjectStore.getState().actions.openProject(path);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  // Close-active-tab from the native menu (Cmd+W). The embedded browser is a
  // separate native webview, so its Cmd+W can't reach the React `useHotkeys`
  // handler — it falls through to the menu's "Close Tab" item, which emits this
  // event. Mirrors the Cmd+W hotkey: close whichever tab is active.
  useEffect(() => {
    const unlisten = listen("atlas:close-active-tab", () => {
      const current = useLayoutStore.getState().activeTabId;
      if (current) useLayoutStore.getState().actions.closeTab(current);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  // NOTE: we intentionally do NOT wipe localStorage on boot anymore. Several
  // stores legitimately persist there via zustand `persist` — the workspace
  // "Chats" list (`atlas-recent-chats`), layout prefs (`atlas-layout-prefs`),
  // the review provider/model selection — and a blanket clear was silently
  // dropping all of them on every restart. Each store carries its own
  // `version`/`migrate`, so stale keys from old builds are handled per-store.

  // One-shot bootstrap of the Rust-owned `AppState` (currentProject +
  // recentProjects). Replaces the zustand `persist` middleware that used
  // to hydrate from localStorage. The Tauri invoke is async but fast
  // (~5–20 ms warm); until it resolves the WelcomeScreen and project-aware
  // panels render their empty/loading states.
  //
  // `startTransition` marks the welcome → project layout swap as non-urgent
  // so React can pause reconciliation between component subtrees and keep
  // the welcome UI interactive while the project layout mounts.
  //
  // Once hydration is done (success or failure) we dispatch `atlas:app-ready`
  // — the inline script in `index.html` listens for it and removes the
  // boot skeleton.
  useEffect(() => {
    let cancelled = false;
    const signalReady = () => {
      const flag = window as unknown as { __atlasAppReady?: boolean };
      if (flag.__atlasAppReady) return;
      flag.__atlasAppReady = true;
      window.dispatchEvent(new CustomEvent("atlas:app-ready"));
    };

    (async () => {
      // A terminal `atlas <path>` launch stashes the path in Rust (single-shot,
      // so a window reload won't re-trigger). Consume it BEFORE hydrating: the
      // CLI project must be ADDED to the workspace list and switched to, but
      // hydrate replaces that list and fires its own `switchTo` — which would
      // both clobber the CLI workspace and swallow the CLI switch (`switching`
      // guard). So we suppress hydrate's auto-switch when a CLI path is present
      // and perform the CLI open as the sole, final switch.
      const cliPath = await invoke<string | null>("cli_take_initial_project_path").catch(
        () => null,
      );
      try {
        const payload = await invoke<AppStateWire>("bootstrap_app_state");
        if (cancelled) return;
        startTransition(() => {
          useProjectStore
            .getState()
            .actions.hydrate(payload, { skipActiveSwitch: !!cliPath });
        });
      } catch (e) {
        console.warn("bootstrap_app_state failed; starting empty:", e);
        if (!cancelled) {
          startTransition(() => {
            useProjectStore.getState().actions.hydrate(
              {
                currentProject: null,
                recentProjects: [],
                version: 1,
              },
              { skipActiveSwitch: !!cliPath },
            );
          });
        }
      } finally {
        if (!cancelled) {
          if (cliPath) {
            logEvent({
              source: "atlas",
              kind: "cli-launch-open-project",
              summary: `Adding workspace from CLI argv: ${cliPath}`,
              status: "success",
              payload: { path: cliPath },
            });
            await useProjectStore
              .getState()
              .actions.openProject(cliPath)
              .catch((err) => {
                logEvent({
                  source: "atlas",
                  kind: "cli-launch-open-project-failed",
                  summary: `openProject failed: ${String(err)}`,
                  status: "failure",
                  payload: { error: String(err) },
                });
              });
          }
          signalReady();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [newTabPaletteOpen, setNewTabPaletteOpen] = useState(false);
  const [layoutSwitcherOpen, setLayoutSwitcherOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const {
    toggleLeftPanel,
    toggleRightPanel,
    toggleBottomPanel,
    toggleChatSidebar,
    toggleModelChatSidebar,
    toggleTabBar,
    addTab,
    setActiveTab,
    closeTab,
    activateTabByIndex,
    cycleTab,
    addGroup,
    closeGroup,
    focusAdjacentGroup,
    toggleZenMode,
  } = useLayoutStore.use.actions();
  const tabs = useLayoutStore.use.tabs();
  const activeTabId = useLayoutStore.use.activeTabId();
  const groupOrder = useLayoutStore.use.groupOrder();
  const focusedGroupId = useLayoutStore.use.focusedGroupId();

  // ⌘J — toggle the terminal WITHIN the focused split column (not a global
  // instance), so it respects which pane you're working in.
  const toggleTerminal = () => {
    const st = useLayoutStore.getState();
    const g = st.focusedGroupId;
    const groupOf = (t: { groupId?: string }) => t.groupId ?? "main";
    const groupTabs = st.tabs.filter((t) => groupOf(t) === g);
    const activeTab = st.tabs.find((t) => t.id === st.activeByGroup[g]);

    const focusTerminalSoon = () => {
      // Ask the active block terminal to focus once the tab is mounted/visible.
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent("atlas:focus-terminal"));
      });
    };

    if (activeTab?.type === "terminal") {
      // Toggle away: the most-recent non-terminal tab in THIS column (history),
      // else the first non-terminal tab in the column.
      const back = [...st.tabHistory].reverse().find((id) => {
        const t = st.tabs.find((x) => x.id === id);
        return t && groupOf(t) === g && t.type !== "terminal";
      });
      const target = back ?? groupTabs.find((t) => t.type !== "terminal")?.id;
      if (target) setActiveTab(target);
      return;
    }

    const existing = groupTabs.find((t) => t.type === "terminal");
    if (existing) {
      setActiveTab(existing.id);
      focusTerminalSoon();
    } else {
      addTab({
        id: `terminal-${Date.now()}`,
        type: "terminal",
        title: "Terminal",
        closable: true,
        dirty: false,
        data: {},
      });
      focusTerminalSoon();
    }
  };
  const currentProject = useProjectStore.use.currentProject();

  // Global agent event bus. One listener routes atlas-agents SessionDelta
  // events into the chat-store, queues permission requests for the
  // PermissionModal, and resets the lazy agent handle on disconnect.
  //
  // ACP events arrive at the rate the agent streams them — for a
  // tool-heavy turn (e.g. "read 30 files") that's ~60 `tool_call` /
  // `tool_call_update` events plus a continuous text chunk stream. Per
  // event without batching: 1 immer draft + 1 subscriber notification
  // + 1 `MessagesList` re-render (and the virtualizer's
  // `measureElement` runs). On a fast turn that pegs the main thread.
  //
  // Coalesce every frame via RAF and apply the whole batch in ONE
  // immer pass through `applyAgentBatch`. Dedup `tool_call_upserted`
  // by `(session, tool_call.id)` (last-write-wins, original position
  // preserved) so a tool that flips through pending → running →
  // completed in a single frame only contributes once. Other deltas
  // go in strict wire order — `message_appended` before subsequent
  // tool calls so a new assistant message anchors them correctly,
  // etc.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    // All deltas — text/thinking chunks INCLUDED — buffer here in strict wire
    // order. Consecutive same-session text (or thinking) chunks coalesce into
    // the trailing entry, but a `message_appended`/tool delta between two text
    // runs breaks the run so ordering is preserved. (Previously text was
    // bucketed separately and applied BEFORE other deltas, which reordered the
    // anchoring `message_appended` after its text — invisible for ACP agents
    // whose IPC latency spread deltas across frames, but the in-process Cersei
    // agent emits a whole turn in one frame and the text shattered into
    // mis-ordered fragments.)
    const pendingDeltas: AgentDelta[] = [];
    const toolDeltaPos = new Map<string, number>(); // dedup key → index in pendingDeltas
    let rafId: number | null = null;

    // "Is Atlas actually in front of the user?" — tracked via the NATIVE window
    // focus, NOT web focus/blur. The web events keep reporting "focused" when
    // Atlas is fullscreen on its own macOS Space and the user swipes to another
    // desktop (the webview never blurs), so notifications would wrongly stay
    // suppressed. The native key-window status flips correctly on a Space
    // switch / app deactivation, which is the signal we actually want.
    let windowFocused = true;
    let unlistenFocus: (() => void) | null = null;
    const appWindow = getCurrentWindow();
    void appWindow
      .isFocused()
      .then((f) => {
        windowFocused = f;
      })
      .catch(() => {});
    // Front-load the "cold wake" after the window has been idle/occluded: WebKit
    // throttles the WKWebView's main thread + rAF + layout while inactive, so the
    // first interaction (e.g. scrolling the chat) eats the catch-up. Firing this
    // on the focus/visibility RISING edge lets listeners (chat virtualizer,
    // markdown worker) warm the pipeline before the user touches anything.
    const signalActive = () => window.dispatchEvent(new CustomEvent("atlas:window-active"));
    void appWindow
      .onFocusChanged(({ payload: focused }) => {
        if (focused && !windowFocused) signalActive();
        windowFocused = focused;
      })
      .then((un) => {
        unlistenFocus = un;
      })
      .catch(() => {});
    // Space switches / occlusion don't always flip native key-window focus, so
    // also wake on the page becoming visible again.
    const onVisible = () => {
      if (document.visibilityState === "visible") signalActive();
    };
    document.addEventListener("visibilitychange", onVisible);

    // ── Idle-while-focused cold wake ─────────────────────────────────────────
    // The focus/visibility edges above never fire when Atlas stays the focused,
    // visible window through a long idle stretch (the user steps away without
    // switching apps or Spaces). WebKit still throttles the idle main thread and
    // the OS can reclaim JIT/worker pages, so the first interactions on return
    // are cold and recover only gradually (the "slow for ~10-15s" symptom). Two
    // mitigations:
    //   1. Fire the same warm-up on the FIRST real interaction after an idle gap
    //      so the whole pipeline (chat virtualizer, graphs, markdown worker)
    //      warms at once instead of path-by-path as each is lazily exercised.
    //   2. While focused+visible, ping the markdown worker on an idle cadence so
    //      WebKit doesn't suspend it out from under us (a suspended worker costs
    //      a 3s watchdog → main-thread sync fallback on the first big message).
    const IDLE_RETURN_MS = 30_000;
    const KEEP_WARM_MS = 20_000;
    let lastActivityAt = Date.now();
    const onUserActivity = () => {
      const now = Date.now();
      if (now - lastActivityAt > IDLE_RETURN_MS) signalActive();
      lastActivityAt = now;
    };
    // Discrete inputs only (not pointermove) to keep this effectively free.
    window.addEventListener("pointerdown", onUserActivity, { passive: true });
    window.addEventListener("keydown", onUserActivity, { passive: true });
    window.addEventListener("wheel", onUserActivity, { passive: true });
    const keepWarm = window.setInterval(() => {
      if (windowFocused && document.visibilityState === "visible") {
        warmMarkdownWorker();
      }
    }, KEEP_WARM_MS);

    let permissionState: "unknown" | "granted" | "denied" = "unknown";
    // Establish notification permission EAGERLY at startup. The old lazy path
    // only asked the OS the first time a notification fired while unfocused —
    // so if every agent turn finished while Atlas was focused, permission was
    // never granted and the first real (background) notification was lost to
    // the permission prompt. Priming it here means later notifications just
    // fire. (Best-effort; macOS still needs the app code-signed to deliver.)
    void (async () => {
      try {
        permissionState = (await isPermissionGranted())
          ? "granted"
          : (await requestPermission()) === "granted"
            ? "granted"
            : "denied";
      } catch {
        /* permission unavailable — notifications silently no-op */
      }
    })();
    const notifyAgentDone = async () => {
      if (windowFocused) return;
      try {
        if (permissionState === "unknown") {
          const granted = (await isPermissionGranted())
            ? true
            : (await requestPermission()) === "granted";
          permissionState = granted ? "granted" : "denied";
        }
        if (permissionState !== "granted") return;
        const proj = useProjectStore.getState().currentProject;
        const projectName = proj?.name ?? "Atlas";
        sendNotification({
          title: `Atlas — ${projectName}`,
          body: "Agent task finished.",
        });
      } catch (e) {
        console.warn("agent-done notification failed:", e);
      }
    };

    // Sibling of notifyAgentDone — fires when the agent issues a
    // permission_request and the window isn't focused. Shares the
    // permission state machine and focus tracker above so we never
    // double-prompt for OS notification access.
    const notifyPermissionRequested = async (toolTitle: string) => {
      if (windowFocused) return;
      try {
        if (permissionState === "unknown") {
          const granted = (await isPermissionGranted())
            ? true
            : (await requestPermission()) === "granted";
          permissionState = granted ? "granted" : "denied";
        }
        if (permissionState !== "granted") return;
        const proj = useProjectStore.getState().currentProject;
        const projectName = proj?.name ?? "Atlas";
        sendNotification({
          title: `Atlas — ${projectName} needs permission`,
          body: `Approve "${toolTitle}" to continue.`,
        });
      } catch (e) {
        console.warn("permission-request notification failed:", e);
      }
    };

    const flush = () => {
      rafId = null;
      if (pendingDeltas.length === 0) return;
      const deltas = pendingDeltas.slice();
      pendingDeltas.length = 0;
      toolDeltaPos.clear();
      useChatStore.getState().actions.applyAgentBatch({ texts: [], thoughts: [], deltas });
    };
    // Coalesce a streaming text/thinking chunk into the trailing pendingDeltas
    // entry when it's the same kind + session; otherwise append in order. Keeps
    // the per-frame coalescing win without divorcing text from its wire order.
    const bufferChunk = (env: AgentDelta) => {
      const last = pendingDeltas[pendingDeltas.length - 1];
      if (
        last &&
        (last.kind === "text_chunk" || last.kind === "thinking_chunk") &&
        last.kind === env.kind &&
        last.session_id === env.session_id
      ) {
        pendingDeltas[pendingDeltas.length - 1] = {
          ...last,
          delta: last.delta + (env as typeof last).delta,
        };
      } else {
        pendingDeltas.push(env);
      }
    };
    const schedule = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(flush);
    };

    const bufferDelta = (env: AgentDelta) => {
      // Coalesce same-id `tool_call_upserted` events: replace the
      // entry at the position the tool first appeared so the latest
      // state lands and ordering vs other events stays correct.
      if (env.kind === "tool_call_upserted") {
        const key = `${env.session_id}::${env.tool_call.id}`;
        const existing = toolDeltaPos.get(key);
        if (existing !== undefined) {
          pendingDeltas[existing] = env;
          return;
        }
        toolDeltaPos.set(key, pendingDeltas.length);
      }
      pendingDeltas.push(env);
    };

    // Resolve the chat tab + title for an ACP session, for in-app notifications.
    const agentSessionInfo = (acpSessionId: string) => {
      const sessions = useChatStore.getState().sessions;
      for (const [tabId, s] of Object.entries(sessions)) {
        if (s.acpSessionId === acpSessionId) return { tabId, title: s.title };
      }
      return { tabId: undefined as string | undefined, title: undefined as string | undefined };
    };
    const notify = () => useNotificationsStore.getState().actions;

    // Record a chat into the sidebar "Chats" (recently-invoked) list whenever a
    // session sees meaningful activity. Resolves project + title from the chat
    // session that owns this acpSessionId.
    const recordRecentChat = (acpSessionId: string) => {
      const sessions = useChatStore.getState().sessions;
      for (const [tabId, s] of Object.entries(sessions)) {
        if (s.acpSessionId !== acpSessionId) continue;
        const path = s.workingDirectory;
        if (!path) return;
        useRecentChatsStore.getState().actions.record({
          tabId,
          projectPath: path,
          projectName: path.split("/").pop() || path,
          // Strip any Atlas-injected memory scaffolding the title may carry
          // (resumed sessions); a dirty fragment cleans to "" → fall back.
          title: stripInjectedContext(s.title) || "Chat",
          status: s.status,
          agentType: s.agentType,
          acpSessionId: s.acpSessionId,
          updatedAt: Date.now(),
        });
        return;
      }
    };

    listenAgents((env) => {
      if (cancelled) return;
      if (
        env.kind === "status" ||
        env.kind === "message_appended" ||
        env.kind === "turn_finished"
      ) {
        recordRecentChat(env.session_id);
      }
      const actions = useChatStore.getState().actions;
      switch (env.kind) {
        case "text_chunk":
          bufferChunk(env);
          schedule();
          return;
        case "thinking_chunk":
          bufferChunk(env);
          schedule();
          return;
        case "permission_request": {
          // Permission requests block the agent waiting for the user
          // — apply synchronously so the modal opens on the very next
          // tick, not the next RAF (which can be ~16 ms away or more
          // if the frame is busy with a flush of accumulated chunks).
          actions.pushPermission({
            agentId: env.agent_id,
            acpSessionId: env.session_id,
            requestId: env.request_id,
            toolCall: env.tool_call as PendingPermission["toolCall"],
            options: env.options as PendingPermission["options"],
          });
          // OS notification so the user sees the request even with
          // Atlas in the background. Matches the PermissionModal's own
          // title-extraction logic.
          const tc = env.tool_call as Record<string, unknown> | undefined;
          const toolTitle =
            (typeof tc?.title === "string" && tc.title) ||
            (typeof tc?.kind === "string" && tc.kind) ||
            "tool call";
          void notifyPermissionRequested(toolTitle);
          {
            const info = agentSessionInfo(env.session_id);
            notify().add({
              kind: "permission",
              source: "agent",
              title: "Permission needed",
              body: `${info.title ? `${info.title} — ` : ""}approve "${toolTitle}" to continue.`,
              sessionId: env.session_id,
              tabId: info.tabId,
            });
          }
          return;
        }
        case "permission_resolved":
          actions.popPermission(env.session_id, env.request_id);
          return;
        case "agent_disconnected":
          // Flush whatever's buffered before tearing the agent down
          // so we don't lose a final chunk to the post-disconnect
          // discard.
          if (rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
          }
          flush();
          actions.clearPermissionsForAgent(env.agent_id);
          resetDefaultAgent();
          logEvent({
            source: "atlas",
            kind: "agent-disconnected",
            summary: "Agent process disconnected; default agent handle reset",
            status: "failure",
            payload: { agentId: env.agent_id },
          });
          return;
        case "turn_finished":
          // Still pass through to the chat-store so session.status
          // flips back to "idle" (see chat-store.ts:591).
          bufferDelta(env);
          schedule();
          logEvent({
            source: "atlas",
            kind: "agent-turn-finished",
            summary: `Agent turn finished (${env.stop_reason})`,
            status: env.stop_reason === "cancelled" ? "failure" : "success",
            payload: {
              agentId: env.agent_id,
              sessionId: env.session_id,
              stopReason: env.stop_reason,
            },
          });
          // Fire OS notification if the window isn't focused. Skip
          // user-cancelled turns — that's a click the user just made,
          // they don't need to be told about it.
          if (env.stop_reason !== "cancelled") {
            void notifyAgentDone();
            const info = agentSessionInfo(env.session_id);
            notify().add({
              kind: "agent-done",
              source: "agent",
              title: info.title || "Agent",
              body: "Task finished.",
              sessionId: env.session_id,
              tabId: info.tabId,
            });
          }
          return;
        case "turn_failed": {
          bufferDelta(env);
          schedule();
          const info = agentSessionInfo(env.session_id);
          notify().add({
            kind: "agent-failed",
            source: "agent",
            title: info.title || "Agent failed",
            body: (env as { error?: string }).error || "The agent run failed.",
            sessionId: env.session_id,
            tabId: info.tabId,
          });
          return;
        }
        default:
          bufferDelta(env);
          schedule();
          return;
      }
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });

    // Agent spawn is deferred until the user first focuses the message input
    // (see `MessageInput`'s focus handler). `npx -y @zed-industries/claude-code-acp`
    // can take 10–30s on a cold npm cache; doing it at app boot adds visible
    // latency to first paint and races the project-rehydration cascade. The
    // user is unlikely to send a prompt within the first few hundred ms of
    // focusing the composer, so the spawn finishes in the background while
    // they type.

    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      unlistenFocus?.();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pointerdown", onUserActivity);
      window.removeEventListener("keydown", onUserActivity);
      window.removeEventListener("wheel", onUserActivity);
      window.clearInterval(keepWarm);
      unlisten?.();
    };
  }, []);

  // Live file-tree updates. The fileindex watcher (started in
  // `fileindex_open_project`) emits `atlas:explorer:changed` with the
  // set of parent directories touched in each debounced batch. We
  // reconcile each loaded directory in place — agent-side file writes
  // appear in the tree without the user touching a refresh button.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    type Payload = { workspaceId?: string; dirs: string[]; fullRefresh: boolean };
    listen<Payload>("atlas:explorer:changed", (e) => {
      if (cancelled) return;
      // Ignore changes from a backgrounded workspace's resident watcher —
      // only the active workspace's explorer should reconcile.
      const active = activeWorkspaceId();
      if (e.payload.workspaceId && active && e.payload.workspaceId !== active) {
        return;
      }
      const actions = useExplorerStore.getState().actions;
      const { dirs, fullRefresh } = e.payload;
      if (fullRefresh) {
        void actions.refresh();
        return;
      }
      for (const dir of dirs) {
        void actions.reconcileDirectory(dir);
      }
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Auto-save editor state when tabs change
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (!currentProject) return;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      useLayoutStore.getState().actions.saveEditorState(currentProject.path);
    }, 1000);
    return () => clearTimeout(saveTimerRef.current);
  }, [tabs.length, activeTabId, groupOrder, focusedGroupId, currentProject]);

  // Maintain the chat-mention picker's "recent files" queue. Push whenever
  // an editor/media/unsupported tab appears whose data.filePath we haven't
  // seen yet in this session. Centralizing here means every call site that
  // opens a file (FilePicker, explorer, message-item link, analysis,
  // git diff, …) feeds the recents list without each having to remember to.
  const seenFileTabsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const projectPath = currentProject?.path ?? "";
    for (const t of tabs) {
      if (t.type !== "editor" && t.type !== "media" && t.type !== "unsupported")
        continue;
      const absPath = (t.data as Record<string, unknown> | undefined)?.filePath as
        | string
        | undefined;
      if (!absPath) continue;
      if (seenFileTabsRef.current.has(absPath)) continue;
      seenFileTabsRef.current.add(absPath);
      const rel =
        projectPath && absPath.startsWith(projectPath + "/")
          ? absPath.slice(projectPath.length + 1)
          : absPath.split("/").pop() ?? absPath;
      useRecentFilesStore.getState().actions.push({ absPath, rel });
    }
  }, [tabs, currentProject?.path]);

  // FileIndex lifecycle: open the backend file index on project change,
  // close on project clear. The backend handles fs-watch and incremental
  // updates from that point — Cmd+P queries against the live index.
  useEffect(() => {
    if (!currentProject) {
      fileIndex.closeProject().catch(() => {});
      markFileIndexClosed();
      void invoke("git_watch_stop").catch(() => {});
      void invoke("recent_files_close_project").catch(() => {});
      // Drop the mention cache so the @-picker doesn't briefly
      // surface the previous project's notes / symbols on a fresh
      // open. Replays land via knowledge/analysis store hydration.
      void invoke("mention_cache_clear").catch(() => {});
      return;
    }
    markFileIndexClosed();
    const workspaceId = activeWorkspaceId();
    void openFileIndex(currentProject.path);
    // Git watcher: emits `atlas:git-changed` on commit / checkout /
    // branch ops. Replaces the 3-second polling that git-graph-panel
    // used to do via `refetchInterval` on `git_graph_signature`.
    // Keyed by workspace so each open workspace keeps its own resident watcher.
    void invoke("git_watch_start", {
      projectPath: currentProject.path,
      workspaceId,
    }).catch((e) => console.warn("git watch start failed:", e));
    // Clear the global recents mirror SYNCHRONOUSLY before the async reload so
    // there's no window where it still shows the previous project's files
    // (the picker also filters by project as a belt-and-suspenders guard).
    useRecentFilesStore.getState().actions.hydrate([]);
    // Recent-files state: Rust loads `<project>/.atlas/recent-files.json`
    // and returns the list. We hydrate the JS mirror with it so the
    // mention picker's "Recent files" section is correct from the
    // first render of the new project.
    void invoke<RecentFile[]>("recent_files_open_project", {
      projectPath: currentProject.path,
      workspaceId,
    })
      .then((items) => {
        useRecentFilesStore.getState().actions.hydrate(items);
      })
      .catch((e) => console.warn("recent_files_open_project failed:", e));
  }, [currentProject?.path]);

  // Native window title: `projectName - Atlas` while a project is open,
  // plain `Atlas` otherwise. This is what macOS shows on the window-menu,
  // on minimize, and on title hover.
  useEffect(() => {
    const title = currentProject ? `${currentProject.name} - Atlas` : "Atlas";
    void invoke("set_window_title", { title }).catch(() => {});
  }, [currentProject?.name]);

  // Install the singleton listener for `atlas:recent-files-changed`
  // once — every push from Rust patches the mirror in place.
  useEffect(() => {
    ensureRecentFilesListener();
  }, []);

  // Quit durability: per-switch flushes are fire-and-forget, so on window
  // close flush the ACTIVE workspace's pending writes (background workspaces
  // were already flushed when we left them). beforeunload can't await, but it
  // cancels the debounce and kicks the write immediately.
  useEffect(() => {
    const onBeforeUnload = () => {
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      const path = useProjectStore.getState().currentProject?.path ?? null;
      // Capture first so the flush dedup compares against the CURRENT state
      // (not a stale capture from the last switch-away).
      if (wsId) captureSnapshot(wsId);
      void flushAll({ workspaceId: wsId, path });
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  useHotkeys([
    {
      // ⌘⇧N — "new workspace": pick a folder and add it as a workspace in
      // this window (Atlas is single-window now; this replaces the old
      // "open a new native window" behaviour).
      combo: { key: "n", meta: true, shift: true },
      action: () => {
        void pickAndAddWorkspace();
      },
    },
    {
      // ⌘⇧. — toggle the Arc-like workspace sidebar. (⌘. alone is the macOS
      // system "Cancel" chord and gets swallowed before reaching the webview.)
      combo: { key: ".", meta: true, shift: true },
      action: () => useWorkspaceStore.getState().actions.toggleSidebar(),
    },
    {
      combo: { key: "k", meta: true },
      action: () => setCommandPaletteOpen(true),
    },
    {
      combo: { key: "p", meta: true },
      action: () => setFilePickerOpen(true),
    },
    {
      combo: { key: "f", meta: true, shift: true },
      action: () => setSearchOpen(true),
    },
    {
      combo: { key: "b", meta: true },
      action: toggleLeftPanel,
    },
    {
      combo: { key: "b", meta: true, shift: true },
      action: toggleRightPanel,
    },
    {
      combo: { key: "j", meta: true },
      action: toggleTerminal,
    },
    {
      combo: { key: "b", meta: true, alt: true },
      action: toggleBottomPanel,
    },
    {
      combo: { key: "j", meta: true, alt: true },
      action: toggleChatSidebar,
    },
    {
      // ⌘⌥K — toggle the Model-Chat history sidebar (mirror of ⌘⌥J).
      combo: { key: "k", meta: true, alt: true },
      action: toggleModelChatSidebar,
    },
    {
      // ⌥J — open the Knowledge Base, or jump to it if already open. Placed
      // after ⌘⌥J (chat sidebar) so the matcher resolves that combo first;
      // plain ⌥J (no ⌘) only matches here.
      combo: { key: "j", alt: true },
      action: () => {
        // Open/focus Knowledge WITHIN the focused split column.
        const st = useLayoutStore.getState();
        const g = st.focusedGroupId;
        const existing = st.tabs.find(
          (t) => (t.groupId ?? "main") === g && t.type === "knowledge",
        );
        if (existing) {
          setActiveTab(existing.id);
          return;
        }
        addTab({
          id: `knowledge-${Date.now()}`,
          type: "knowledge",
          title: "Knowledge",
          closable: true,
          dirty: false,
          data: {},
        });
      },
    },
    {
      combo: { key: "t", meta: true, alt: true },
      action: toggleTabBar,
    },
    ...Array.from({ length: 9 }, (_, i) => ({
      combo: { key: String(i + 1), meta: true },
      // ⌘9 always jumps to the LAST tab (browser convention), regardless
      // of how many tabs there are; ⌘1–8 select by index.
      // ⌘9 = last tab in the focused column (the store treats i<0 as "last").
      action: i === 8 ? () => activateTabByIndex(-1) : () => activateTabByIndex(i),
    })),
    {
      combo: { key: "w", meta: true },
      action: () => {
        const current = useLayoutStore.getState().activeTabId;
        if (current) closeTab(current);
      },
    },
    {
      combo: { key: "[", meta: true, shift: true },
      action: () => cycleTab(-1),
    },
    {
      combo: { key: "]", meta: true, shift: true },
      action: () => cycleTab(1),
    },
    // ── Split view ──
    {
      // ⌘\ — open a new split column to the right (max 3).
      combo: { key: "\\", meta: true },
      action: () => addGroup(),
    },
    {
      // ⌥; — focus the split to the left.
      combo: { key: ";", alt: true },
      action: () => focusAdjacentGroup(-1),
    },
    {
      // ⌥' — focus the split to the right.
      combo: { key: "'", alt: true },
      action: () => focusAdjacentGroup(1),
    },
    {
      // ⌥W — close the focused split column (tabs move to the left neighbour).
      combo: { key: "w", alt: true },
      action: () => closeGroup(useLayoutStore.getState().focusedGroupId),
    },
    {
      // ⌥Z — Zen mode: Knowledge │ Chat │ Browser, side panels hidden. Again restores.
      combo: { key: "z", alt: true },
      action: () => {
        if (currentProject) toggleZenMode();
      },
    },
    {
      // ⌥/ — cycle the coding agent (Claude Code → Codex → Atlas → …). A
      // session is paired to one agent: an empty chat flips in place; a started
      // chat opens a NEW chat bound to the next agent (per the pairing rule).
      combo: { key: "/", alt: true },
      action: () => {
        const layout = useLayoutStore.getState();
        const tab = layout.tabs.find((t) => t.id === layout.activeTabId);
        if (!tab || tab.type !== "chat") return;
        const chat = useChatStore.getState();
        const sess = chat.sessions[tab.id];
        const curIdx = SWITCHABLE_AGENTS.indexOf(
          (sess?.agentType ?? "claude-code") as (typeof SWITCHABLE_AGENTS)[number]
        );
        const next = SWITCHABLE_AGENTS[(Math.max(curIdx, 0) + 1) % SWITCHABLE_AGENTS.length];
        if ((sess?.messages.length ?? 0) === 0) {
          chat.actions.switchChatAgent(tab.id, next);
        } else {
          const id = `chat-${Date.now()}`;
          chat.actions.createSession(id, next);
          addTab({ id, type: "chat", title: "New Chat", closable: true, dirty: false, data: {} });
        }
      },
    },
    {
      combo: { key: "t", meta: true },
      action: () =>
        addTab({
          id: `chat-${Date.now()}`,
          type: "chat",
          title: "New Chat",
          closable: true,
          dirty: false,
          data: {},
        }),
    },
    {
      // ⌘N — new untitled editor. The synthetic `untitled:<ts>` path
      // tells the editor to start with an empty buffer and to fall
      // into the save-as flow on ⌘S (see `editor-panel.tsx`).
      combo: { key: "n", meta: true },
      action: () => {
        const ts = Date.now();
        addTab({
          id: `editor-untitled-${ts}`,
          type: "editor",
          title: "Untitled",
          closable: true,
          dirty: false,
          data: { filePath: `untitled:${ts}` },
        });
      },
    },
    {
      // ⌘⌥N — open the new-tab palette (keyboard-first equivalent of
      // the `+` button's dropdown). Lists every module type and lets
      // the user open one without touching the mouse.
      combo: { key: "n", meta: true, alt: true },
      action: () => setNewTabPaletteOpen(true),
    },
    {
      // ⌘⌥L — open the layout switcher (Windows-task-view-style grid of
      // predefined layout templates, navigable by arrow keys or mouse).
      combo: { key: "l", meta: true, alt: true },
      action: () => setLayoutSwitcherOpen(true),
    },
    {
      combo: { key: "t", meta: true, shift: true },
      action: () =>
        addTab({
          id: `terminal-${Date.now()}`,
          type: "terminal",
          title: "Terminal",
          closable: true,
          dirty: false,
          data: {},
        }),
    },
    {
      combo: { key: ",", meta: true },
      action: () =>
        addTab({
          id: "settings",
          type: "settings",
          title: "Settings",
          closable: true,
          dirty: false,
          data: {},
        }),
    },
    // ── Interface zoom (⌘+ / ⌘- / ⌘0) ──
    // `⌘+` on a US layout arrives as Shift+`=` (e.key === "+"); `⌘=` works too.
    // Both step the global UI scale up; `⌘-` down; `⌘0` resets to 100%.
    { combo: { key: "=", meta: true }, action: zoomIn },
    { combo: { key: "+", meta: true, shift: true }, action: zoomIn },
    { combo: { key: "-", meta: true }, action: zoomOut },
    { combo: { key: "0", meta: true }, action: zoomReset },
  ]);

  return (
    <>
      <AppContextMenu>
        <div className="h-screen w-screen" onContextMenu={(e) => e.preventDefault()}>
          <AppLayout />
        </div>
      </AppContextMenu>
      <CommandPalette
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
      />
      <NewTabPalette
        open={newTabPaletteOpen}
        onOpenChange={setNewTabPaletteOpen}
      />
      <LayoutSwitcher
        open={layoutSwitcherOpen}
        onOpenChange={setLayoutSwitcherOpen}
      />
      <SearchOverlay open={searchOpen} onOpenChange={setSearchOpen} />
      <FilePicker open={filePickerOpen} onOpenChange={setFilePickerOpen} />
      <HintOverlay />
      <NotificationPanel />
      <BrowserOverlayWatcher />
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-default)",
            color: "var(--text-primary)",
            fontSize: "var(--font-size-sm)",
          },
        }}
      />
    </>
  );
}
