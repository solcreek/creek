-- Usage metering — daily rollup of AE creek_tenant_requests per
-- team+project. Populated by the metering aggregator cron. Billing
-- and usage dashboards read from here instead of hammering AE on
-- every request.
CREATE TABLE IF NOT EXISTS `usage_daily` (
	`teamSlug` text NOT NULL,
	`projectSlug` text NOT NULL,
	`date` text NOT NULL,
	`requests` integer NOT NULL DEFAULT 0,
	`errors` integer NOT NULL DEFAULT 0,
	`createdAt` integer NOT NULL,
	PRIMARY KEY(`teamSlug`, `projectSlug`, `date`)
);

CREATE INDEX IF NOT EXISTS `idx_usage_daily_date` ON `usage_daily` (`date`);
