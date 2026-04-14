/**
 * Types shared between build-log producers and the control-plane API.
 * Mirror in the CLI and remote-builder when they start emitting these.
 */

export type BuildLogStep =
  | "clone"
  | "detect"
  | "install"
  | "build"
  | "bundle"
  | "upload"
  | "provision"
  | "activate"
  | "cleanup";

export type BuildLogStream = "stdout" | "stderr" | "creek";

export type BuildLogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export interface BuildLogLine {
  /** ms epoch */
  ts: number;
  step: BuildLogStep;
  stream: BuildLogStream;
  level: BuildLogLevel;
  msg: string;
  /** Optional diagnostic code (CK-BUILD-*, CK-PROVISION-*) */
  code?: string;
}

export type BuildLogStatus = "running" | "success" | "failed";

export interface BuildLogMetadata {
  deploymentId: string;
  status: BuildLogStatus;
  startedAt: number;
  endedAt: number | null;
  bytes: number;
  lines: number;
  truncated: boolean;
  errorCode: string | null;
  errorStep: string | null;
  r2Key: string;
}

/** Upper bound before we truncate. Keep pre-compression size; gzip
 *  brings this to ~1MB on the wire which is a single R2 PUT. */
export const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** Upper bound on total lines regardless of byte count — defends against
 *  degenerate inputs like billions of empty lines. */
export const MAX_LOG_LINES = 200_000;
