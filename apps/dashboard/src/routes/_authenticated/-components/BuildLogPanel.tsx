/**
 * Per-deployment build-log viewer.
 *
 * Loads on-demand (not on page render) because Most deployments won't
 * have their log opened. Fetches once per open, groups by step for an
 * at-a-glance timeline, surfaces CK-* codes on failure, and exposes a
 * raw ndjson toggle for anyone who wants the full stream.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useMemo, useState } from "react";

type Step =
  | "clone"
  | "detect"
  | "install"
  | "build"
  | "bundle"
  | "upload"
  | "provision"
  | "activate"
  | "cleanup";

interface LogLine {
  ts: number;
  step: Step;
  stream: "stdout" | "stderr" | "creek";
  level: "debug" | "info" | "warn" | "error" | "fatal";
  msg: string;
  code?: string;
}

interface LogMetadata {
  deploymentId: string;
  status: "running" | "success" | "failed";
  startedAt: number;
  endedAt: number | null;
  bytes: number;
  lines: number;
  truncated: boolean;
  errorCode: string | null;
  errorStep: string | null;
  r2Key: string;
}

interface LogResponse {
  entries: LogLine[];
  metadata: LogMetadata | null;
  message?: string;
}

const STEP_ORDER: Step[] = [
  "clone",
  "detect",
  "install",
  "build",
  "bundle",
  "upload",
  "provision",
  "activate",
  "cleanup",
];

type LevelFilter = "all" | "warn-up" | "error-only";
type Level = LogLine["level"];

const LEVEL_RANK: Record<Level, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

export function BuildLogPanel({
  projectId,
  deploymentId,
}: {
  projectId: string;
  deploymentId: string;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const [levelFilter, setLevelFilter] = useState<LevelFilter>("all");
  const [hiddenSteps, setHiddenSteps] = useState<Set<Step>>(new Set());
  const [search, setSearch] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["build-log", projectId, deploymentId],
    queryFn: () =>
      api<LogResponse>(`/projects/${projectId}/deployments/${deploymentId}/logs`),
  });

  const filteredEntries = useMemo(() => {
    if (!data?.entries) return [] as LogLine[];
    const needle = search.trim().toLowerCase();
    const levelMin =
      levelFilter === "error-only" ? LEVEL_RANK.error :
      levelFilter === "warn-up" ? LEVEL_RANK.warn :
      0;
    return data.entries.filter((e) => {
      if (hiddenSteps.has(e.step)) return false;
      if (LEVEL_RANK[e.level] < levelMin) return false;
      if (needle && !e.msg.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [data?.entries, hiddenSteps, levelFilter, search]);

  if (isLoading) {
    return (
      <div className="mt-3 rounded border border-border bg-background/40 p-3 text-xs text-muted-foreground">
        Loading build log…
      </div>
    );
  }

  if (error) {
    return (
      <div className="mt-3 rounded border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
        Failed to load build log: {(error as Error).message}
      </div>
    );
  }

  if (!data?.metadata) {
    return (
      <div className="mt-3 rounded border border-border bg-background/40 p-3 text-xs text-muted-foreground">
        {data?.message ?? "No build log available."}
      </div>
    );
  }

  const meta = data.metadata;
  // Step timeline uses filtered entries but keeps step-status intact
  // (based on full data — filtering shouldn't turn a failed step green).
  const byStepFiltered = groupByStep(filteredEntries);
  const byStepAll = groupByStep(data.entries);
  const allSteps = STEP_ORDER.filter((s) => byStepAll.has(s));
  const filterActive =
    levelFilter !== "all" || hiddenSteps.size > 0 || search.trim().length > 0;

  function toggleStep(step: Step): void {
    setHiddenSteps((prev) => {
      const next = new Set(prev);
      if (next.has(step)) next.delete(step);
      else next.add(step);
      return next;
    });
  }

  function clearFilters(): void {
    setLevelFilter("all");
    setHiddenSteps(new Set());
    setSearch("");
  }

  return (
    <div className="mt-3 rounded border border-border bg-background/40">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <div className="flex items-center gap-0.5 rounded border border-border p-0.5">
          {(["all", "warn-up", "error-only"] as const).map((level) => (
            <button
              key={level}
              type="button"
              onClick={() => setLevelFilter(level)}
              className={`rounded px-1.5 py-0.5 font-mono ${
                levelFilter === level
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {level === "all" ? "all" : level === "warn-up" ? "warn+" : "err"}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-0.5 rounded border border-border p-0.5">
          {allSteps.map((step) => {
            const hidden = hiddenSteps.has(step);
            return (
              <button
                key={step}
                type="button"
                onClick={() => toggleStep(step)}
                className={`rounded px-1.5 py-0.5 font-mono ${
                  hidden
                    ? "text-muted-foreground/40 line-through"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                title={hidden ? `Show ${step}` : `Hide ${step}`}
              >
                {step}
              </button>
            );
          })}
        </div>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="search in log…"
          className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-foreground"
        />
        {filterActive && (
          <button
            type="button"
            onClick={clearFilters}
            className="text-muted-foreground hover:text-foreground"
          >
            clear
          </button>
        )}
      </div>

      {/* Step timeline */}
      <ul className="divide-y divide-border">
        {allSteps.map((step) => {
          const allLines = byStepAll.get(step)!;
          const visibleLines = byStepFiltered.get(step) ?? [];
          const info = stepStatus(allLines, meta, step);
          // If filters hide everything in this step, keep the row so
          // the user sees the step exists — just empty. Shows "no
          // matches" visually via the expanded body.
          return (
            <StepRow
              key={step}
              step={step}
              lines={visibleLines}
              allLinesCount={allLines.length}
              status={info.status}
              duration={info.duration}
              errorCode={info.errorCode}
              filterActive={filterActive}
            />
          );
        })}
      </ul>

      {/* Metadata footer */}
      <div className="flex flex-wrap items-center gap-3 border-t border-border px-3 py-2 text-xs text-muted-foreground">
        <span>
          {filterActive
            ? `${filteredEntries.length} / ${data.entries.length} lines`
            : `${data.entries.length} lines`}{" "}
          · {formatBytes(meta.bytes)} compressed
        </span>
        {meta.truncated && (
          <span className="text-amber-400">truncated</span>
        )}
        {meta.errorCode && (
          <span className="font-mono text-destructive">{meta.errorCode}</span>
        )}
        <button
          type="button"
          onClick={() => setShowRaw((v) => !v)}
          className="ml-auto underline hover:text-foreground"
        >
          {showRaw ? "Hide raw log" : "View raw log"}
        </button>
      </div>

      {showRaw && (
        <pre className="max-h-96 overflow-auto border-t border-border bg-code-bg px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground/80">
          {(filterActive ? filteredEntries : data.entries)
            .map((l) => `${formatTs(l.ts)} [${l.step}] ${l.level.toUpperCase()} ${l.msg}`)
            .join("\n")}
        </pre>
      )}
    </div>
  );
}

