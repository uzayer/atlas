import { fmtClock } from "../lib/format";

interface Props {
  secElapsed: number;
  totalSec: number;
  label: string;
  recording: boolean;
}

export function TimerRing({ secElapsed, totalSec, label, recording }: Props) {
  const r = 88;
  const c = 2 * Math.PI * r;
  const pct = Math.min(1, secElapsed / Math.max(1, totalSec));
  const remain = Math.max(0, totalSec - secElapsed);

  return (
    <div className="relative w-[200px] h-[200px] flex items-center justify-center">
      <svg width="200" height="200" className="absolute inset-0 -rotate-90">
        <circle
          cx="100"
          cy="100"
          r={r}
          fill="none"
          stroke="var(--border-default)"
          strokeWidth="3"
        />
        <circle
          cx="100"
          cy="100"
          r={r}
          fill="none"
          stroke="var(--text-primary)"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct)}
          style={{ transition: "stroke-dashoffset 1s linear" }}
        />
      </svg>
      <div className="relative flex flex-col items-center gap-1">
        {recording && (
          <div className="flex items-center gap-1 text-[9.5px] font-mono uppercase tracking-wider text-[var(--status-error)]">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--status-error)] animate-pulse" />
            REC
          </div>
        )}
        <div
          className="font-mono font-semibold text-text-primary tabular-nums"
          style={{ fontSize: 44, letterSpacing: "-0.02em", lineHeight: 1 }}
        >
          {fmtClock(remain)}
        </div>
        <div className="text-[10px] font-mono uppercase tracking-wider text-text-tertiary mt-1">
          {label}
        </div>
      </div>
    </div>
  );
}
