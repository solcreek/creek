-- Build log metadata. Log bodies live in R2 under `builds/{team}/{project}/{deployId}.ndjson.gz`;
-- this table only stores status / size / retention pointers.
CREATE TABLE IF NOT EXISTS `build_log` (
	`deploymentId` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`startedAt` integer NOT NULL,
	`endedAt` integer,
	`bytes` integer DEFAULT 0 NOT NULL,
	`lines` integer DEFAULT 0 NOT NULL,
	`truncated` integer DEFAULT 0 NOT NULL,
	`errorCode` text,
	`errorStep` text,
	`r2Key` text NOT NULL,
	FOREIGN KEY (`deploymentId`) REFERENCES `deployment`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE INDEX IF NOT EXISTS `idx_build_log_status` ON `build_log` (`status`,`startedAt`);
