import { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Check,
  ChevronsUpDown,
  Plus,
  Settings,
  UserPlus,
  LogOut,
  Cloud,
  UserCircle2,
  Building2,
  Pencil,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/features/workspaces/stores/workspace-store";
import { useOrgStore } from "../stores/org-store";
import { switchOrg, deleteOrgAndData } from "../lib/org-switch";
import type { Organisation } from "../types";

/** Two-letter avatar seed from an org name. */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function OrgAvatar({ org, size = 20 }: { org: Organisation; size?: number }) {
  return (
    <span
      className="flex items-center justify-center rounded-[5px] shrink-0 font-semibold text-[var(--text-primary)]"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        background: org.color ?? "var(--bg-hover)",
      }}
    >
      {org.logo ? (
        <img src={org.logo} alt="" className="h-full w-full rounded-[5px] object-cover" />
      ) : (
        initials(org.name)
      )}
    </span>
  );
}

/** A stubbed/disabled menu item (auth-gated) with a "coming soon" tooltip. */
function StubItem({
  icon,
  label,
  shortcut,
}: {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
}) {
  return (
    <div
      title="Available after sign-in"
      className="w-full flex items-center gap-2 px-3 h-[28px] text-[11px] text-[var(--text-secondary)] opacity-70 cursor-not-allowed select-none"
    >
      <span className="shrink-0 text-[var(--text-tertiary)]">{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      {shortcut && <span className="text-[9px] text-[var(--text-tertiary)]">{shortcut}</span>}
    </div>
  );
}

/**
 * Organisation switcher — the top-level tenant picker (Linear-style). Renders
 * the full menu shell; auth-dependent items (Settings, Invite, Log out, account
 * header, Turn on sync) are stubbed/disabled until the auth branch lands.
 */
export function OrgSwitcher() {
  const organisations = useOrgStore.use.organisations();
  const activeOrganisationId = useOrgStore.use.activeOrganisationId();
  const { createOrg, rename, enableSync } = useOrgStore.use.actions();
  const workspaces = useWorkspaceStore.use.workspaces();

  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  // Inline-rename state: the org id being renamed + its draft name.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  // Org pending delete-confirmation (null = no dialog).
  const [confirmDelete, setConfirmDelete] = useState<Organisation | null>(null);
  const canDelete = organisations.length > 1;

  const active =
    organisations.find((o) => o.id === activeOrganisationId) ?? organisations[0];

  const submitCreate = () => {
    const name = newName.trim();
    if (!name) return;
    const id = createOrg(name);
    if (!id) {
      toast.error(`An organisation named “${name}” already exists`);
      return;
    }
    setCreating(false);
    setNewName("");
    setOpen(false);
    void switchOrg(id);
  };

  const beginRename = (id: string, currentName: string) => {
    setEditingId(id);
    setEditName(currentName);
  };
  const submitRename = () => {
    if (!editingId) return;
    const name = editName.trim();
    if (!name) {
      setEditingId(null);
      return;
    }
    const org = organisations.find((o) => o.id === editingId);
    // No change → just close (rename would no-op anyway).
    if (org && org.name === name) {
      setEditingId(null);
      return;
    }
    if (!rename(editingId, name)) {
      toast.error(`An organisation named “${name}” already exists`);
      return;
    }
    setEditingId(null);
  };

  if (!active) return null;

  return (
    // Fixed 29px row + border-b so the divider aligns exactly with the file-tree
    // "ATLAS" header and the editor tab bar (both h-[29px] border-b under the
    // titlebar).
    <div className="h-[29px] shrink-0 flex items-center px-1.5 border-b border-[var(--border-default)]">
      <DropdownMenu.Root
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) {
            setCreating(false);
            setNewName("");
            setEditingId(null);
          }
        }}
      >
        <DropdownMenu.Trigger asChild>
          <button
            className="flex items-center gap-2 px-2 py-0.5 rounded-md outline-none text-[12px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-active)] transition-colors cursor-pointer min-w-0"
            title="Switch organisation"
          >
            <OrgAvatar org={active} size={16} />
            <span className="text-left truncate">{active.name}</span>
            <ChevronsUpDown size={12} className="text-[var(--text-tertiary)] shrink-0" />
          </button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            sideOffset={4}
            className="z-[var(--z-max)] w-[280px] max-h-[460px] rounded-lg border border-[var(--border-default)] bg-[#000] shadow-xl text-[var(--text-secondary)] flex flex-col overflow-hidden"
          >
            {/* Account header (stub until auth). */}
            <div className="px-3 pt-2.5 pb-1.5 text-[10px] text-[var(--text-tertiary)] flex items-center gap-1.5 shrink-0">
              <UserCircle2 size={12} className="shrink-0" />
              <span className="truncate">Local · not signed in</span>
            </div>

            <StubItem icon={<Settings size={13} />} label="Settings" shortcut="G then S" />
            <StubItem icon={<UserPlus size={13} />} label="Invite and manage members" />

            <DropdownMenu.Separator className="my-1 h-px bg-[var(--border-default)]" />

            {/* Organisation list. */}
            <div className="px-3 pt-1 pb-1.5 text-[10px] text-[var(--text-tertiary)] flex items-center gap-1.5 shrink-0">
              <Building2 size={12} className="shrink-0" />
              <span className="truncate">Organisation</span>
            </div>
            <div className="overflow-y-auto pb-1 hide-scrollbar">
              {organisations.map((org) => {
                const isActive = org.id === active.id;
                // Inline-rename row: a plain input (NOT a menu item) so typing
                // doesn't trigger Radix typeahead / select / close.
                if (editingId === org.id) {
                  return (
                    <div
                      key={org.id}
                      className="w-full flex items-center gap-2 px-3 h-[28px]"
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <OrgAvatar org={org} size={18} />
                      <input
                        autoFocus
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") submitRename();
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        onBlur={submitRename}
                        className="flex-1 min-w-0 bg-transparent outline-none text-[12px] text-[var(--text-primary)]"
                      />
                    </div>
                  );
                }
                return (
                  <DropdownMenu.Item
                    key={org.id}
                    onSelect={() => {
                      if (!isActive) void switchOrg(org.id);
                    }}
                    className="group/org w-full flex items-center gap-2 px-3 h-[28px] text-[12px] outline-none hover:bg-[var(--bg-active)] hover:text-[var(--text-primary)] cursor-pointer"
                  >
                    <OrgAvatar org={org} size={18} />
                    <span className="flex-1 text-left truncate">{org.name}</span>
                    {/* Rename (pencil) — appears on hover; doesn't switch/close. */}
                    <button
                      title="Rename organisation"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        beginRename(org.id, org.name);
                      }}
                      className="opacity-0 group-hover/org:opacity-100 p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-active)] transition-opacity shrink-0 cursor-pointer"
                    >
                      <Pencil size={11} />
                    </button>
                    {/* Delete — appears on hover; opens confirmation. Hidden when
                        this is the only org (can't delete the last one). */}
                    {canDelete && (
                      <button
                        title="Delete organisation"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setConfirmDelete(org);
                          setOpen(false);
                        }}
                        className="opacity-0 group-hover/org:opacity-100 p-0.5 rounded text-[var(--text-tertiary)] hover:text-error hover:bg-[var(--bg-active)] transition-opacity shrink-0 cursor-pointer"
                      >
                        <Trash2 size={11} />
                      </button>
                    )}
                    {isActive && (
                      <Check size={13} className="text-[var(--text-secondary)] shrink-0" />
                    )}
                  </DropdownMenu.Item>
                );
              })}
            </div>

            <DropdownMenu.Separator className="my-1 h-px bg-[var(--border-default)]" />

            {/* Create organisation — inline. */}
            {creating ? (
              <div
                className="flex items-center gap-1.5 px-3 h-[34px] shrink-0"
                onKeyDown={(e) => e.stopPropagation()}
              >
                <Plus size={12} className="text-[var(--text-tertiary)] shrink-0" />
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitCreate();
                    if (e.key === "Escape") {
                      setCreating(false);
                      setNewName("");
                    }
                  }}
                  placeholder="Organisation name…"
                  className="flex-1 bg-transparent outline-none text-[11px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
                />
              </div>
            ) : (
              <DropdownMenu.Item
                onSelect={(e) => {
                  e.preventDefault();
                  setCreating(true);
                }}
                className="w-full flex items-center gap-2 px-3 h-[28px] text-[11px] outline-none hover:bg-[var(--bg-active)] hover:text-[var(--text-primary)] cursor-pointer shrink-0"
              >
                <Plus size={13} className="text-[var(--text-tertiary)] shrink-0" />
                <span className="flex-1 text-left">Create organisation…</span>
              </DropdownMenu.Item>
            )}

            <DropdownMenu.Separator className="my-1 h-px bg-[var(--border-default)]" />

            {/* Sync toggle for the ACTIVE org — in the footer (not under the org
             *  list) so it's unambiguous which org it applies to. Stub. */}
            <DropdownMenu.Item
              onSelect={(e) => {
                e.preventDefault();
                enableSync(active.id);
              }}
              title="Sync coming soon"
              className="w-full flex items-center gap-2 px-3 h-[28px] text-[11px] outline-none text-[var(--text-secondary)] hover:bg-[var(--bg-active)] hover:text-[var(--text-primary)] cursor-pointer"
            >
              <Cloud size={13} className="shrink-0" />
              <span className="flex-1 text-left truncate">
                Turn on sync for {active.name}…
              </span>
              <span className="text-[9px] text-[var(--text-tertiary)] shrink-0">Soon</span>
            </DropdownMenu.Item>

            <StubItem icon={<UserCircle2 size={13} />} label="Add an account…" />
            <StubItem icon={<LogOut size={13} />} label="Log out" />
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <DeleteOrgDialog
        org={confirmDelete}
        projectCount={
          confirmDelete
            ? workspaces.filter((w) => w.orgId === confirmDelete.id).length
            : 0
        }
        onClose={() => setConfirmDelete(null)}
      />
    </div>
  );
}

