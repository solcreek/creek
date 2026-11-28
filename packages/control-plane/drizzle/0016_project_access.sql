-- Cloudflare Access protection for a project.
--
-- The customer puts their own domain behind an Access application in their own
-- Cloudflare account. Access then hands every request it lets through a JWT
-- (Cf-Access-Jwt-Assertion) signed by the team's keys. With these columns set,
-- the dispatch worker serves the project, on every hostname, only to requests
-- whose token comes from accessTeamDomain and names accessAud. That also closes
-- the addresses Access never sees: {project}-{team}.bycreek.com and previews.
--
-- accessTeamDomain  <team>.cloudflareaccess.com (issuer, and host of the keys)
-- accessAud         the Access application's AUD tag (64 hex)
-- accessBypassPaths JSON array of path prefixes the application bypasses
--
-- All NULL: not protected. The dispatch worker reads them with a fallback, so
-- it may deploy before this migration is applied.
ALTER TABLE project ADD COLUMN `accessTeamDomain` text;
ALTER TABLE project ADD COLUMN `accessAud` text;
ALTER TABLE project ADD COLUMN `accessBypassPaths` text;
