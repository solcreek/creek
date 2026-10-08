-- audit_log + audit_ip_log were created out of band in production and never
-- had a migration, so a fresh database (self-host, `wrangler d1 migrations
-- apply --local`) lacked them and recordAudit() failed silently.
-- The DDL matches production as of 2026-10-07 (createdAt INTEGER, epoch ms).
-- IF NOT EXISTS: a no-op where the tables already exist.
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  teamId TEXT NOT NULL,
  userId TEXT NOT NULL,
  userEmail TEXT NOT NULL,
  action TEXT NOT NULL,
  resourceType TEXT NOT NULL,
  resourceId TEXT,
  metadata TEXT,
  ipHash TEXT,
  country TEXT,
  userAgent TEXT,
  cfRay TEXT,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_time ON audit_log(userId, createdAt);
CREATE INDEX IF NOT EXISTS idx_audit_log_team_time ON audit_log(teamId, createdAt);

CREATE TABLE IF NOT EXISTS audit_ip_log (
  auditLogId TEXT NOT NULL,
  rawIp TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_ip_log_created ON audit_ip_log(createdAt);
