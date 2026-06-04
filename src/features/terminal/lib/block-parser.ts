/**
 * Stateful parser that turns the raw PTY byte stream into command
 * "blocks", using the shell-integration markers our zsh hook emits:
 *   OSC 133 ; A            prompt drawn        (→ enter "prompt" mode, discard)
 *   OSC 6973 ; C ; <cmd>   command text        (preexec)
 *   OSC 133 ; C            output begins        (→ start a block, "output" mode)
 *   OSC 133 ; D ; <exit>   command ended        (→ finalize, exit code)
 *   OSC 7 ; file://host<p> working directory
 *   CSI ? 1049 h / l       alt-screen enter/leave (interactive app → xterm)
 *
 * Between A and C (the prompt + the echoed command) is discarded — the command
 * itself shows in the block header (from OSC 6973). Between C and D is the
 * block's raw output (SGR preserved for `ansiToSegments`). Bytes still go to a
 * hidden xterm in parallel (the interactive surface); this only builds the
 * history view.
 */

export interface TerminalBlock {
  id: number;
  command: string;
  cwd: string;
  /** Raw output (with SGR) between OSC 133 C and D. */
  output: string;
  exitCode: number | null;
  running: boolean;
  startedAt: number;
  endedAt: number | null;
}

const ESC = 0x1b;

export class BlockStreamParser {
  private pending = "";
  private mode: "prompt" | "output" = "prompt";
  private pendingCommand = "";
  private cwd = "";
  private nextId = 1;
  blocks: TerminalBlock[] = [];
  altScreen = false;
  private current: TerminalBlock | null = null;
  private preambleId = 0;
  private integrated = false;

  constructor(initialCwd: string, private onChange: () => void) {
    this.cwd = initialCwd;
    // Preamble block: the shell banner / output before the first prompt marker.
    // If shell integration ISN'T active (no OSC 133 ever), EVERYTHING stays
    // here — the terminal degrades to a single continuous output block.
    this.current = {
      id: this.nextId++,
      command: "",
      cwd: initialCwd,
      output: "",
      exitCode: null,
      running: true,
      startedAt: Date.now(),
      endedAt: null,
    };
    this.blocks = [this.current];
    this.preambleId = this.current.id;
    this.mode = "output";
  }

  /** Feed decoded text (caller decodes bytes with a streaming TextDecoder). */
  push(text: string): void {
    this.pending += text;
    let changed = false;
    let i = 0;
    const s = this.pending;
    const n = s.length;

    const appendOut = (chunk: string) => {
      if (this.mode === "output" && this.current) {
        this.current.output += chunk;
        changed = true;
      }
    };

    while (i < n) {
      const ch = s.charCodeAt(i);
      if (ch !== ESC) {
        // Plain run up to the next ESC.
        let j = i + 1;
        while (j < n && s.charCodeAt(j) !== ESC) j++;
        appendOut(s.slice(i, j));
        i = j;
        continue;
      }

      // ESC — need at least 2 chars to know the type.
      if (i + 1 >= n) break; // incomplete; wait for more
      const t = s[i + 1];

      if (t === "]") {
        // OSC — terminated by BEL (0x07) or ST (ESC \).
        let j = i + 2;
        let term = -1;
        let termLen = 0;
        while (j < n) {
          if (s.charCodeAt(j) === 0x07) { term = j; termLen = 1; break; }
          if (s.charCodeAt(j) === ESC && s[j + 1] === "\\") { term = j; termLen = 2; break; }
          j++;
        }
        if (term === -1) break; // incomplete OSC; wait
        const body = s.slice(i + 2, term);
        if (this.handleOsc(body)) changed = true;
        i = term + termLen;
        continue;
      }

      if (t === "[") {
        // CSI — final byte in @-~.
        let j = i + 2;
        while (j < n && !/[@-~]/.test(s[j])) j++;
        if (j >= n) break; // incomplete CSI; wait
        const seq = s.slice(i, j + 1);
        const body = s.slice(i + 2, j);
        if (body === "?1049" && s[j] === "h") { this.altScreen = true; changed = true; }
        else if (body === "?1049" && s[j] === "l") { this.altScreen = false; changed = true; }
        else appendOut(seq); // keep SGR / other CSI in the block output
        i = j + 1;
        continue;
      }

      // Other escapes (charset designation ESC( / ESC) , single ST, etc.)
      if (t === "(" || t === ")") {
        if (i + 2 >= n) break;
        i += 3;
        continue;
      }
      // Lone ESC + one byte.
      i += 2;
    }

    this.pending = s.slice(i);
    if (changed) this.onChange();
  }

  private handleOsc(body: string): boolean {
    // OSC 7 — working directory: "7;file://host/abs/path"
    if (body.startsWith("7;")) {
      const m = body.match(/file:\/\/[^/]*(\/[^\x07]*)/);
      if (m) this.cwd = decodeURIComponent(m[1]);
      return false;
    }
    // OSC 6973 — Atlas command text: "6973;C;<command>"
    if (body.startsWith("6973;C;")) {
      this.pendingCommand = body.slice("6973;C;".length);
      return false;
    }
    // OSC 133 — semantic prompt markers.
    if (body.startsWith("133;")) {
      const part = body.slice(4);
      const kind = part[0];
      if (kind === "A") {
        // First prompt marker → shell integration is live. Drop the preamble
        // block (the shell's startup banner / the bare `%` prompt) so the
        // terminal starts clean instead of with an empty "%" block.
        if (!this.integrated) {
          this.integrated = true;
          this.blocks = this.blocks.filter((b) => b.id !== this.preambleId);
          if (this.current?.id === this.preambleId) this.current = null;
          this.mode = "prompt";
          return true;
        }
        this.mode = "prompt";
      } else if (kind === "C") {
        // Output begins — open a new block.
        this.current = {
          id: this.nextId++,
          command: this.pendingCommand.trim(),
          cwd: this.cwd,
          output: "",
          exitCode: null,
          running: true,
          startedAt: Date.now(),
      endedAt: null,
        };
        this.pendingCommand = "";
        this.blocks = [...this.blocks, this.current];
        this.mode = "output";
        return true;
      } else if (kind === "D") {
        const code = parseInt(part.split(";")[1] ?? "", 10);
        if (this.current) {
          this.current.running = false;
          this.current.endedAt = Date.now();
          // Trim trailing blank lines for a compact block (the `%` partial-line
          // mark itself is suppressed at the source via `unsetopt PROMPT_SP`).
          this.current.output = this.current.output.replace(/[\r\n]+$/, "");
          // The preamble block (no command) carries no meaningful exit code.
          this.current.exitCode =
            this.current.command === "" || Number.isNaN(code) ? null : code;
          // Replace with a new object so React sees the change.
          this.blocks = this.blocks.map((b) =>
            b.id === this.current!.id ? { ...this.current! } : b
          );
        }
        this.current = null;
        this.mode = "prompt";
        return true;
      }
    }
    return false;
  }
}
