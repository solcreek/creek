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
