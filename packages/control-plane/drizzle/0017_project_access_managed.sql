-- Access applications Creek created for a project, in the team's own
-- Cloudflare account, through its "Connect Cloudflare" grant.
--
-- JSON: { accountId, appId, bypassAppId, emails, emailDomains, teamMembers }.
-- NULL: Creek manages nothing for this project (unprotected, or protected by an
-- application the customer made and registered with PUT /projects/:id/access).
--
-- The dispatch worker never reads it: it enforces accessTeamDomain/accessAud
-- (0016) either way. This column is how Creek finds the applications again to
-- update or delete them.
ALTER TABLE project ADD COLUMN `accessManaged` text;

-- A lease (epoch ms) held while a request changes the project's Access
-- settings, so two changes never interleave their Cloudflare calls and D1
-- writes. NULL or past: free.
ALTER TABLE project ADD COLUMN `accessLockedUntil` integer;
