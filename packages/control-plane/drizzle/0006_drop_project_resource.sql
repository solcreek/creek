-- Drop the legacy project_resource table.
-- Resources are now team-owned via the `resource` + `project_resource_binding`
-- tables (introduced in 0005). No migration needed — zero existing users.
DROP TABLE IF EXISTS `project_resource`;
