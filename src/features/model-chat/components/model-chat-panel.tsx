import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ChevronDown,
  ArrowUp,
  Square,
  KeyRound,
  Check,
  Loader2,
  Lock,
  Link2,
  PanelLeftOpen,
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Kbd, KbdGroup } from "@/ui/kbd";
import { MessageItem } from "@/features/chat/components/message-item";
import { ChatSearchPalette } from "@/features/chat/components/chat-search-palette";
import { usePaneFind } from "@/features/chat/lib/use-pane-find";
import { ChatInput, type ChatInputHandle } from "@/features/chat/components/chat-input";
import {
  MentionPicker,
  type MentionPickerHandle,
} from "@/features/mentions/components/mention-picker";
import type { MentionTrigger } from "@/features/chat/lib/cm-mention-extension";
import type { MentionData } from "@/features/chat/lib/mentions";
import { ModelChatSidebar } from "./model-chat-sidebar";
import { ModelChatLinksPanel } from "./model-chat-links-panel";
import { ProviderLogo } from "@/components/provider-logo";
import { CHAT_PROVIDERS, providerById } from "@/features/settings/lib/providers";
import { useByokStore } from "@/features/settings/stores/byok-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useModelChatStore } from "../stores/model-chat-store";
import { modelchat } from "../lib/model-chat-api";

const JUMP_EVENT = "atlas:modelchat-jump";

// `tabId` is the center-panel tab id — used to scope the Cmd+F finder to this
// pane. Model chat keeps its own session history independent of the tab.
export function ModelChatPanel({ tabId }: { tabId?: string } = {}) {
  const keys = useByokStore.use.keys();
  const loaded = useByokStore.use.loaded();
  const { load } = useByokStore.use.actions();
  const { init } = useModelChatStore.use.actions();

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);
  useEffect(() => {
    void init();
  }, [init]);

  const configured = useMemo(
    () => CHAT_PROVIDERS.filter((p) => !!keys[p.id]),
    [keys],
  );

  if (loaded && configured.length === 0) {
    return <EmptyState hasOtherKeys={Object.keys(keys).length > 0} />;
  }

  return <ChatSurface tabId={tabId} configuredIds={configured.map((p) => p.id)} />;
}

function ChatSurface({
  tabId,
  configuredIds,
}: {
  tabId?: string;
  configuredIds: string[];
}) {
  const activeId = useModelChatStore.use.activeId();
  const streaming = useModelChatStore.use.streaming();
  const hasSession = useModelChatStore((s) =>
    activeId ? !!s.sessions[activeId] : false,
  );
  const { newSession } = useModelChatStore.use.actions();

  useEffect(() => {
    if (!activeId && configuredIds.length > 0) newSession(configuredIds[0], "");
  }, [activeId, configuredIds, newSession]);

  return (
    <div className="flex h-full bg-bg-base">
      <ModelChatSidebar onNew={() => newSession(configuredIds[0] ?? "", "")} />
      <div className="flex min-w-0 flex-1 flex-col">
        {activeId && hasSession ? (
          <Conversation
            key={activeId}
            tabId={tabId}
            sessionId={activeId}
            configuredIds={configuredIds}
            isStreaming={!!streaming[activeId]}
          />
        ) : (
          <div className="grid flex-1 place-items-center text-[12px] text-text-tertiary">
            Start a new chat
          </div>
        )}
      </div>
    </div>
  );
}

