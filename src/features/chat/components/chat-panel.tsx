import { useEffect, useRef, useState } from "react";
import { useChatStore } from "../stores/chat-store";
import { sendChatMessage } from "../lib/chat-api";
import { acp, ensureDefaultAgent } from "../lib/acp-api";
import { MessageInput } from "./message-input";
import { SessionSidebar } from "./session-sidebar";
import { MessagesList } from "./messages-list";
import { BashHistoryPanel } from "./bash-history-panel";
import { ChatSearchPalette } from "./chat-search-palette";
import { PermissionModal } from "./permission-modal";
import { Sparkles, Key, User, TerminalSquare, ListFilter, Search } from "lucide-react";
import { Kbd, KbdGroup } from "@/ui/kbd";
import { logEvent } from "@/features/log/lib/log";
import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useAnalysisStore } from "@/features/analysis/stores/analysis-store";
import { useGitStore } from "@/features/git/stores/git-store";
import { useKnowledgeStore } from "@/features/knowledge/stores/knowledge-store";
import { invoke } from "@tauri-apps/api/core";

interface ChatPanelProps {
  tabId: string;
}

export function ChatPanel({ tabId }: ChatPanelProps) {
  const sessions = useChatStore.use.sessions();
  const providerConfig = useChatStore.use.providerConfig();
  const {
    createSession,
    addMessage,
    updateSessionStatus,
    setSessionTitle,
  } = useChatStore.use.actions();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [roleFilter, setRoleFilter] = useState<"all" | "user" | "assistant">("all");
  const [bashPanelOpen, setBashPanelOpen] = useState(false);
  const [searchPaletteOpen, setSearchPaletteOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const session = sessions[tabId];
  const claudeSessionId = session?.claudeSessionId ?? "";

  useEffect(() => {
    if (!session) {
      createSession(tabId);
    }
  }, [tabId, session, createSession]);

  // Cmd+F → open the message-jump palette (ChatPanel only mounts when its tab is active).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setSearchPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", handler, true); // capture phase to beat browser default
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  // Shift+Tab → cycle Claude permission modes whenever focus is inside the chat
  // panel and we're in agent mode. We register on the window in capture phase so
  // the browser's default focus traversal never steals the key.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      const root = rootRef.current;
      const active = document.activeElement as HTMLElement | null;
      // Only intercept when focus is somewhere inside this chat panel.
      if (!root || !active || !root.contains(active)) return;
      // Only meaningful in agent mode.
      const sess = useChatStore.getState().sessions[tabId];
      if (!sess?.useClaude) return;
      e.preventDefault();
      e.stopPropagation();
      useChatStore.getState().actions.cycleClaudePermissionMode(tabId);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [tabId]);

  // Drain the per-tab queue when the agent transitions back to idle.
  const prevStatusRef = useRef<string | null>(null);
  const handleSendRef = useRef<((content: string) => void) | null>(null);
  useEffect(() => {
    const cur = session?.status ?? "idle";
    const prev = prevStatusRef.current;
    prevStatusRef.current = cur;
    if (prev === "running" && cur !== "running") {
      const next = useChatStore.getState().actions.shiftQueue(tabId);
      if (next && handleSendRef.current) {
        // Defer one microtask so the React commit completes first.
        Promise.resolve().then(() => handleSendRef.current?.(next));
      }
    }
  }, [session?.status, tabId]);

  if (!session) return null;

  const needsApiKey = !providerConfig.apiKey && !session.useClaude;

  const handleStop = () => {
    const s = useChatStore.getState().sessions[tabId];
    if (!s?.acpAgentId || !s.acpSessionId) return;
    acp.cancelTurn(s.acpAgentId, s.acpSessionId).catch(() => {});
  };

  const handleSend = async (content: string) => {
    const actualContent = content;

    addMessage(tabId, "user", actualContent);
    logEvent({
      source: "chat",
      kind: session.useClaude ? "send-agent" : "send-chat",
      summary: actualContent.slice(0, 120),
      payload: { tabId, mode: session.useClaude ? "agent" : "chat" },
    });

    if (session.messages.length === 0) {
      setSessionTitle(tabId, actualContent.slice(0, 40) + (actualContent.length > 40 ? "..." : ""));
    }

    if (session.useClaude) {
      updateSessionStatus(tabId, "running");
      addMessage(tabId, "assistant", "");

      const store = useChatStore.getState();
      const project = useProjectStore.getState().currentProject;
      const cwd = project?.path ?? "";

      try {
        // Lazily ensure (a) one shared ACP agent process and (b) one ACP
        // session per chat tab. After phase-1 these become user-controllable
        // via the agents panel.
        let s = store.sessions[tabId];
        if (!s.acpAgentId || !s.acpSessionId) {
          const agent = await ensureDefaultAgent();
          const sess = await acp.newSession(agent.agent_id, cwd || "/");
          store.actions.setAcpBinding(tabId, agent.agent_id, sess.session_id);
          s = useChatStore.getState().sessions[tabId];
        }

        const stopReason = await acp.sendPrompt(
          s.acpAgentId!,
          s.acpSessionId!,
          actualContent
        );

        const status: typeof session.status =
          stopReason === "end_turn" || stopReason === "cancelled" ? "idle" : "error";
        useChatStore.getState().actions.updateSessionStatus(tabId, status);

        logEvent({
          source: "agent",
          kind: status === "idle" ? "stream-done" : "stream-failed",
          summary: `stop_reason=${stopReason}`,
          payload: {
            tabId,
            stopReason,
            acpSessionId: s.acpSessionId,
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        useChatStore.getState().actions.updateLastAssistantMessage(
          tabId,
          `ACP error: ${msg}`
        );
        useChatStore.getState().actions.updateSessionStatus(tabId, "error");
        logEvent({
          source: "agent",
          kind: "stream-error",
          summary: msg.slice(0, 160),
          payload: { tabId },
        });
      }
      return;
    }

    if (needsApiKey) {
      addMessage(
        tabId,
        "assistant",
        "Please set your API key first. Click the key icon in the input bar or press the settings button."
      );
      return;
    }

    updateSessionStatus(tabId, "running");

    try {
      const allMessages = [
        ...session.messages.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content },
      ];

      // Build project-scoped system prompt with full context
      const project = useProjectStore.getState().currentProject;
      const analysisState = useAnalysisStore.getState();
      const gitState = useGitStore.getState();
      const knowledgeState = useKnowledgeStore.getState();

      let systemPrompt = providerConfig.system || "";
      if (project) {
        // Log this interaction
        invoke("log_interaction", {
          projectPath: project.path,
          interactionType: "chat",
          summary: `User: ${actualContent.slice(0, 100)}`,
        }).catch(() => {});

        // Fetch recent interactions for context
        let recentInteractions: string[] = [];
        try {
          recentInteractions = await invoke<string[]>("get_recent_interactions", {
            projectPath: project.path,
            limit: 10,
          });
        } catch {
          // silent
        }

        const projectContext = [
          `\n\nProject context:`,
          `- Project: ${project.name} (${project.path})`,
          analysisState.indexed ? `- ${analysisState.totalFiles} files, ${analysisState.totalLines} lines across ${analysisState.languages.map(l => l.language).join(", ")}` : null,
          analysisState.symbols.length > 0 ? `- ${analysisState.symbols.length} symbols indexed` : null,
          gitState.isRepo ? `- Git branch: ${gitState.branch}` : null,
          gitState.files.length > 0 ? `- ${gitState.files.length} uncommitted changes: ${gitState.files.slice(0, 5).map(f => f.path).join(", ")}${gitState.files.length > 5 ? "..." : ""}` : null,
          knowledgeState.entries.length > 0 ? `\nKnowledge base (${knowledgeState.entries.length} entries): ${knowledgeState.entries.slice(0, 5).map(e => `${e.title} [${e.source}]`).join(", ")}` : null,
          recentInteractions.length > 0 ? `\nRecent activity:\n${recentInteractions.slice(-5).map(l => {
            try { const j = JSON.parse(l); return `- [${j.type}] ${j.summary}`; } catch { return null; }
          }).filter(Boolean).join("\n")}` : null,
        ].filter(Boolean).join("\n");
        systemPrompt += projectContext;
      }

      const response = await sendChatMessage(
        {
          provider: providerConfig.provider,
          model: providerConfig.model,
          apiKey: providerConfig.apiKey,
          system: systemPrompt,
        },
        allMessages
      );

      addMessage(tabId, "assistant", response.content);
      // Track usage
      if (response.usage) {
        const { useUsageStore } = await import("@/features/monitor/stores/usage-store");
        useUsageStore.getState().actions.trackUsage(
          providerConfig.provider,
          providerConfig.model,
          response.usage.input_tokens,
          response.usage.output_tokens
        );
      }
      updateSessionStatus(tabId, "idle");
    } catch (err) {
      addMessage(
        tabId,
        "assistant",
        `Error: ${err instanceof Error ? err.message : String(err)}`
      );
      updateSessionStatus(tabId, "error");
    }
  };

  // Keep the queue-drain effect pointing at the latest handleSend closure.
  handleSendRef.current = handleSend;

  return (
    <div ref={rootRef} className="h-full flex">
      <PermissionModal tabId={tabId} />
      <SessionSidebar tabId={tabId} />

      <div className="flex-1 flex flex-col min-w-0">
        {/* Chat toolbar — only in agent mode */}
        {session.messages.length > 0 && session.useClaude && (
          <div className="flex items-center gap-2 px-3 h-[32px] border-b border-[var(--border-default)] shrink-0">
            <button
              onClick={() => setSearchPaletteOpen(true)}
              className="flex items-center gap-2 h-6.5 pl-2.5 pr-1 rounded-md border border-[var(--border-default)] bg-[var(--bg-elevated)] text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer outline-none transition-colors min-w-[280px]"
              title="Search messages (⌘F)"
            >
              <Search size={11} />
              <span>Find in chat…</span>
              <span className="ml-auto">
              	<KbdGroup>
									<Kbd className="h-[16px] w-fit min-w-[16px]">⌘</Kbd>
                  <Kbd className="h-[16px] w-fit min-w-[16px]">F</Kbd>
                </KbdGroup>
              </span>
            </button>
            <div className="flex-1" />
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  className="flex items-center gap-1 px-2 h-6 rounded text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer outline-none transition-colors"
                  title="Filter messages"
                >
                  <ListFilter size={11} />
                  <span className="capitalize">{roleFilter}</span>
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  sideOffset={4}
                  className="rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] shadow-[var(--shadow-overlay)] py-1 min-w-[140px]"
                  style={{ zIndex: 9999 }}
                >
                  {(["all", "user", "assistant"] as const).map((f) => (
                    <DropdownMenu.Item
                      key={f}
                      onClick={() => setRoleFilter(f)}
                      className={cn(
                        "flex items-center gap-2 px-3 h-[26px] text-[11px] cursor-default outline-none capitalize",
                        roleFilter === f
                          ? "text-[var(--text-primary)] bg-[var(--bg-selected)]"
                          : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                      )}
                    >
                      {f === "user" ? <User size={10} /> : f === "assistant" ? <Sparkles size={10} /> : <ListFilter size={10} />}
                      <span>{f}</span>
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            <button
              onClick={() => setBashPanelOpen((v) => !v)}
              className={cn(
                "flex items-center gap-1 px-2 h-6 rounded text-[10px] cursor-pointer outline-none transition-colors",
                bashPanelOpen
                  ? "text-[var(--text-primary)] bg-[var(--bg-selected)]"
                  : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
              )}
              title="Toggle bash call history"
            >
              <TerminalSquare size={11} />
              Bash
            </button>
          </div>
        )}

        {session.messages.length === 0 ? (
          <div className="flex-1 overflow-y-auto">
            <WelcomeState onConfigure={() => setSettingsOpen(true)} needsKey={needsApiKey} />
          </div>
        ) : (
          <MessagesList
            tabId={tabId}
            claudeSessionId={claudeSessionId}
            messages={session.messages}
            roleFilter={roleFilter}
            isStreaming={session.status === "running"}
          />
        )}

        <div className="relative">
          {/* Fade the bottom of the messages into the input bar */}
          <div
            aria-hidden
            className="pointer-events-none absolute left-0 right-0 -top-10 h-10 z-[1]"
            style={{
              background:
                "linear-gradient(to bottom, color-mix(in srgb, var(--bg-surface) 0%, transparent), var(--bg-surface))",
            }}
          />
          {needsApiKey && (
            <button
              onClick={() => setSettingsOpen(true)}
              className="absolute -top-9 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 px-3 h-7 rounded-full border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] shadow-[0_6px_16px_rgba(0,0,0,0.5)] transition-colors cursor-pointer"
              style={{ backdropFilter: "blur(4px)" }}
              title="Configure API keys"
            >
              <Key size={11} />
              Configure API keys
            </button>
          )}
          <MessageInput
            tabId={tabId}
            onSend={handleSend}
            onStop={handleStop}
            running={session.status === "running"}
            onSettingsClick={() => setSettingsOpen(true)}
          />
        </div>
      </div>

      {bashPanelOpen && (
        <BashHistoryPanel
          messages={session.messages}
          onJump={(idx) => {
            if (roleFilter !== "all") setRoleFilter("all");
            window.dispatchEvent(
              new CustomEvent("atlas:chat-jump", { detail: { index: idx } })
            );
          }}
          onClose={() => setBashPanelOpen(false)}
        />
      )}

      <ProviderSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />

      <ChatSearchPalette
        open={searchPaletteOpen}
        onOpenChange={setSearchPaletteOpen}
        messages={session.messages}
        onJump={(idx) =>
          window.dispatchEvent(new CustomEvent("atlas:chat-jump", { detail: { index: idx } }))
        }
      />
    </div>
  );
}

function WelcomeState({ onConfigure, needsKey }: { onConfigure: () => void; needsKey: boolean }) {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-center space-y-4 max-w-[400px] px-6">
        <div className="w-14 h-14 rounded-2xl bg-[var(--accent-primary-muted)] flex items-center justify-center mx-auto">
          <Sparkles size={28} className="text-[var(--accent-primary)]" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">
            Atlas
          </h2>
          <p className="text-sm text-[var(--text-secondary)] mt-1">
            Chat with any AI provider. Execution routes through Claude Code.
          </p>
        </div>
        {needsKey ? (
          <button
            onClick={onConfigure}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--accent-primary)] text-[var(--text-inverse)] text-sm font-medium hover:bg-[var(--accent-primary-hover)] transition-colors"
          >
            <Key size={14} />
            Set API Key
          </button>
        ) : (
          <div className="grid grid-cols-2 gap-2 text-left">
            {[
              "Analyze this codebase",
              "Create a new feature",
              "Review recent changes",
              "Write tests for...",
            ].map((prompt) => (
              <button
                key={prompt}
                className="px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors text-left"
              >
                {prompt}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ProviderSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const providerConfig = useChatStore.use.providerConfig();
  const { setProvider, setModel, setApiKey } = useChatStore.use.actions();

  const providers = [
    { id: "anthropic" as const, label: "Anthropic", models: ["claude-sonnet-4-6-20250514", "claude-opus-4-6-20250514", "claude-haiku-4-5-20251001"] },
    { id: "openai" as const, label: "OpenAI", models: ["gpt-4o", "gpt-4o-mini", "o3"] },
    { id: "google" as const, label: "Google", models: ["gemini-2.5-pro-preview-06-05", "gemini-2.5-flash-preview-05-20"] },
  ];

  const currentProviderModels = providers.find((p) => p.id === providerConfig.provider)?.models ?? [];

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 z-[var(--z-overlay)]" />
        <Dialog.Content
          className={cn(
            "fixed top-[20%] left-1/2 -translate-x-1/2 z-[var(--z-modal)]",
            "w-[440px] rounded-xl overflow-hidden",
            "bg-[var(--bg-secondary)] border border-[var(--border-default)]",
            "shadow-[var(--shadow-overlay)] p-5 space-y-4"
          )}
        >
          <Dialog.Title className="text-sm font-semibold text-[var(--text-primary)]">
            Chat Provider Settings
          </Dialog.Title>

          {/* Provider selector */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-[var(--text-secondary)]">
              Provider
            </label>
            <div className="flex gap-1.5">
              {providers.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    setProvider(p.id);
                    setModel(p.models[0]);
                  }}
                  className={cn(
                    "px-3 py-1.5 rounded-md text-[11px] font-medium transition-colors",
                    providerConfig.provider === p.id
                      ? "bg-[var(--accent-primary)] text-[var(--text-inverse)]"
                      : "bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] border border-[var(--border-default)]"
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Model selector */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-[var(--text-secondary)]">
              Model
            </label>
            <select
              value={providerConfig.model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full h-8 rounded-md border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2 text-xs text-[var(--text-primary)] outline-none focus:ring-1 focus:ring-[var(--border-focus)]"
            >
              {currentProviderModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>

          {/* API Key */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-[var(--text-secondary)]">
              API Key
            </label>
            <input
              type="password"
              value={providerConfig.apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={`Enter your ${providerConfig.provider} API key...`}
              className="w-full h-8 rounded-md border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none focus:ring-1 focus:ring-[var(--border-focus)] font-mono"
            />
            <p className="text-[10px] text-[var(--text-tertiary)]">
              Stored locally, never sent anywhere except the provider's API.
            </p>
          </div>

          <div className="flex justify-end pt-2">
            <button
              onClick={() => onOpenChange(false)}
              className="px-4 py-1.5 rounded-md bg-[var(--accent-primary)] text-[var(--text-inverse)] text-[11px] font-medium hover:bg-[var(--accent-primary-hover)] transition-colors"
            >
              Done
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
