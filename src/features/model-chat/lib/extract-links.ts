import type { ChatMessage } from "@/types/agent";

export interface ChatLink {
  url: string;
  /** Index of the message the link first appeared in. */
  messageIndex: number;
  /** "user" | "assistant" — for a subtle source hint. */
  role: ChatMessage["role"];
}

// Bare http(s) URLs. Trailing sentence punctuation is trimmed below.
const URL_RE = /\bhttps?:\/\/[^\s<>()[\]"'`]+/gi;

/** Collect unique links across a conversation, in first-seen order. */
export function extractLinks(messages: ChatMessage[]): ChatLink[] {
  const seen = new Set<string>();
  const out: ChatLink[] = [];
  messages.forEach((m, i) => {
    const matches = m.content.match(URL_RE);
    if (!matches) return;
    for (const raw of matches) {
      const url = raw.replace(/[.,;:!?)\]]+$/, "");
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({ url, messageIndex: i, role: m.role });
    }
  });
  return out;
}

/** Pretty "host/path" label for a URL, falling back to the raw string. */
export function linkLabel(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${u.host}${path}${u.search}`.replace(/\/$/, "");
  } catch {
    return url;
  }
}
