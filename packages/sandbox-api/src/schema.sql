CREATE TABLE IF NOT EXISTS sandbox (
  id TEXT PRIMARY KEY,
  templateId TEXT,
  framework TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  previewHost TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL DEFAULT 'cli',
  ipHash TEXT,
  failedStep TEXT,
  errorMessage TEXT,
  renderMode TEXT NOT NULL DEFAULT 'spa',
  assetCount INTEGER NOT NULL DEFAULT 0,
  claimStatus TEXT NOT NULL DEFAULT 'unclaimed',
  claimedProjectId TEXT,
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL,
  activatedAt INTEGER,
  cleanedUpAt INTEGER,
  deployDurationMs INTEGER,
  -- Legal / audit metadata
  country TEXT,
  userAgent TEXT,
  tosVersion TEXT,
  tosAcceptedAt TEXT,
  contentHash TEXT
);

-- Stores raw IPs temporarily for legal compliance (30-day retention).
-- Separate table so cleanup is simple: DELETE WHERE createdAt < now - 30 days.
CREATE TABLE IF NOT EXISTS sandbox_ip_log (
  sandboxId TEXT NOT NULL,
  rawIp TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ip_log_created ON sandbox_ip_log(createdAt);

CREATE INDEX IF NOT EXISTS idx_sandbox_status ON sandbox(status);
CREATE INDEX IF NOT EXISTS idx_sandbox_expires ON sandbox(expiresAt);
CREATE INDEX IF NOT EXISTS idx_sandbox_ip ON sandbox(ipHash);

CREATE TABLE IF NOT EXISTS sandbox_abuse_report (
  id TEXT PRIMARY KEY,
  sandboxId TEXT NOT NULL,
  reason TEXT NOT NULL,
  ipHash TEXT,
  createdAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_abuse_sandbox ON sandbox_abuse_report(sandboxId);
