CREATE TABLE `github_connection` (
	`id` text PRIMARY KEY NOT NULL,
	`projectId` text NOT NULL,
	`installationId` integer NOT NULL,
	`repoOwner` text NOT NULL,
	`repoName` text NOT NULL,
	`productionBranch` text DEFAULT 'main' NOT NULL,
	`autoDeployEnabled` integer DEFAULT true NOT NULL,
	`previewEnabled` integer DEFAULT true NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_github_connection_project` ON `github_connection` (`projectId`);--> statement-breakpoint
CREATE INDEX `idx_github_connection_repo` ON `github_connection` (`repoOwner`,`repoName`);--> statement-breakpoint
CREATE TABLE `github_installation` (
	`id` integer PRIMARY KEY NOT NULL,
	`accountLogin` text NOT NULL,
	`accountType` text NOT NULL,
	`organizationId` text,
	`appId` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `repo_scan` (
	`repoOwner` text NOT NULL,
	`repoName` text NOT NULL,
	`installationId` integer NOT NULL,
	`framework` text,
	`configType` text,
	`bindings` text,
	`envHints` text,
	`deployable` integer DEFAULT false NOT NULL,
	`scannedAt` integer NOT NULL,
	PRIMARY KEY(`repoOwner`, `repoName`)
);
