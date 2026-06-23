import { useEffect, useState } from "react";
import { SkillCreateDialog } from "./skill-create-dialog";
import { useSkillsStore } from "../stores/skills-store";
import { useProjectStore } from "@/features/project/stores/project-store";

/**
 * Listens for `atlas:skill-capture` (dispatched by the "Save as skill" message
 * action) and opens the create dialog prefilled with the captured text as the
 * SKILL.md body — the Phase 2 capture loop. Mounted once at the app root so
 * capture works from every view (chat, model-chat, memory-chat), not just the
 * agent chat panel. Cross-feature coordination uses a window CustomEvent,
 * matching the existing `atlas:chat-reply` pattern; the store stays the single
 * source of truth for creation.
 */
export interface SkillCaptureDetail {
  body: string;
  name?: string;
  description?: string;
}

export function SkillCaptureHost() {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<SkillCaptureDetail>({ body: "" });
  const scope = useSkillsStore.use.scope();
  const { create } = useSkillsStore.use.actions();

  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent<SkillCaptureDetail>).detail;
      if (!d) return;
      // Point the store at the current project and default to project scope when
      // one is open (a skill born from project work lives there); else global.
      const project = useProjectStore.getState().currentProject;
      const actions = useSkillsStore.getState().actions;
      void actions.load(project?.path ?? null);
      void actions.setScope(project ? "project" : "global");
      setDetail({
        body: d.body ?? "",
        name: d.name ?? "",
        description: d.description ?? "",
      });
      setOpen(true);
    };
    window.addEventListener("atlas:skill-capture", handler);
    return () => window.removeEventListener("atlas:skill-capture", handler);
  }, []);

  return (
    <SkillCreateDialog
      open={open}
      onOpenChange={setOpen}
      scope={scope}
      onCreate={create}
      initialName={detail.name}
      initialDescription={detail.description}
      initialBody={detail.body}
    />
  );
}
