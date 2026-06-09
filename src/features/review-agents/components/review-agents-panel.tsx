import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { cn } from "@/lib/utils";
import { openFile } from "@/lib/open-file";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useReviewStore } from "../stores/review-store";
import { VerdictCards } from "./verdict-cards";
import { Combobox, type ComboOption } from "./combobox";
import { providerById } from "@/features/settings/lib/providers";
import { ProviderLogo } from "@/components/provider-logo";
import type { ReviewRecord, ReviewSource } from "../lib/review-api";
import { Play, Square, Loader2, CheckCheck, ChevronLeft, KeyRound } from "lucide-react";

interface GitLogEntry {
  hash: string;
  short_hash: string;
  message: string;
  author: string;
  date: string;
}

type SourceMode = "working" | "staged" | "commit";

export function ReviewAgentsPanel() {
  const project = useProjectStore.use.currentProject();
  const projectPath = project?.path ?? null;

  const providers = useReviewStore.use.providers();
  const providersLoaded = useReviewStore.use.providersLoaded();
  const selectedProvider = useReviewStore.use.selectedProvider();
  const models = useReviewStore.use.models();
  const loadingModels = useReviewStore.use.loadingModels();
  const selectedModel = useReviewStore.use.selectedModel();
  const records = useReviewStore.use.records();
  const selectedRecord = useReviewStore.use.selectedRecord();
  const streaming = useReviewStore.use.streaming();
  const streamText = useReviewStore.use.streamText();
  const streamError = useReviewStore.use.streamError();
  const pendingSource = useReviewStore.use.pendingSource();
  const actions = useReviewStore.use.actions();

  const [mode, setMode] = useState<SourceMode>("working");
  const [commits, setCommits] = useState<GitLogEntry[]>([]);
  const [commitSha, setCommitSha] = useState<string | null>(null);

  // Load providers + records when the project becomes available.
  useEffect(() => {
    if (projectPath) void actions.init(projectPath);
  }, [projectPath, actions]);

  // Apply a source preset requested from elsewhere (Source Control), then clear
  // it so a back/forth to the panel doesn't re-apply a stale request.
  useEffect(() => {
    if (!pendingSource) return;
    setMode(pendingSource.mode);
    if (pendingSource.mode === "commit" && pendingSource.sha) {
      setCommitSha(pendingSource.sha);
      setCommits((prev) =>
        prev.some((c) => c.hash === pendingSource.sha)
          ? prev
          : [
              {
                hash: pendingSource.sha!,
                short_hash: pendingSource.sha!.slice(0, 7),
                message: "(selected commit)",
                author: "",
                date: "",
              },
              ...prev,
            ],
      );
    }
    actions.consumePending();
  }, [pendingSource, actions]);

  // Fetch recent commits the first time the user switches to "commit" mode.
  useEffect(() => {
    if (mode !== "commit" || !projectPath || commits.length > 0) return;
    void invoke<GitLogEntry[]>("git_log", { path: projectPath, limit: 50 })
      .then((c) => {
        setCommits(c);
        if (c.length > 0) setCommitSha((s) => s ?? c[0].hash);
      })
      .catch(() => setCommits([]));
  }, [mode, projectPath, commits.length]);

  // Keep the store's source in sync with the local picker.
  useEffect(() => {
    const source: ReviewSource =
      mode === "working"
        ? { type: "working" }
        : mode === "staged"
          ? { type: "staged" }
          : { type: "commit", sha: commitSha ?? "" };
    actions.setSource(source);
  }, [mode, commitSha, actions]);

  const providerOptions: ComboOption[] = useMemo(
    () =>
      providers.map((p) => ({
        value: p,
        label: providerById(p)?.name ?? p,
        icon: <ProviderLogo id={p} size={14} />,
      })),
    [providers],
  );
  const modelOptions: ComboOption[] = useMemo(
    () => models.map((m) => ({ value: m, label: m })),
    [models],
  );
  const commitOptions: ComboOption[] = useMemo(
    () =>
      commits.map((c) => ({
        value: c.hash,
        label: c.message,
        hint: `${c.short_hash}${c.author ? ` · ${c.author}` : ""}`,
      })),
    [commits],
  );

  const onOpenIssue = (relativeFile: string) => {
    if (!projectPath) return;
    const full = relativeFile.startsWith("/")
      ? relativeFile
      : `${projectPath}/${relativeFile}`;
    openFile(full);
  };

  const canRun =
    !!projectPath &&
    !!selectedProvider &&
    !!selectedModel &&
    !streaming &&
    (mode !== "commit" || !!commitSha);

  if (!projectPath) {
    return <Empty label="Open a project to review changes." />;
  }

  return (
    <div className="h-full flex flex-col bg-[#0D0E0D] text-[11px]">
      {/* Controls */}
      <div className="border-b border-border-default p-2 flex flex-col gap-2 shrink-0">
        {/* Source segmented control */}
        <div className="flex gap-0.5">
          {(["working", "staged", "commit"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              disabled={streaming}
              className={cn(
                "flex-1 px-2 py-1 rounded capitalize transition-colors cursor-pointer disabled:opacity-50",
                mode === m
                  ? "bg-bg-selected text-text-primary"
                  : "text-text-tertiary hover:text-text-secondary hover:bg-bg-hover",
              )}
            >
              {m === "working" ? "Working" : m === "staged" ? "Staged" : "Commit"}
            </button>
          ))}
        </div>

        {mode === "commit" && (
          <Combobox
            value={commitSha}
            options={commitOptions}
            onChange={setCommitSha}
            placeholder="Select a commit"
            emptyLabel="No commits"
            disabled={streaming}
          />
        )}

        {/* Provider + model */}
        {providersLoaded && providers.length === 0 ? (
          <div className="flex items-start gap-1.5 text-text-tertiary rounded border border-border-default bg-bg-selected/20 p-2">
            <KeyRound size={12} className="mt-0.5 shrink-0" />
            <span>
              No API keys configured. Add one in Settings → API keys to run reviews.
            </span>
          </div>
        ) : (
          <div className="flex gap-1.5">
            <Combobox
              value={selectedProvider}
              options={providerOptions}
              onChange={(v) => void actions.setProvider(v)}
              placeholder="Provider"
              disabled={streaming || providers.length === 0}
              className="flex-1"
            />
            <Combobox
              value={selectedModel}
              options={modelOptions}
              onChange={(v) => actions.setModel(v)}
              placeholder="Model"
              emptyLabel={loadingModels ? "Loading…" : "No models"}
              disabled={streaming || loadingModels || models.length === 0}
              className="flex-1"
            />
          </div>
        )}

        {/* Run / Cancel */}
        {streaming ? (
          <button
            onClick={() => actions.cancel()}
            className="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded bg-red-500/15 text-red-300 hover:bg-red-500/25 transition-colors cursor-pointer"
          >
            <Square size={12} /> Cancel review
          </button>
        ) : (
          <button
            onClick={() => projectPath && void actions.start(projectPath)}
            disabled={!canRun}
            className="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded bg-bg-selected text-text-primary hover:bg-bg-hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default"
          >
            <Play size={12} /> Review
          </button>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-auto hide-scrollbar">
        {streaming ? (
          <Streaming text={streamText} />
        ) : streamError ? (
          <div className="m-2 rounded border border-red-500/40 bg-red-500/10 p-2 text-red-300">
            {streamError}
          </div>
        ) : selectedRecord ? (
          <RecordView
            record={selectedRecord}
            onOpenIssue={onOpenIssue}
            onBack={records.length > 0 ? () => actions.selectRecord(null) : undefined}
          />
        ) : (
          <RecordList records={records} onPick={(r) => actions.selectRecord(r)} />
        )}
      </div>
    </div>
  );
}

function Streaming({ text }: { text: string }) {
  return (
    <div className="p-2">
      <div className="flex items-center gap-1.5 text-text-tertiary mb-2">
        <Loader2 size={12} className="animate-spin" /> Reviewing…
      </div>
      <pre className="whitespace-pre-wrap break-words font-mono text-[10.5px] text-text-secondary leading-relaxed">
        {text || "Waiting for the model…"}
      </pre>
    </div>
  );
}

function RecordView({
  record,
  onOpenIssue,
  onBack,
}: {
  record: ReviewRecord;
  onOpenIssue: (file: string, line?: number) => void;
  onBack?: () => void;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border-default text-text-tertiary">
        {onBack && (
          <button
            onClick={onBack}
            className="flex items-center gap-0.5 hover:text-text-secondary cursor-pointer"
          >
            <ChevronLeft size={12} /> Back
          </button>
        )}
        <span className="truncate ml-auto text-[10px]">{record.title}</span>
      </div>
      {record.verdict ? (
        <VerdictCards
          verdict={record.verdict}
          omittedFiles={record.omittedFiles}
          onOpenIssue={onOpenIssue}
        />
      ) : (
        // Parsing failed — show the raw model output so the review isn't lost.
        <pre className="whitespace-pre-wrap break-words font-mono text-[10.5px] text-text-secondary leading-relaxed p-2">
          {record.rawText || "No output."}
        </pre>
      )}
    </div>
  );
}

function RecordList({
  records,
  onPick,
}: {
  records: ReviewRecord[];
  onPick: (r: ReviewRecord) => void;
}) {
  if (records.length === 0) {
    return <Empty label="No reviews yet. Pick a source and run one." />;
  }
  return (
    <div className="flex flex-col">
      {records.map((r) => (
        <button
          key={r.id}
          onClick={() => onPick(r)}
          className="text-left px-2 py-2 border-b border-border-default hover:bg-bg-hover transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-1.5">
            <CheckCheck size={12} className="text-text-tertiary shrink-0" />
            <span className="truncate text-text-primary">{r.title}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[10px] text-text-tertiary">
            <span>{r.model}</span>
            {typeof r.verdict?.score === "number" && <span>· {r.verdict.score}/100</span>}
            {r.verdict && r.verdict.key_issues.length > 0 && (
              <span>· {r.verdict.key_issues.length} issues</span>
            )}
            <span className="ml-auto">{relativeTime(r.createdAt)}</span>
          </div>
        </button>
      ))}
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return (
    <div className="h-full flex items-center justify-center p-4 text-center text-text-tertiary text-[11px]">
      {label}
    </div>
  );
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
