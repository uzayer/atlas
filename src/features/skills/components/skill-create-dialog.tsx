import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { sanitizeSkillName } from "../lib/sanitize";
import type { Scope } from "../lib/types";

const BODY_PLACEHOLDER = `Describe what this skill does and how the agent should use it.

## When to use
- ...

## Steps
1. ...`;

/**
 * Create a new on-disk skill in the canonical store. Frontmatter
 * (name/description) is supplied via the dedicated fields; the textarea is the
 * SKILL.md body only — Rust assembles the final file. The slug preview shows
 * the sanitized directory name live.
 *
 * v1 has no per-agent fan-out: the skill is invoked with `#skill:` (universal
 * across agents), so it's created with no symlink targets (`agents: []`).
 * Native delivery is the opt-in Phase 3 enhancement.
 */
export function SkillCreateDialog({
  open,
  onOpenChange,
  scope,
  onCreate,
  initialName = "",
  initialDescription = "",
  initialBody = "",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: Scope;
  onCreate: (
    name: string,
    description: string,
    body: string,
    agentIds: string[],
  ) => Promise<unknown>;
  /** Prefill values, seeded when the dialog opens (e.g. "Save as skill" capture). */
  initialName?: string;
  initialDescription?: string;
  initialBody?: string;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const slug = useMemo(() => sanitizeSkillName(name), [name]);

  // Seed the form only when the dialog transitions closed→open (prefill on
  // capture; empty for a fresh "New skill"). Guarded so changing the initial
  // props while open never clobbers in-progress edits.
  const prevOpen = useRef(false);
  useEffect(() => {
    if (open && !prevOpen.current) {
      setName(initialName);
      setDescription(initialDescription);
      setBody(initialBody);
      setSubmitting(false);
    }
    prevOpen.current = open;
  }, [open, initialName, initialDescription, initialBody]);

  const canSubmit =
    slug.length > 0 && description.trim().length > 0 && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await onCreate(name, description.trim(), body, []);
      toast.success(`Created skill "${slug}"`);
      onOpenChange(false);
    } catch (e) {
      toast.error(
        `Create failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[var(--z-overlay)] bg-black/60" />
        <Dialog.Content
          style={{ boxShadow: "var(--shadow-overlay)" }}
          className={cn(
            "fixed left-1/2 top-[12%] z-[var(--z-modal)] -translate-x-1/2",
            "flex max-h-[76vh] w-[520px] flex-col overflow-hidden rounded-lg",
            "border border-border-default bg-bg-overlay",
          )}
        >
          <div className="flex h-[40px] shrink-0 items-center border-b border-border-default px-4">
            <Dialog.Title className="text-[13px] font-medium text-text-primary">
              New skill
            </Dialog.Title>
            <span className="ml-2 text-[10px] text-text-tertiary">
              {scope === "global"
                ? "Global (~/.atlas/skills)"
                : "Project (.atlas/skills)"}
            </span>
          </div>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto hide-scrollbar px-4 py-4">
            {/* Name + slug preview */}
            <Field label="Name" id="skill-name">
              <input
                id="skill-name"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="PDF Extract"
                spellCheck={false}
                className={inputCls}
              />
              {name.length > 0 && (
                <p className="mt-1 text-[10px] text-text-tertiary">
                  Directory:{" "}
                  <span className="font-mono text-text-secondary">
                    {slug || "—"}
                  </span>
                </p>
              )}
            </Field>

            {/* Description */}
            <Field label="Description" id="skill-description">
              <input
                id="skill-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Pull text & tables out of PDFs"
                spellCheck={false}
                className={inputCls}
              />
            </Field>

            {/* Body */}
            <Field label="SKILL.md body" id="skill-body">
              <textarea
                id="skill-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder={BODY_PLACEHOLDER}
                spellCheck={false}
                rows={8}
                className={cn(
                  inputCls,
                  "resize-none font-mono leading-relaxed",
                )}
              />
            </Field>

            <p className="text-[10px] leading-snug text-text-tertiary">
              Invoke it anywhere with{" "}
              <span className="font-mono text-text-secondary">
                #skill:{slug || "name"}
              </span>{" "}
              — the procedure is inlined into your prompt for any agent.
            </p>
          </div>

          {/* Footer */}
          <div className="flex h-[48px] shrink-0 items-center justify-end gap-2 border-t border-border-default px-4">
            <Dialog.Close asChild>
              <button
                type="button"
                className="h-7 rounded-md border border-border-default px-3 text-[12px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
              >
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-md px-3 text-[12px] font-medium transition-colors",
                canSubmit
                  ? "bg-accent text-bg-base hover:bg-accent-hover"
                  : "cursor-not-allowed bg-bg-raised text-text-ghost",
              )}
            >
              {submitting && <Loader2 size={12} className="animate-spin" />}
              Create skill
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const inputCls = cn(
  "w-full rounded-md border border-border-default bg-bg-input px-2.5 py-1.5",
  "text-[12px] text-text-primary placeholder:text-text-ghost outline-none",
  "transition-colors focus-visible:border-border-focus focus-visible:ring-1 focus-visible:ring-border-focus",
);

function Field({
  label,
  id,
  children,
}: {
  label: string;
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-text-tertiary"
      >
        {label}
      </label>
      {children}
    </div>
  );
}
