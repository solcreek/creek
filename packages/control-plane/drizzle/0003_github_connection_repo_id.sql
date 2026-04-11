-- Add GitHub's internal repository ID to github_connection so we can
-- survive repo renames + ownership transfers. Populated at connect time
-- and used by the repository.renamed webhook to find the row.
ALTER TABLE `github_connection` ADD COLUMN `repoId` integer;--> statement-breakpoint
CREATE INDEX `idx_github_connection_repo_id` ON `github_connection` (`repoId`);
