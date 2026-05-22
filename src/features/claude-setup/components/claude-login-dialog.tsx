import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ChevronRight,
  Globe,
  KeyRound,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useClaudeSetupStore } from "../stores/claude-setup-store";

/**
 * Two-option login dialog: paste an Anthropic API key, OR launch the
 * Claude Subscription OAuth flow (browser hand-off). Both paths complete
 * by re-running `claude_status` and flipping `phase` to `ready` if the
 * CLI reports authenticated.
 *
 * Mirrors the structure of `permission-modal.tsx` for visual consistency.
 */
export function ClaudeLoginDialog() {
  const open = useClaudeSetupStore.use.loginDialogOpen();
  const phase = useClaudeSetupStore.use.phase();
  const { authLogin, closeLoginDialog } = useClaudeSetupStore.use.actions();

  const [mode, setMode] = useState<"choose" | "api-key">("choose");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);

  const submitApiKey = async () => {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setApiKeyError("Paste your Anthropic API key.");
      return;
    }
    if (!trimmed.startsWith("sk-ant-")) {
      setApiKeyError("Doesn't look like an Anthropic key (expected sk-ant-…).");
      return;
    }
    setApiKeyError(null);
    await authLogin({ kind: "api_key", value: trimmed });
  };

  const startSubscription = () => {
    void authLogin({ kind: "subscription" });
  };

  const reset = () => {
    setMode("choose");
    setApiKey("");
    setApiKeyError(null);
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          closeLoginDialog();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
            "w-[480px] max-w-[92vw] rounded-md border border-border-default bg-bg-elevated shadow-xl",
            "text-text-primary",
          )}
        >
          <div className="flex items-start gap-3 border-b border-border-default px-4 py-3">
            <KeyRound className="mt-0.5 size-4 text-accent" />
            <div className="flex-1">
              <Dialog.Title className="text-sm font-medium">
                Sign in to Claude Code
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs text-text-secondary">
                Atlas runs prompts through your local <span className="font-mono">claude</span>{" "}
                CLI. Pick how you'd like to authenticate.
              </Dialog.Description>
            </div>
          </div>

          {mode === "choose" && (
            <div className="flex flex-col gap-1.5 px-4 py-3">
              <ChoiceButton
                icon={<KeyRound className="size-3.5 shrink-0" />}
                label="Anthropic API Key"
                description="Paste an sk-ant-… key from console.anthropic.com"
                onClick={() => setMode("api-key")}
              />
              <ChoiceButton
                icon={<Globe className="size-3.5 shrink-0" />}
                label="Claude Subscription"
                description="Open the OAuth flow in your browser to sign in with your Claude account."
                onClick={startSubscription}
              />
            </div>
          )}

          {mode === "api-key" && (
            <div className="flex flex-col gap-2 px-4 py-3">
              <label className="text-[11px] text-text-secondary">
                Anthropic API Key
              </label>
              <input
                type="password"
                autoFocus
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  if (apiKeyError) setApiKeyError(null);
                }}
                placeholder="sk-ant-…"
                disabled={phase === "authing"}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void submitApiKey();
                  }
                }}
                className={cn(
                  "w-full rounded-sm border bg-bg-base px-2 py-1.5 font-mono text-xs",
                  "outline-none focus:border-[var(--border-focus)]",
                  apiKeyError
                    ? "border-[var(--status-error)]/60"
                    : "border-border-default",
                )}
              />
              {apiKeyError && (
                <p className="text-[11px] text-[var(--status-error)]">{apiKeyError}</p>
              )}
              <p className="text-[10px] text-text-tertiary">
                Stored in <span className="font-mono">~/.claude/.credentials.json</span> with
                user-only permissions; the Claude CLI reads it from there.
              </p>
              <div className="mt-1 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => setMode("choose")}
                  className="rounded-sm px-2.5 py-1 text-xs text-text-secondary hover:bg-bg-base hover:text-text-primary"
                >
                  ← Back
                </button>
                <button
                  type="button"
                  onClick={() => void submitApiKey()}
                  disabled={phase === "authing"}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-sm border border-border-default bg-bg-base px-3 py-1 text-xs",
                    "hover:bg-bg-hover hover:text-text-primary disabled:opacity-50 disabled:cursor-not-allowed",
                  )}
                >
                  {phase === "authing" ? (
                    <Loader2 className="size-3.5 animate-spin text-accent" />
                  ) : null}
                  Save & verify
                </button>
              </div>
            </div>
          )}

          {phase === "authing" && mode === "choose" && (
            <div className="border-t border-border-default bg-bg-base px-4 py-2.5 text-[11px] text-text-secondary">
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="size-3 animate-spin text-accent" />
                Waiting for browser sign-in to complete…
              </span>
            </div>
          )}

          <div className="flex justify-end gap-2 border-t border-border-default px-4 py-2.5">
            <button
              type="button"
              onClick={() => {
                reset();
                closeLoginDialog();
              }}
              className="rounded-sm px-2.5 py-1 text-xs text-text-secondary hover:bg-bg-base hover:text-text-primary"
            >
              Cancel (ESC)
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ChoiceButton({
  icon,
  label,
  description,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group flex items-start gap-3 rounded-sm border border-border-default bg-bg-base px-3 py-2.5 text-left",
        "transition-colors hover:bg-bg-hover",
      )}
    >
      <span className="mt-0.5 text-text-primary">{icon}</span>
      <span className="flex-1 min-w-0">
        <span className="block text-xs font-medium text-text-primary">{label}</span>
        <span className="mt-0.5 block text-[11px] text-text-secondary">{description}</span>
      </span>
      <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-text-tertiary group-hover:text-text-primary transition-colors" />
    </button>
  );
}
