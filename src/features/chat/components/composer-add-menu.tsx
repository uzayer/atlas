// The composer's "+" attach menu — "Add files or photos" plus a Skills
// submenu. Presentation only: the file dialog and image-vs-path routing live
// in the parent (`message-input.tsx::pickFilesOrPhotos`), and the skill list
// reuses the `#` rail's search source so menu and rail cannot drift.
//
// `imageSupported` only changes the wording ("files or photos" vs "files"):
// without image support a picked image still works — it rides along as a
// path mention chip the agent reads off disk.

import { useEffect, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronRight, Loader2, Paperclip, Plus, SquareSlash } from "lucide-react";
import { cn } from "@/lib/utils";
import { searchMentions, type MentionSkill } from "../lib/mentions";

interface ComposerAddMenuProps {
  disabled?: boolean;
  /** Project root — scopes the skill list to global + this project. */
  projectPath: string | null;
  /** Skill-registry agent id (e.g. "claude-code" | "codex" | "cersei"). */
  agentId?: string;
  /** Agent accepts inline base64 images (`promptCapabilities.image`). */
  imageSupported: boolean;
  onAddFilesOrPhotos: () => void;
  onPickSkill: (skill: MentionSkill) => void;
}

const ITEM_CLASS =
  "flex items-center gap-2 px-3 h-[26px] text-[11px] cursor-default outline-none " +
  "text-[var(--text-secondary)] data-[highlighted]:bg-[var(--bg-hover)] " +
  "data-[highlighted]:text-[var(--text-primary)]";

const CONTENT_CLASS =
  "rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] " +
  "shadow-[var(--shadow-overlay)] py-1";

export function ComposerAddMenu({
  disabled,
  projectPath,
  agentId,
  imageSupported,
  onAddFilesOrPhotos,
  onPickSkill,
}: ComposerAddMenuProps) {
  const [open, setOpen] = useState(false);
  // null = not loaded yet (spinner on first open); [] = loaded, none found.
  const [skills, setSkills] = useState<MentionSkill[] | null>(null);
  const [skillsError, setSkillsError] = useState(false);

  // Lazy-load skills the first time the menu opens; refetch never (the menu
  // is short-lived and the catalog changes rarely — reopening a chat tab
  // remounts the composer anyway).
  useEffect(() => {
    if (!open || skills !== null) return;
    let cancelled = false;
    searchMentions("", "skill", { projectPath, agentId })
      .then((found) => {
        if (cancelled) return;
        setSkills(found.filter((m): m is MentionSkill => m.kind === "skill"));
      })
      .catch(() => {
        if (cancelled) return;
        setSkills([]);
        setSkillsError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, skills, projectPath, agentId]);

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          disabled={disabled}
          className={cn(
            "flex items-center justify-center w-6.5 h-6.5 rounded-full border border-[var(--border-default)]",
            "bg-[var(--bg-elevated)] text-[var(--text-secondary)] transition-colors outline-none",
            disabled
              ? "opacity-50 cursor-default"
              : "hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-pointer",
          )}
          title="Add files, photos, or skills"
        >
          <Plus size={13} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          side="top"
          sideOffset={6}
          className={cn(CONTENT_CLASS, "min-w-[190px]")}
          style={{ zIndex: 9999 }}
        >
          <DropdownMenu.Item className={ITEM_CLASS} onSelect={onAddFilesOrPhotos}>
            <Paperclip size={11} />
            <span>{imageSupported ? "Add files or photos" : "Add files"}</span>
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-[var(--border-default)]" />
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className={ITEM_CLASS}>
              <SquareSlash size={11} />
              <span>Skills</span>
              <ChevronRight size={11} className="ml-auto text-[var(--text-tertiary)]" />
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent
                sideOffset={6}
                className={cn(CONTENT_CLASS, "min-w-[220px] max-w-[280px] max-h-[320px] overflow-y-auto")}
                style={{ zIndex: 9999 }}
              >
                {skills === null ? (
                  <div className="flex items-center gap-2 px-3 h-[26px] text-[11px] text-[var(--text-tertiary)]">
                    <Loader2 size={11} className="animate-spin" />
                    Loading skills…
                  </div>
                ) : skills.length === 0 ? (
                  <div className="px-3 py-1.5 text-[11px] text-[var(--text-tertiary)]">
                    {skillsError ? "Couldn't load skills." : "No skills installed"}
                  </div>
                ) : (
                  skills.map((skill) => (
                    <DropdownMenu.Item
                      key={skill.id}
                      className={cn(ITEM_CLASS, "h-auto items-start py-1.5")}
                      onSelect={() => onPickSkill(skill)}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-[var(--text-primary)]">
                            {skill.displayName}
                          </span>
                          {skill.scope === "project" && (
                            <span className="shrink-0 rounded px-1 text-[9px] leading-4 border border-[var(--border-default)] text-[var(--text-tertiary)]">
                              project
                            </span>
                          )}
                        </div>
                        {skill.description && (
                          <div className="text-[10px] text-[var(--text-tertiary)] line-clamp-2">
                            {skill.description}
                          </div>
                        )}
                      </div>
                    </DropdownMenu.Item>
                  ))
                )}
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
