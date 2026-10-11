-- Environment variables per deploy target. A variable now applies to
-- 'production' deploys, 'preview' (branch) deploys, or 'all'; a key may hold
-- a different value per target (e.g. a live key for production, a test key
-- for previews). A deploy uses its own target's value, else the 'all' value.
--
-- SQLite cannot change a primary key in place, so the table is rebuilt. Every
-- existing variable becomes 'all': deploys get exactly what they got before.
-- No other table references environment_variable.
CREATE TABLE environment_variable_new (
  `projectId` text NOT NULL,
  `key` text NOT NULL,
  `target` text NOT NULL DEFAULT 'all' CHECK (`target` IN ('all', 'production', 'preview')),
  `encryptedValue` text NOT NULL,
  PRIMARY KEY (`projectId`, `key`, `target`),
  FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action
);
INSERT INTO environment_variable_new (`projectId`, `key`, `target`, `encryptedValue`)
  SELECT `projectId`, `key`, 'all', `encryptedValue` FROM environment_variable;
DROP TABLE environment_variable;
ALTER TABLE environment_variable_new RENAME TO environment_variable;
