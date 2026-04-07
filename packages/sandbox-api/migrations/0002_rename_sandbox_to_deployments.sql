-- Rename sandbox table to deployments for unified naming
ALTER TABLE sandbox RENAME TO deployments;

-- Add unified columns
ALTER TABLE deployments ADD COLUMN environment TEXT NOT NULL DEFAULT 'sandbox';
ALTER TABLE deployments ADD COLUMN trigger_type TEXT NOT NULL DEFAULT 'web';

-- Recreate indexes with new table name
DROP INDEX IF EXISTS idx_sandbox_status;
DROP INDEX IF EXISTS idx_sandbox_expires;
DROP INDEX IF EXISTS idx_sandbox_ip;
CREATE INDEX idx_deployments_status ON deployments(status);
CREATE INDEX idx_deployments_expires ON deployments(expiresAt);
CREATE INDEX idx_deployments_ip ON deployments(ipHash);
CREATE INDEX idx_deployments_env ON deployments(environment);
