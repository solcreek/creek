-- Resources v2: team-owned resources + project-level bindings.
-- Parallel to the existing project_resource table; migration path in
-- product-planning/creek-resources-v2.md Phase 1.
CREATE TABLE IF NOT EXISTS `resource` (
	`id` text PRIMARY KEY NOT NULL,
	`teamId` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`cfResourceId` text,
	`cfResourceType` text,
	`status` text DEFAULT 'active' NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS `idx_resource_team_name` ON `resource` (`teamId`,`name`);
CREATE INDEX IF NOT EXISTS `idx_resource_team_kind` ON `resource` (`teamId`,`kind`);

CREATE TABLE IF NOT EXISTS `project_resource_binding` (
	`projectId` text NOT NULL,
	`bindingName` text NOT NULL,
	`resourceId` text NOT NULL,
	`createdAt` integer NOT NULL,
	PRIMARY KEY (`projectId`, `bindingName`),
	FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resourceId`) REFERENCES `resource`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE INDEX IF NOT EXISTS `idx_prb_resource` ON `project_resource_binding` (`resourceId`);
