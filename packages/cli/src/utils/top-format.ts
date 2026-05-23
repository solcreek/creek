export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return bytes + "B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + "K";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + "M";
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + "G";
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m" + (s % 60 > 0 ? (s % 60) + "s" : "");
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h" + (m % 60 > 0 ? (m % 60) + "m" : "");
  const d = Math.floor(h / 24);
  return d + "d" + (h % 24 > 0 ? (h % 24) + "h" : "");
}

export function calcCpuPercent(
  prevUsec: number,
  prevTs: number,
  currUsec: number,
  currTs: number,
): number | null {
  const dtMs = currTs - prevTs;
  if (dtMs <= 0) return null;
  const dtUs = currUsec - prevUsec;
  return (dtUs / 1000 / dtMs) * 100;
}
