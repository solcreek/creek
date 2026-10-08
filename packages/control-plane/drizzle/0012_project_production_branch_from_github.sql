-- project.productionBranch is the production branch for API deploys and for
-- API key scope checks; github_connection.productionBranch is the one GitHub
-- deploys use. POST /github/connect now writes both. Copy the connection's
-- value onto projects connected before that, so the two agree everywhere.
-- (Production had no divergent rows on 2026-10-07; this is for other installs.)
UPDATE project
SET productionBranch = (
  SELECT gc.productionBranch FROM github_connection gc WHERE gc.projectId = project.id
)
WHERE EXISTS (
  SELECT 1 FROM github_connection gc
  WHERE gc.projectId = project.id AND gc.productionBranch != project.productionBranch
);
