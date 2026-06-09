import { cn } from "@/lib/utils";
import { AlertTriangle, ShieldAlert, ShieldCheck, FileWarning } from "lucide-react";
import type { ReviewVerdict } from "../lib/review-api";

interface Props {
  verdict: ReviewVerdict;
  omittedFiles: string[];
  /** Open the issue's file (repo-relative path) at an optional 1-based line. */
  onOpenIssue: (relativeFile: string, line?: number) => void;
}

/** Render a structured verdict as a stack of cards. */
export function VerdictCards({ verdict, omittedFiles, onOpenIssue }: Props) {
  const hasSecurity =
    verdict.security_concerns &&
    verdict.security_concerns.trim().toLowerCase() !== "no";

  return (
    <div className="flex flex-col gap-2 p-2 text-[11px]">
      {/* Summary */}
      {verdict.summary && (
        <div className="rounded border border-border-default bg-bg-selected/40 p-2 text-text-secondary leading-relaxed">
          {verdict.summary}
        </div>
      )}

      {/* Badges */}
      <div className="flex flex-wrap gap-1.5">
        {typeof verdict.score === "number" && (
          <Badge label="Score" value={`${verdict.score}/100`} tone={scoreTone(verdict.score)} />
        )}
        {typeof verdict.estimated_effort_to_review === "number" && (
          <Badge label="Effort" value={`${verdict.estimated_effort_to_review}/5`} />
        )}
        <Badge
          label="Tests"
          value={isYes(verdict.relevant_tests) ? "yes" : "no"}
          tone={isYes(verdict.relevant_tests) ? "good" : "warn"}
        />
      </div>

      {/* Security */}
      <div
        className={cn(
          "rounded border p-2 flex gap-1.5",
          hasSecurity
            ? "border-red-500/40 bg-red-500/10 text-red-300"
            : "border-border-default bg-bg-selected/20 text-text-tertiary",
        )}
      >
        {hasSecurity ? (
          <ShieldAlert size={13} className="mt-0.5 shrink-0" />
        ) : (
          <ShieldCheck size={13} className="mt-0.5 shrink-0" />
        )}
        <div>
          <div className="font-medium text-text-secondary">Security</div>
          <div className="mt-0.5">
            {hasSecurity ? verdict.security_concerns : "No concerns flagged."}
          </div>
        </div>
      </div>

      {/* Key issues */}
      <div className="flex items-center justify-between mt-1">
        <span className="text-text-tertiary uppercase tracking-wide text-[10px]">
          Key Issues
        </span>
        <span className="text-text-tertiary">{verdict.key_issues.length}</span>
      </div>
      {verdict.key_issues.length === 0 ? (
        <div className="rounded border border-border-default bg-bg-selected/20 p-2 text-text-tertiary">
          No actionable issues found.
        </div>
      ) : (
        verdict.key_issues.map((issue, i) => (
          <button
            key={i}
            onClick={() =>
              issue.relevant_file &&
              onOpenIssue(issue.relevant_file, issue.start_line ?? undefined)
            }
            className="text-left rounded border border-border-default bg-bg-selected/20 p-2 hover:bg-bg-hover transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-1.5">
              <AlertTriangle size={12} className="text-amber-400 shrink-0" />
              <span className="font-medium text-text-primary">{issue.issue_header}</span>
            </div>
            {issue.relevant_file && (
              <div className="mt-0.5 font-mono text-[10px] text-text-tertiary truncate">
                {issue.relevant_file}
                {typeof issue.start_line === "number" ? `:${issue.start_line}` : ""}
              </div>
            )}
            <div className="mt-1 text-text-secondary leading-relaxed">
              {issue.issue_content}
            </div>
          </button>
        ))
      )}

      {/* Omitted files (diff was compressed) */}
      {omittedFiles.length > 0 && (
        <div className="rounded border border-border-default bg-bg-selected/20 p-2 text-text-tertiary flex gap-1.5">
          <FileWarning size={12} className="mt-0.5 shrink-0" />
          <div>
            <div className="text-text-secondary">
              {omittedFiles.length} file{omittedFiles.length > 1 ? "s" : ""} omitted (diff too large)
            </div>
            <div className="mt-0.5 font-mono text-[10px] break-all">
              {omittedFiles.join(", ")}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Badge({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "good" | "warn";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 border",
        tone === "good" && "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
        tone === "warn" && "border-amber-500/40 bg-amber-500/10 text-amber-300",
        tone === "neutral" && "border-border-default bg-bg-selected/40 text-text-secondary",
      )}
    >
      <span className="text-text-tertiary">{label}</span>
      <span className="font-medium">{value}</span>
    </span>
  );
}

function isYes(s: string): boolean {
  return s.trim().toLowerCase() === "yes";
}

function scoreTone(score: number): "good" | "warn" | "neutral" {
  if (score >= 80) return "good";
  if (score < 50) return "warn";
  return "neutral";
}
