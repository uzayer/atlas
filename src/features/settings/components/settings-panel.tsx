import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { ScrollArea } from "@/ui/scroll-area";
import { KbdCombo } from "@/ui/kbd";
import { cn } from "@/lib/utils";
import {
  Settings,
  Palette,
  Keyboard,
  Info,
  FlaskConical,
} from "lucide-react";
import { AtlasIcon } from "@/components/atlas-icon";
import { useDevFlagsStore } from "../stores/dev-flags-store";
import { useClaudeSetupStore } from "@/features/claude-setup/stores/claude-setup-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { isDev } from "@/lib/env";

// Developer section is dev-build only — production users never see the
// diagnostic toggles (they change app behavior and aren't useful outside
// UI testing). `isDev` is a Vite build constant, so the production bundle
// drops the entry entirely via dead-code elimination.
const SECTIONS = [
  { id: "general", label: "General", icon: Settings },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "keybindings", label: "Keybindings", icon: Keyboard },
  ...(isDev
    ? [{ id: "developer", label: "Developer", icon: FlaskConical }]
    : []),
  { id: "about", label: "About", icon: Info },
];

export function SettingsPanel() {
  const [activeSection, setActiveSection] = useState("general");

  return (
    <div className="h-full flex">
      {/* Settings nav */}
      <div className="w-[180px] shrink-0 border-r border-border-default bg-bg-primary py-2">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => setActiveSection(s.id)}
            className={cn(
              "w-full flex items-center gap-2 px-4 h-[32px] text-[11px] font-medium transition-colors",
              activeSection === s.id
                ? "text-text-primary bg-bg-selected border-l-2 border-l-accent"
                : "text-text-secondary hover:bg-bg-hover border-l-2 border-l-transparent"
            )}
          >
            <s.icon size={13} />
            {s.label}
          </button>
        ))}
      </div>

      {/* Settings content */}
      <ScrollArea className="flex-1 p-6">
        <div className="max-w-[500px]">
          {activeSection === "general" && <GeneralSettings />}
          {activeSection === "appearance" && <AppearanceSettings />}
          {activeSection === "keybindings" && <KeybindingsSettings />}
          {isDev && activeSection === "developer" && <DeveloperSettings />}
          {activeSection === "about" && <AboutSettings />}
        </div>
      </ScrollArea>
    </div>
  );
}

interface CliStatus {
  installed: boolean;
  path: string | null;
  installedVersion: string | null;
  currentVersion: string;
}

