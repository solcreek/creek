/**
 * Build log emitter for the CLI.
 *
 * Accumulates structured ndjson lines during a `creek deploy` run and
 * POSTs them to control-plane once the deployment reaches a terminal
 * state. The content is high-level phase markers — install / build /
 * bundle / upload / activate — not the full stdout of subprocesses.
 * Capturing the user's build stdout is a Phase 2 concern; for now
 * the terminal is still where they see npm output live.
 */

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

type Stream = "stdout" | "stderr" | "creek";
type Level = "debug" | "info" | "warn" | "error" | "fatal";

export interface BuildLogLine {
  ts: number;
  step: Step;
  stream: Stream;
  level: Level;
  msg: string;
  code?: string;
}

export class BuildLogEmitter {
  private lines: BuildLogLine[] = [];
  readonly startedAt = Date.now();

  log(step: Step, level: Level, msg: string, opts?: { stream?: Stream; code?: string }): void {
    this.lines.push({
      ts: Date.now(),
      step,
      stream: opts?.stream ?? "creek",
      level,
      msg,
      ...(opts?.code ? { code: opts.code } : {}),
    });
  }

  info(step: Step, msg: string, code?: string): void {
    this.log(step, "info", msg, { code });
  }

  warn(step: Step, msg: string, code?: string): void {
    this.log(step, "warn", msg, { code });
  }

  error(step: Step, msg: string, code?: string): void {
    this.log(step, "error", msg, { code });
  }

  toNdjson(): string {
    return this.lines.map((l) => JSON.stringify(l)).join("\n");
  }

  get count(): number {
    return this.lines.length;
  }
}

export type FlushOutcome = "sent" | "failed" | "timeout";

/**
 * Wait for a build-log upload to actually reach the server before the CLI
 * exits, but never let a slow or hanging log endpoint block the deploy result.
 *
 * The build log is best-effort, so this swallows upload errors and caps the
 * wait. It exists because firing the upload and then calling `process.exit()`
 * (as the JSON output path does right after) aborts the in-flight request — so
 * a "successful" deploy could otherwise leave no build log at all. Await this
 * before any exit instead of fire-and-forget.
 *
 * Returns "sent" if the upload completed, "failed" if it errored, or "timeout"
 * if we stopped waiting after `capMs` (the upload may still be in flight).
 */
export async function flushBuildLog(upload: Promise<unknown>, capMs = 3000): Promise<FlushOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<FlushOutcome>((resolve) => {
    timer = setTimeout(() => resolve("timeout"), capMs);
  });
  const settled: Promise<FlushOutcome> = upload.then(
    () => "sent",
    () => "failed",
  );
  try {
    return await Promise.race([settled, capped]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