/** Confirmation before wiping an organisation + all its org-scoped app data. */
function DeleteOrgDialog({
  org,
  projectCount,
  onClose,
}: {
  org: Organisation | null;
  projectCount: number;
  onClose: () => void;
}) {
  return (
    <Dialog.Root open={!!org} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[var(--z-max)] bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            "fixed left-1/2 top-1/2 z-[var(--z-max)] -translate-x-1/2 -translate-y-1/2",
            "w-[400px] max-w-[92vw] rounded-lg border border-border-default",
            "bg-[var(--bg-elevated)] p-5 shadow-[var(--shadow-overlay)] animate-scale-in",
          )}
        >
          <Dialog.Title className="text-[14px] font-medium text-[var(--text-primary)]">
            Delete “{org?.name}”?
          </Dialog.Title>
          <p className="mt-2 text-[12px] leading-relaxed text-[var(--text-secondary)]">
            This permanently removes the organisation
            {projectCount > 0 && (
              <>
                {" "}and its <span className="text-[var(--text-primary)]">{projectCount} project{projectCount === 1 ? "" : "s"}</span> (plus their chats)
              </>
            )}{" "}
            from Atlas. Your actual project files on disk are not touched. This
            can’t be undone.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button
              onClick={onClose}
              className="px-3 h-8 rounded-md text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-active)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                if (org) void deleteOrgAndData(org.id);
                onClose();
              }}
              className="px-3 h-8 rounded-md text-[12px] font-medium bg-error text-white hover:opacity-90 transition-opacity cursor-pointer"
            >
              Delete organisation
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
