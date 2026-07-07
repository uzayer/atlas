import {
  modelchat,
  listenModelChat,
  type WireMsg,
} from "@/features/model-chat/lib/model-chat-api";

/** Extract 2-3 chip strings from a model reply — tolerant of prose around the
 *  JSON array (mirrors the canvas store's robust op parsing). */
function parseChips(raw: string): string[] {
  const m = raw.match(/\[[\s\S]*\]/);
  if (m) {
    try {
      const arr = JSON.parse(m[0]);
      if (Array.isArray(arr)) {
        return arr
          .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
          .map((x) => x.trim().replace(/^["'\-*\d.)\s]+/, "").slice(0, 120))
          .filter(Boolean)
          .slice(0, 3);
      }
    } catch {
      /* fall through */
    }
  }
  return [];
}

/**
 * Generate 2-3 next-step suggestion chips for a finished turn via a single BYOK
 * model call. Opt-in (`adaptiveSuggestions === "llm"`) and only used when the
 * parse-first path found no explicit "Next steps" list. Resolves to `[]` on any
 * error/cancel so callers can degrade silently.
 */
export function generateSuggestions(opts: {
  turnText: string;
  files: string[];
  provider: string;
  model: string;
}): Promise<string[]> {
  return new Promise((resolve) => {
    const streamId = crypto.randomUUID();
    let text = "";
    let unlisten: (() => void) | null = null;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      unlisten?.();
      resolve(parseChips(text));
    };

    const prompt = [
      "You suggest what the user might want next after a coding-agent turn.",
      "Return ONLY a JSON array of 2-3 short imperative follow-up actions",
      "(each under 8 words, e.g. \"Add tests for the new parser\"). No prose.",
      opts.files.length ? `Files changed: ${opts.files.join(", ")}` : "",
      "",
      "The turn:",
      opts.turnText.slice(0, 4000),
    ].join("\n");
    const messages: WireMsg[] = [{ role: "user", content: prompt }];

    (async () => {
      try {
        unlisten = await listenModelChat((e) => {
          if (e.stream_id !== streamId) return;
          if (e.kind === "text_delta") text += e.delta;
          else if (e.kind === "done" || e.kind === "error") finish();
        });
        await modelchat.stream(streamId, opts.provider, opts.model, messages);
        // Safety net: if `done` never arrives, settle after the stream call
        // returns (Rust resolves the invoke when the stream completes).
        setTimeout(finish, 500);
      } catch {
        finish();
      }
    })();
  });
}
