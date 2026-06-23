/**
 * Sanitize a user-typed skill name into a safe on-disk slug. Mirrors the
 * reference `skills` CLI (`installer.ts`): lowercase, non-`[a-z0-9._]` → `-`,
 * collapse runs, trim edge dashes, cap at 255. The Rust side re-sanitizes (it
 * owns the truth + the path-traversal guard); this is only for the live preview
 * so the user sees what the directory will actually be called.
 */
export function sanitizeSkillName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9._]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 255);
}
