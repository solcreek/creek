-- A project's primary custom domain, and whether its default
-- {project}-{team} hostname redirects there.
--
-- custom_domain.isPrimary marks the one domain per project that is its
-- canonical address; the partial unique index holds that to one per project.
-- project.redirectToPrimaryDomain makes the dispatch worker answer the default
-- production hostname with a 308 to that domain once it is active.
--
-- New projects redirect by default. A project that already has a custom domain
-- keeps serving its default hostname as before (redirect off): webhooks and
-- API clients may be calling it. Its oldest active domain becomes the primary
-- (the oldest of any status when none is active), which only marks the
-- default hostname noindex until the redirect is turned on.
ALTER TABLE custom_domain ADD COLUMN `isPrimary` integer NOT NULL DEFAULT 0;
ALTER TABLE project ADD COLUMN `redirectToPrimaryDomain` integer NOT NULL DEFAULT 1;

UPDATE project SET redirectToPrimaryDomain = 0
WHERE id IN (SELECT projectId FROM custom_domain);

UPDATE custom_domain SET isPrimary = 1
WHERE id = (
  SELECT cd.id FROM custom_domain cd
  WHERE cd.projectId = custom_domain.projectId
  ORDER BY (cd.status = 'active') DESC, cd.createdAt ASC, cd.id ASC
  LIMIT 1
);

CREATE UNIQUE INDEX `idx_custom_domain_primary` ON custom_domain (`projectId`) WHERE `isPrimary` = 1;
