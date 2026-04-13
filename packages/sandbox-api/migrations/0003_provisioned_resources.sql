-- Track CF resources (D1/R2/KV) provisioned per sandbox so cleanup
-- can delete them when the sandbox expires. JSON blob shape:
--   { "d1": [{"name","id"}], "r2": [{"name"}], "kv": [{"id","title"}] }
ALTER TABLE deployments ADD COLUMN provisionedResources TEXT;
