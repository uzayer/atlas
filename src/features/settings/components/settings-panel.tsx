import { useState } from "react";
import { ScrollArea } from "@/ui/scroll-area";
import { KbdCombo } from "@/ui/kbd";
import { cn } from "@/lib/utils";
import {
  Settings,
  Palette,
  Keyboard,
  Info,
} from "lucide-react";
import { AtlasIcon } from "@/components/atlas-icon";

const SECTIONS = [
  { id: "general", label: "General", icon: Settings },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "keybindings", label: "Keybindings", icon: Keyboard },
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
          {activeSection === "about" && <AboutSettings />}
        </div>
      </ScrollArea>
    </div>
  );
}

function GeneralSettings() {
  return (
    <div className="space-y-6">
      <SectionTitle title="General" subtitle="Application preferences" />
      <SettingRow
        label="Auto-save"
        description="Automatically save files after editing"
      >
        <Toggle defaultChecked />
      </SettingRow>
      <SettingRow
        label="Restore last project"
        description="Reopen the last project on launch"
      >
        <Toggle />
      </SettingRow>
      <SettingRow
        label="Show hidden files"
        description="Display dotfiles in the file explorer"
      >
        <Toggle />
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

function AboutSettings() {
  return (
    <div className="space-y-4">
      <SectionTitle title="About" subtitle="Atlas IDE" />
      <div className="rounded-lg border border-border-default bg-bg-secondary p-4 space-y-2">
        <div className="flex items-center gap-2">
          <AtlasIcon size={40} className="rounded-xl" />
          <div>
            <p className="text-sm font-semibold text-text-primary">Atlas</p>
            <p className="text-[10px] text-text-tertiary">v0.1.2 — The second brain IDE</p>
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

function Toggle({ defaultChecked = false }: { defaultChecked?: boolean }) {
  const [checked, setChecked] = useState(defaultChecked);
  return (
    <button
      onClick={() => setChecked(!checked)}
      className={cn(
        "w-8 h-[18px] rounded-full transition-colors relative",
        checked ? "bg-accent" : "bg-bg-elevated border border-border-default"
      )}
    >
      <div
        className={cn(
          "w-3.5 h-3.5 rounded-full bg-white shadow-sm absolute top-[1px] transition-transform",
          checked ? "translate-x-[15px]" : "translate-x-[1px]"
        )}
      />
    </button>
  );
}

