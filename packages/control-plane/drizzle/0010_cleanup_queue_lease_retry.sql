-- Lease and retry for resource_cleanup_queue (solcreek/creek#86).
-- attempts: delete attempts so far; a retryable failure goes back to
--   pending until the limit, then failed.
-- claimedAt: when the current claim was taken (seconds). A cleaning row
--   whose claim is older than the lease is reclaimed, so a run cut off
--   mid-row doesn't strand it.
-- nextAttemptAt: earliest time (seconds) a retried row may be claimed again.
-- Additive: code that predates these columns keeps working.
ALTER TABLE resource_cleanup_queue ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE resource_cleanup_queue ADD COLUMN claimedAt INTEGER;
ALTER TABLE resource_cleanup_queue ADD COLUMN nextAttemptAt INTEGER;
