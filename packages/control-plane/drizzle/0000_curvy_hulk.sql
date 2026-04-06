CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`accountId` text NOT NULL,
	`providerId` text NOT NULL,
	`accessToken` text,
	`refreshToken` text,
	`accessTokenExpiresAt` integer,
	`refreshTokenExpiresAt` integer,
	`scope` text,
	`idToken` text,
	`password` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `apikey` (
	`id` text PRIMARY KEY NOT NULL,
	`configId` text DEFAULT 'default' NOT NULL,
	`name` text,
	`start` text,
	`prefix` text,
	`key` text NOT NULL,
	`referenceId` text NOT NULL,
	`refillInterval` integer,
	`refillAmount` integer,
	`lastRefillAt` integer,
	`enabled` integer DEFAULT true,
	`rateLimitEnabled` integer,
	`rateLimitTimeWindow` integer,
	`rateLimitMax` integer,
	`requestCount` integer,
	`remaining` integer,
	`lastRequest` integer,
	`expiresAt` integer,
	`permissions` text,
	`metadata` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `custom_domain` (
	`id` text PRIMARY KEY NOT NULL,
	`projectId` text NOT NULL,
	`hostname` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `custom_domain_hostname_unique` ON `custom_domain` (`hostname`);--> statement-breakpoint
CREATE INDEX `idx_custom_domain_project` ON `custom_domain` (`projectId`);--> statement-breakpoint
CREATE TABLE `deployment` (
	`id` text PRIMARY KEY NOT NULL,
	`projectId` text NOT NULL,
	`version` integer NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`branch` text,
	`commitSha` text,
	`commitMessage` text,
	`triggerType` text DEFAULT 'cli' NOT NULL,
	`failedStep` text,
	`errorMessage` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_deployment_project` ON `deployment` (`projectId`);--> statement-breakpoint
CREATE INDEX `idx_deployment_branch` ON `deployment` (`projectId`,`branch`);--> statement-breakpoint
CREATE TABLE `environment_variable` (
	`projectId` text NOT NULL,
	`key` text NOT NULL,
	`encryptedValue` text NOT NULL,
	PRIMARY KEY(`projectId`, `key`),
	FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `invitation` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`inviterId` text NOT NULL,
	`organizationId` text NOT NULL,
	`role` text,
	`status` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`createdAt` integer,
	FOREIGN KEY (`inviterId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `member` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`organizationId` text NOT NULL,
	`role` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `organization` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`logo` text,
	`metadata` text,
	`plan` text DEFAULT 'free' NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_slug_unique` ON `organization` (`slug`);--> statement-breakpoint
CREATE TABLE `project` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`organizationId` text NOT NULL,
	`productionDeploymentId` text,
	`productionBranch` text DEFAULT 'main' NOT NULL,
	`framework` text,
	`githubRepo` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_org_slug` ON `project` (`organizationId`,`slug`);--> statement-breakpoint
CREATE TABLE `project_resource` (
	`projectId` text NOT NULL,
	`resourceType` text NOT NULL,
	`cfResourceId` text NOT NULL,
	`cfResourceName` text NOT NULL,
	`status` text DEFAULT 'provisioning' NOT NULL,
	`createdAt` integer NOT NULL,
	PRIMARY KEY(`projectId`, `resourceType`),
	FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `resource_cleanup_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`resourceType` text NOT NULL,
	`cfResourceId` text NOT NULL,
	`cfResourceName` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reason` text,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_cleanup_status` ON `resource_cleanup_queue` (`status`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`token` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`ipAddress` text,
	`userAgent` text,
	`impersonatedBy` text,
	`activeOrganizationId` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`emailVerified` integer DEFAULT false NOT NULL,
	`image` text,
	`role` text DEFAULT 'user',
	`banned` integer,
	`banReason` text,
	`banExpires` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`createdAt` integer,
	`updatedAt` integer
);