function Conversation({
  tabId,
  sessionId,
  configuredIds,
  isStreaming,
}: {
  tabId?: string;
  sessionId: string;
  configuredIds: string[];
  isStreaming: boolean;
}) {
  const session = useModelChatStore((s) => s.sessions[sessionId]);
  const { send, stop } = useModelChatStore.use.actions();
  const sidebar = useLayoutStore.use.modelChatSidebar();
  const { toggleModelChatSidebar } = useLayoutStore.use.actions();
  const scrollRef = useRef<HTMLDivElement>(null);
  // Cmd+F find — scoped to this pane + tab (see usePaneFind).
  const [searchOpen, setSearchOpen] = usePaneFind(tabId);
  const [linksOpen, setLinksOpen] = useState(false);

  const messages = useMemo(() => session?.messages ?? [], [session]);

  // Jump-to-message (from search or the links panel).
  useEffect(() => {
    const handler = (e: Event) => {
      const idx = (e as CustomEvent<{ index: number }>).detail?.index;
      if (idx == null) return;
      const el = scrollRef.current?.querySelector(`[data-mc-index="${idx}"]`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
      el?.classList.add("atlas-jump-flash");
      window.setTimeout(() => el?.classList.remove("atlas-jump-flash"), 1200);
    };
    window.addEventListener(JUMP_EVENT, handler);
    return () => window.removeEventListener(JUMP_EVENT, handler);
  }, []);

  // Auto-scroll while near the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, isStreaming]);

  if (!session) return null;

  const jump = (index: number) =>
    window.dispatchEvent(new CustomEvent(JUMP_EVENT, { detail: { index } }));

  return (
    <div className="relative flex min-w-0 flex-1 flex-col">
      {/* Header bar — matches the agent chat (h-[32px]). */}
      <div className="flex items-center gap-2 px-3 h-[32px] shrink-0 border-b border-border-default">
        {!sidebar.visible && (
          <button
            onClick={toggleModelChatSidebar}
            className="flex items-center justify-center w-6 h-6 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
            title="Show history (⌘⌥K)"
          >
            <PanelLeftOpen size={13} />
          </button>
        )}
        {messages.length > 0 && (
          <button
            onClick={() => setSearchOpen(true)}
            className="flex items-center gap-2 h-[26px] pl-2.5 pr-1 rounded-md border border-border-default bg-bg-elevated text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-hover cursor-pointer outline-none transition-colors min-w-[280px]"
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
        )}
        <div className="flex-1" />
        <button
          onClick={() => setLinksOpen((v) => !v)}
          className={cn(
            "flex items-center gap-1 px-2 h-6 rounded text-[10px] cursor-pointer outline-none transition-colors",
            linksOpen
              ? "text-text-primary bg-bg-selected"
              : "text-text-tertiary hover:text-text-primary hover:bg-bg-hover",
          )}
          title="Toggle links"
        >
          <Link2 size={11} />
          Links
        </button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
        {messages.length === 0 ? (
          <div className="grid h-full place-items-center px-6">
            <div className="max-w-[420px] text-center">
              <p className="text-[14px] font-medium text-text-primary">
                {providerById(session.provider)?.name ?? "Chat"}
              </p>
              <p className="mt-1 text-[12px] text-text-tertiary">
                Ask anything. Responses stream directly from the model using your
                stored key.
              </p>
            </div>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-[760px] px-4">
            {messages.map((m, i) => (
              <div key={m.id} data-mc-index={i}>
                <MessageItem
                  message={m}
                  model={m.role === "assistant" ? session.model : null}
                  streaming={
                    isStreaming && i === messages.length - 1 && m.role === "assistant"
                  }
                  isLastInGroup
                />
              </div>
            ))}
          </div>
        )}
      </div>

      <Composer
        sessionId={sessionId}
        configuredIds={configuredIds}
        running={isStreaming}
        onSend={(text) => void send(sessionId, text)}
        onStop={() => stop(sessionId)}
      />

      <ChatSearchPalette
        open={searchOpen}
        onOpenChange={setSearchOpen}
        messages={messages}
        onJump={jump}
      />

      {linksOpen && (
        <ModelChatLinksPanel
          messages={messages}
          onClose={() => setLinksOpen(false)}
          onJump={(idx) => {
            setLinksOpen(false);
            jump(idx);
          }}
        />
      )}
    </div>
  );
}

function Composer({
  sessionId,
  configuredIds,
  running,
  onSend,
  onStop,
}: {
  sessionId: string;
  configuredIds: string[];
  running: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const session = useModelChatStore((s) => s.sessions[sessionId]);
  const { setProvider, setModel } = useModelChatStore.use.actions();
  const projectPath = useProjectStore((s) => s.currentProject?.path ?? null);
  const provider = session?.provider ?? "";
  const model = session?.model ?? "";
  const providerLocked = (session?.messages.length ?? 0) > 0;

  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [hasText, setHasText] = useState(false);

  const inputRef = useRef<ChatInputHandle>(null);
  // Mention/reference picker (reused from the agent chat; @ = all, ~ = notes).
  const [trigger, setTrigger] = useState<MentionTrigger | null>(null);
  const pickerRef = useRef<MentionPickerHandle>(null);
  const triggerRef = useRef<MentionTrigger | null>(null);
  triggerRef.current = trigger;

  useEffect(() => {
    if (!provider) return;
    let cancelled = false;
    setLoadingModels(true);
    void modelchat
      .models(provider)
      .then((list) => {
        if (cancelled) return;
        const ids = list.map((m) => m.id);
        setModels(ids);
        const cur = useModelChatStore.getState().sessions[sessionId]?.model;
        if (!cur && ids.length > 0) setModel(sessionId, ids[0]);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingModels(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, sessionId]);

  const handleMentionSelect = useCallback((mention: MentionData) => {
    const t = triggerRef.current;
    if (!t) return;
    inputRef.current?.insertMention(mention, t.from, t.to);
  }, []);

  const keyInterceptor = useCallback(
    (key: "Up" | "Down" | "Enter" | "Escape" | "Backspace") => {
      const p = pickerRef.current;
      const t = triggerRef.current;
      if (!t || !p) return false;
      switch (key) {
        case "Up":
          p.moveUp();
          return true;
        case "Down":
          p.moveDown();
          return true;
        case "Enter":
          return p.commit();
        case "Escape":
          if (p.goBack()) return true;
          setTrigger(null);
          return true;
        case "Backspace":
          if (t.query === "" && p.goBack()) return true;
          return false;
      }
    },
    [],
  );

  const submit = () => {
    if (running) {
      onStop();
      return;
    }
    const text = inputRef.current?.getValue()?.trim() ?? "";
    if (!text || !model) return;
    onSend(text);
    inputRef.current?.clear();
    setHasText(false);
  };

  return (
    <div className="shrink-0 p-3">
      <div
        className={cn(
          "mx-auto w-full max-w-[760px] rounded-xl border border-border-default bg-bg-secondary",
          "shadow-[0_8px_24px_rgba(0,0,0,0.35)] transition-[border-color] duration-150",
          "focus-within:border-[var(--border-focus)]",
        )}
      >
        <ChatInput
          ref={inputRef}
          placeholder="Ask anything…  (@ to reference, ~ for notes)"
          onChange={(v) => setHasText(v.trim().length > 0)}
          onSubmit={submit}
          onMentionTrigger={setTrigger}
          keyInterceptor={keyInterceptor}
        />

        {/* Control row: provider + model pickers · send/stop */}
        <div className="flex items-center justify-between px-2 pb-2 pt-1">
          <div className="flex min-w-0 items-center gap-1">
            {providerLocked ? (
              <span
                className="flex items-center gap-1.5 h-[26px] rounded-full border border-border-default bg-bg-elevated px-2 text-[10px] font-medium text-text-secondary"
                title="Provider is locked for this chat"
              >
                <ProviderLogo id={provider} size={13} />
                <span className="max-w-[100px] truncate">
                  {providerById(provider)?.name ?? provider}
                </span>
                <Lock size={9} className="text-text-tertiary" />
              </span>
            ) : (
              <PickerDropdown
                trigger={
                  <>
                    <ProviderLogo id={provider} size={13} />
                    <span className="max-w-[100px] truncate">
                      {providerById(provider)?.name ?? provider}
                    </span>
                    <ChevronDown size={11} className="text-text-tertiary" />
                  </>
                }
              >
                {configuredIds.map((id) => (
                  <DropdownMenu.Item
                    key={id}
                    onSelect={() => setProvider(sessionId, id)}
                    className="flex items-center gap-2 px-2.5 h-[28px] text-[11px] text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer outline-none"
                  >
                    <ProviderLogo id={id} size={14} />
                    <span className="flex-1 truncate">{providerById(id)?.name ?? id}</span>
                    {id === provider && <Check size={12} className="text-text-primary" />}
                  </DropdownMenu.Item>
                ))}
              </PickerDropdown>
            )}

            <PickerDropdown
              wide
              trigger={
                <>
                  {loadingModels && (
                    <Loader2 size={11} className="animate-spin text-text-tertiary" />
                  )}
                  <span className="max-w-[200px] truncate font-mono">
                    {model || (loadingModels ? "Loading…" : "Select model")}
                  </span>
                  <ChevronDown size={11} className="text-text-tertiary" />
                </>
              }
            >
              {models.length === 0 ? (
                <div className="px-2.5 py-2 text-[11px] text-text-tertiary">
                  {loadingModels ? "Loading models…" : "No models"}
                </div>
              ) : (
                models.map((id) => (
                  <DropdownMenu.Item
                    key={id}
                    onSelect={() => setModel(sessionId, id)}
                    className="flex items-center gap-2 px-2.5 h-[26px] text-[11px] font-mono text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer outline-none"
                  >
                    <span className="flex-1 truncate">{id}</span>
                    {id === model && <Check size={11} className="text-text-primary" />}
                  </DropdownMenu.Item>
                ))
              )}
            </PickerDropdown>
          </div>

          <button
            type="button"
            onClick={submit}
            disabled={!running && (!hasText || !model)}
            className={cn(
              "flex items-center justify-center w-7 h-7 shrink-0 rounded-full transition-colors",
              running
                ? "bg-bg-elevated text-text-secondary hover:text-text-primary cursor-pointer"
                : !hasText || !model
                  ? "bg-bg-elevated text-text-tertiary cursor-not-allowed"
                  : "bg-[var(--text-primary)] text-[var(--bg-primary)] hover:bg-[var(--text-secondary)] cursor-pointer",
            )}
            aria-label={running ? "Stop" : "Send"}
          >
            {running ? (
              <Square size={11} strokeWidth={3} fill="currentColor" />
            ) : (
              <ArrowUp size={14} strokeWidth={2.5} />
            )}
          </button>
        </div>
      </div>

      <MentionPicker
        ref={pickerRef}
        open={trigger !== null}
        query={trigger?.query ?? ""}
        anchor={trigger?.anchor ?? null}
        initialScope={trigger?.scope ?? null}
        projectPath={projectPath}
        onSelect={handleMentionSelect}
        onClose={() => setTrigger(null)}
      />
    </div>
  );
}

/** Small pill-shaped dropdown used for the provider + model pickers. */
function PickerDropdown({
  trigger,
  children,
  wide,
}: {
  trigger: React.ReactNode;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="flex min-w-0 items-center gap-1.5 h-[26px] rounded-full border border-border-default bg-bg-elevated px-2 text-[10px] font-medium text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors outline-none cursor-pointer">
          {trigger}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          side="top"
          sideOffset={6}
          className={cn(
            "z-[9999] max-h-[340px] overflow-y-auto rounded-md border border-border-default bg-bg-elevated py-1 shadow-[var(--shadow-overlay)]",
            wide ? "min-w-[240px]" : "min-w-[180px]",
          )}
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function EmptyState({ hasOtherKeys }: { hasOtherKeys: boolean }) {
  const openSettings = () => {
    void import("@/features/layout/stores/layout-store").then(({ useLayoutStore }) => {
      useLayoutStore.getState().actions.addTab({
        id: "settings",
        type: "settings",
        title: "Settings",
        closable: true,
        dirty: false,
        data: { section: "providers" },
      });
    });
  };
  return (
    <div className="grid h-full place-items-center bg-bg-base p-6">
      <div className="max-w-[380px] text-center">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-xl border border-border-default bg-bg-elevated">
          <KeyRound size={20} className="text-text-tertiary" />
        </div>
        <p className="mt-3 text-[13px] font-medium text-text-primary">
          {hasOtherKeys ? "No chat-capable provider yet" : "No provider keys yet"}
        </p>
        <p className="mt-1 text-[11px] text-text-tertiary">
          {hasOtherKeys
            ? "Your saved keys are for providers that don't support chat. Add a chat provider — OpenAI, Anthropic, Google, Mistral, Groq, … — to start."
            : "Add an API key for a chat provider (OpenAI, Anthropic, Google, Groq, …) to start chatting with models directly."}
        </p>
        <button
          onClick={openSettings}
          className="mt-3 inline-flex items-center gap-1.5 h-7 rounded-md bg-[var(--accent-primary)] px-3 text-[11px] font-medium text-[var(--bg-base)] hover:opacity-90 transition-opacity"
        >
          <KeyRound size={12} />
          Open API Keys
        </button>
      </div>
    </div>
  );
}
