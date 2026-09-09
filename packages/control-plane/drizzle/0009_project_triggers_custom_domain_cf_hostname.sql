-- Two columns the control-plane has read and written since spring but that
-- were only ever added by hand: project.triggers (cron/queue trigger config,
-- JSON) and custom_domain.cfCustomHostnameId (Cloudflare for SaaS custom
-- hostname id). Production D1 already has both, so this migration was
-- recorded there as applied without running (d1_migrations row inserted
-- 2026-09-09). Fresh databases built from these migrations now get them too.
ALTER TABLE project ADD COLUMN triggers TEXT;
ALTER TABLE custom_domain ADD COLUMN cfCustomHostnameId TEXT;
