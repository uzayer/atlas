// Parse a trailing "Next steps" bulleted section out of assistant markdown.
// The free, all-agents default for the adaptive turn card's suggestion chips
// (the BYOK LLM path is an opt-in augmentation). Returns up to 3 short items.

const HEADINGS = new Set([
  "next steps",
  "next step",
  "suggested next steps",
  "recommended next steps",
  "what next",
  "what's next",
  "whats next",
]);

export function parseNextSteps(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  // Find the LAST heading that looks like a next-steps section.
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const norm = lines[i]
      .trim()
      .toLowerCase()
      .replace(/[#*_:`]/g, "")
      .trim();
    if (HEADINGS.has(norm)) {
      start = i;
      break;
    }
  }
  if (start < 0) return [];

  const chips: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) {
      if (chips.length) break; // blank line ends the list once we've started
      continue;
    }
    const m = raw.match(/^(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (!m) {
      if (chips.length) break;
      continue;
    }
    let item = m[1]
      .trim()
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/[*_`]/g, "")
      .trim();
    // Prefer the bold/lead clause: drop a trailing " — explanation" tail.
    const dash = item.search(/\s[—–-]\s/);
    if (dash > 20) item = item.slice(0, dash).trim();
    if (item.length > 120) item = item.slice(0, 117).trimEnd() + "…";
    if (item) chips.push(item);
    if (chips.length >= 3) break;
  }
  return chips;
}