function GeneralSettings() {
  const settings = useProjectStore.use.settings();
  const { updateSettings } = useProjectStore.use.actions();
  const [cli, setCli] = useState<CliStatus | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void invoke<CliStatus>("cli_status")
      .then((s) => {
        if (!cancelled) setCli(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const installCli = async () => {
    setInstalling(true);
    try {
      const next = await invoke<CliStatus>("cli_install_helper");
      setCli(next);
      toast.success("Installed atlas tools");
    } catch (e) {
      toast.error(`Install failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setInstalling(false);
    }
  };

  const cliInstalledLine = cli?.installed
    ? cli.installedVersion === cli.currentVersion
      ? `Installed at ${cli.path}`
      : `Installed at ${cli.path}${
          cli.installedVersion
            ? ` (version ${cli.installedVersion}, current ${cli.currentVersion})`
            : ` (version unknown, current ${cli.currentVersion})`
        }`
    : `Will install to ${cli?.path ?? "~/.local/bin/atlas"}`;

  return (
    <div className="space-y-6">
      <SectionTitle title="General" subtitle="Application preferences" />
      <SettingRow
        label="Auto-add .atlas to .gitignore"
        description="When you open a git-tracked project, Atlas adds `.atlas/` to the project's .gitignore (creating one if needed). Atlas keeps its caches and state in `.atlas/` — keeping it out of version control is almost always what you want. No-op on non-git projects."
      >
        <Toggle
          checked={settings.autoAddAtlasGitignore}
          onChange={(next) =>
            updateSettings({ autoAddAtlasGitignore: next })
          }
        />
      </SettingRow>
      <SettingRow
        label="atlas terminal helper"
        description={`Adds an \`atlas\` command to your shell — type \`atlas .\` in any terminal to open the current folder as a project. Refreshed automatically on every launch so an older copy never lingers. ${cliInstalledLine}.`}
      >
        <button
          type="button"
          onClick={() => void installCli()}
          disabled={installing}
          className={cn(
            "h-7 rounded-md px-2.5 text-[11px] font-medium border border-border-default bg-bg-elevated",
            "text-text-primary hover:bg-bg-hover transition-colors",
            "disabled:opacity-50 disabled:cursor-not-allowed",
          )}
        >
          {installing ? "Installing…" : cli?.installed ? "Reinstall" : "Install"}
        </button>
      </SettingRow>
    </div>
  );
}

function AppearanceSettings() {
  return (
    <div className="space-y-6">
      <SectionTitle title="Appearance" subtitle="Visual preferences" />
      <SettingRow label="Font size" description="Editor and UI font size">
        <select
          defaultValue="14"
          className="h-7 rounded px-2 text-[11px] outline-none"
        >
          {[11, 12, 13, 14, 15, 16].map((s) => (
            <option key={s} value={s}>{s}px</option>
          ))}
        </select>
      </SettingRow>
    </div>
  );
}

function KeybindingsSettings() {
  const groups: Array<{
    title: string;
    bindings: Array<{ action: string; keys: string }>;
  }> = [
    {
      title: "General",
      bindings: [
        { action: "Command Palette", keys: "⌘K" },
        { action: "Global Search", keys: "⌘⇧F" },
        { action: "Settings", keys: "⌘," },
        { action: "New Window", keys: "⌘⇧N" },
      ],
    },
    {
      title: "Tabs",
      bindings: [
        { action: "New Chat tab", keys: "⌘T" },
        { action: "New Terminal tab", keys: "⌘⇧T" },
        { action: "Close current tab", keys: "⌘W" },
        { action: "Previous tab", keys: "⌘⇧[" },
        { action: "Next tab", keys: "⌘⇧]" },
        { action: "Switch to tab 1–9", keys: "⌘1…9" },
      ],
    },
    {
      title: "Layout",
      bindings: [
        { action: "Toggle Left Panel", keys: "⌘B" },
        { action: "Toggle Right Panel", keys: "⌘⇧B" },
        { action: "Toggle Tab Bar", keys: "⌘⌥T" },
        { action: "Toggle Status Bar", keys: "⌘⌥B" },
        { action: "Toggle Agent Sidebar", keys: "⌘⌥J" },
        { action: "Toggle Terminal", keys: "⌘J" },
      ],
    },
    {
      title: "Chat",
      bindings: [
        { action: "Find in chat", keys: "⌘F" },
        { action: "Send message", keys: "⌘↵" },
        { action: "Cycle permission mode", keys: "⇧⇥" },
      ],
    },
  ];

  return (
    <div className="space-y-6">
      <SectionTitle title="Keybindings" subtitle="Keyboard shortcuts" />
      {groups.map((g) => (
        <div key={g.title} className="space-y-2">
          <div className="text-[10px] uppercase tracking-wider text-text-tertiary px-1">
            {g.title}
          </div>
          <div className="rounded-lg border border-border-default overflow-hidden">
            {g.bindings.map((b, i) => (
              <div
                key={b.action}
                className={cn(
                  "flex items-center justify-between px-3 h-[32px]",
                  i > 0 && "border-t border-border-subtle"
                )}
              >
                <span className="text-[11px] text-text-secondary">{b.action}</span>
                <KbdCombo combo={b.keys} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function DeveloperSettings() {
  const triggerClaudeInstall = useDevFlagsStore.use.triggerClaudeInstall();
  const { setTriggerClaudeInstall } = useDevFlagsStore.use.actions();
  const { refreshStatus } = useClaudeSetupStore.use.actions();

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Developer"
        subtitle="Diagnostic toggles for UI testing — these change app behavior, leave off in normal use"
      />

      <div className="space-y-2">
        <div className="text-[10px] uppercase tracking-wider text-text-tertiary px-1">
          Claude Code setup
        </div>
        <div className="rounded-lg border border-border-default bg-bg-secondary px-3 py-3 space-y-3">
          <SettingRow
            label="Trigger Claude Install"
            description="Force the install banner to appear regardless of whether the CLI is actually installed. The Install button and sign-in dialog run a simulated flow on this machine — no real curl, no real `claude /login`. Use this to UI-test the onboarding surface."
          >
            <Toggle
              checked={triggerClaudeInstall}
              onChange={(next) => {
                setTriggerClaudeInstall(next);
                // Re-run status so the banner reflects the new override
                // immediately (turning OFF probes the real CLI again).
                void refreshStatus();
              }}
            />
          </SettingRow>
        </div>
      </div>
    </div>
  );
}

function AboutSettings() {
  return (
    <div className="space-y-4">
      <SectionTitle title="About" subtitle="Atlas IDE" />
      <div className="rounded-lg border border-border-default bg-bg-secondary p-4 space-y-2">
        <div className="flex items-center gap-2">
          <AtlasIcon size={40} className="rounded-xl" />
          <div>
            <p className="text-sm font-semibold text-text-primary">Atlas</p>
            <p className="text-[10px] text-text-tertiary">v0.1.5 — The second brain IDE</p>
          </div>
        </div>
        <p className="text-[11px] text-text-secondary leading-relaxed pt-2">
          Built with Tauri, React, and Rust. An everything app for agentic development — from code analysis to task management, research, and AI orchestration.
        </p>
      </div>
    </div>
  );
}

function SectionTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
      <p className="text-[11px] text-text-tertiary mt-0.5">{subtitle}</p>
    </div>
  );
}

function SettingRow({ label, description, children }: { label: string; description: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-[12px] font-medium text-text-primary">{label}</p>
        <p className="text-[10px] text-text-tertiary mt-0.5">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/**
 * Toggle — controlled OR uncontrolled. If `checked` is provided the parent
 * owns the state and `onChange` is fired on click; otherwise we keep
 * internal state seeded by `defaultChecked` (original behavior).
 */
function Toggle({
  defaultChecked = false,
  checked,
  onChange,
}: {
  defaultChecked?: boolean;
  checked?: boolean;
  onChange?: (next: boolean) => void;
}) {
  const [internal, setInternal] = useState(defaultChecked);
  const isControlled = checked !== undefined;
  const value = isControlled ? checked : internal;
  const apply = (next: boolean) => {
    if (!isControlled) setInternal(next);
    onChange?.(next);
  };
  // shadcn/Radix switch proportions: the track has a 2px transparent
  // border so its inner content area is exactly the thumb's size,
  // making the thumb fill vertically and animate translate-x-0 → -x-4
  // edge to edge. The thumb flips color when ON because Atlas's accent
  // is pure white — a white-on-white thumb would disappear.
  return (
    <button
      onClick={() => apply(!value)}
      role="switch"
      aria-checked={value}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center",
        "rounded-full border-2 border-transparent transition-colors",
        value
          ? "bg-[var(--accent-primary)]"
          : "bg-[var(--bg-elevated)]"
      )}
    >
      <span
        className={cn(
          "pointer-events-none block h-4 w-4 rounded-full shadow-[0_1px_3px_rgba(0,0,0,0.45)]",
          "transition-transform duration-150",
          value
            ? "translate-x-4 bg-[var(--bg-base)]"
            : "translate-x-0 bg-white"
        )}
      />
    </button>
  );
}