function StepRow({
  step,
  lines,
  allLinesCount,
  status,
  duration,
  errorCode,
  filterActive,
}: {
  step: Step;
  lines: LogLine[];
  allLinesCount: number;
  status: "success" | "failed" | "running" | "unknown";
  duration: number | null;
  errorCode: string | null;
  filterActive: boolean;
}) {
  const [expanded, setExpanded] = useState(status === "failed");
  const hiddenByFilter = filterActive && lines.length === 0 && allLinesCount > 0;

  const statusIcon =
    status === "success" ? (
      <span className="text-green-400">✓</span>
    ) : status === "failed" ? (
      <span className="text-destructive">✗</span>
    ) : status === "running" ? (
      <span className="text-blue-400">·</span>
    ) : (
      <span className="text-muted-foreground">·</span>
    );

  // Pull out interesting lines for a collapsed preview: errors + last N.
  const interesting = lines.filter((l) => l.level === "error" || l.level === "fatal");
  const preview = interesting.length > 0 ? interesting.slice(-3) : lines.slice(-2);

  return (
    <li className="text-xs">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-background/60"
      >
        <span className="w-4 text-center">{statusIcon}</span>
        <span className="flex-1 font-mono">{step}</span>
        {errorCode && (
          <span className="rounded border border-destructive/30 bg-destructive/5 px-1.5 py-0.5 font-mono text-destructive">
            {errorCode}
          </span>
        )}
        {duration !== null && (
          <span className="tabular-nums text-muted-foreground">
            {formatDuration(duration)}
          </span>
        )}
        <span className="text-muted-foreground">{expanded ? "−" : "+"}</span>
      </button>
      {expanded && (
        <div className="border-t border-border bg-code-bg/60 px-3 py-2 font-mono">
          {hiddenByFilter ? (
            <div className="text-muted-foreground italic">
              {allLinesCount} line{allLinesCount === 1 ? "" : "s"} hidden by filters
            </div>
          ) : (
            (expanded ? lines : preview).map((l, i) => (
            <div
              key={i}
              className={`whitespace-pre-wrap break-words ${
                l.level === "error" || l.level === "fatal"
                  ? "text-destructive"
                  : l.level === "warn"
                    ? "text-amber-400"
                    : "text-foreground/80"
              }`}
            >
              {l.msg}
            </div>
          )))}
        </div>
      )}
    </li>
  );
}

function groupByStep(entries: LogLine[]): Map<Step, LogLine[]> {
  const map = new Map<Step, LogLine[]>();
  for (const e of entries) {
    let bucket = map.get(e.step);
    if (!bucket) {
      bucket = [];
      map.set(e.step, bucket);
    }
    bucket.push(e);
  }
  return map;
}

function stepStatus(
  lines: LogLine[],
  meta: LogMetadata,
  step: Step,
): { status: "success" | "failed" | "running" | "unknown"; duration: number | null; errorCode: string | null } {
  const hasFatal = lines.some((l) => l.level === "fatal");
  const hasError = lines.some((l) => l.level === "error");

  const ts = lines.map((l) => l.ts).sort((a, b) => a - b);
  const duration = ts.length >= 2 ? ts[ts.length - 1] - ts[0] : null;

  const isThisFailingStep = meta.status === "failed" && meta.errorStep === step;
  if (isThisFailingStep || hasFatal) {
    return {
      status: "failed",
      duration,
      errorCode: isThisFailingStep ? meta.errorCode : null,
    };
  }
  if (hasError) {
    // Error line but not the failing step — probably recovered.
    return { status: "success", duration, errorCode: null };
  }
  if (meta.status === "running") {
    return { status: "running", duration, errorCode: null };
  }
  return { status: "success", duration, errorCode: null };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function formatTs(ms: number): string {
  const d = new Date(ms);
  return d.toISOString().slice(11, 23);
}
