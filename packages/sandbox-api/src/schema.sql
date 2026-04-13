CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  templateId TEXT,
  framework TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  previewHost TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL DEFAULT 'cli',
  environment TEXT NOT NULL DEFAULT 'sandbox',
  trigger_type TEXT NOT NULL DEFAULT 'web',
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
  contentHash TEXT,
  -- JSON blob recording CF resources we provisioned for this sandbox
  -- so cleanup.ts can delete them when the sandbox expires.
  -- Shape: { "d1": [{"name","id"}], "r2": [{"name"}], "kv": [{"id","title"}] }
  provisionedResources TEXT
);

-- Stores raw IPs temporarily for legal compliance (30-day retention).
CREATE TABLE IF NOT EXISTS sandbox_ip_log (
  sandboxId TEXT NOT NULL,
  rawIp TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ip_log_created ON sandbox_ip_log(createdAt);

CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);
CREATE INDEX IF NOT EXISTS idx_deployments_expires ON deployments(expiresAt);
CREATE INDEX IF NOT EXISTS idx_deployments_ip ON deployments(ipHash);
CREATE INDEX IF NOT EXISTS idx_deployments_env ON deployments(environment);

CREATE TABLE IF NOT EXISTS sandbox_abuse_report (
  id TEXT PRIMARY KEY,
  sandboxId TEXT NOT NULL,
  reason TEXT NOT NULL,
  ipHash TEXT,
  createdAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_abuse_sandbox ON sandbox_abuse_report(sandboxId);
