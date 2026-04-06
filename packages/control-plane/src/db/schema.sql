CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  github_id TEXT UNIQUE,
  api_key_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL REFERENCES teams(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'member',
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  team_id TEXT NOT NULL REFERENCES teams(id),
  production_deployment_id TEXT,
  production_branch TEXT NOT NULL DEFAULT 'main',
  framework TEXT,
  github_repo TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(team_id, slug)
);

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  branch TEXT,
  commit_sha TEXT,
  commit_message TEXT,
  trigger_type TEXT NOT NULL DEFAULT 'cli',
  failed_step TEXT,     -- step that caused failure: 'uploading' | 'provisioning' | 'deploying'
  error_message TEXT,   -- human-readable error description
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS environment_variables (
  project_id TEXT NOT NULL REFERENCES projects(id),
  key TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  PRIMARY KEY (project_id, key)
);

CREATE TABLE IF NOT EXISTS custom_domains (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  hostname TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_resources (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL,  -- 'd1' | 'r2' | 'kv'
  cf_resource_id TEXT NOT NULL, -- CF-returned ID (database uuid / bucket name / namespace id)
  cf_resource_name TEXT NOT NULL, -- Name we used when creating
  status TEXT NOT NULL DEFAULT 'provisioning', -- 'provisioning' | 'active' | 'failed' | 'deleting' | 'deleted'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, resource_type)
);

CREATE INDEX IF NOT EXISTS idx_teams_slug ON teams(slug);
CREATE INDEX IF NOT EXISTS idx_projects_team_slug ON projects(team_id, slug);
CREATE INDEX IF NOT EXISTS idx_deployments_project_id ON deployments(project_id);
CREATE INDEX IF NOT EXISTS idx_deployments_branch ON deployments(project_id, branch, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_token_hash ON auth_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_custom_domains_hostname ON custom_domains(hostname);
CREATE INDEX IF NOT EXISTS idx_custom_domains_project_id ON custom_domains(project_id);
CREATE INDEX IF NOT EXISTS idx_project_resources_status ON project_resources(status);

-- Audit log — permanent record of all write operations
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  teamId TEXT NOT NULL,
  userId TEXT NOT NULL,
  userEmail TEXT NOT NULL,
  action TEXT NOT NULL,
  resourceType TEXT NOT NULL,
  resourceId TEXT,
  metadata TEXT,
  ipHash TEXT,
  country TEXT,
  userAgent TEXT,
  cfRay TEXT,
  createdAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_user_time ON audit_log(userId, createdAt);
CREATE INDEX IF NOT EXISTS idx_audit_log_team_time ON audit_log(teamId, createdAt);

-- Raw IP log — 30-day retention for legal compliance
CREATE TABLE IF NOT EXISTS audit_ip_log (
  auditLogId TEXT NOT NULL,
  rawIp TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_ip_log_created ON audit_ip_log(createdAt);

CREATE TABLE IF NOT EXISTS resource_cleanup_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_type TEXT NOT NULL,  -- 'd1' | 'r2' | 'kv'
  cf_resource_id TEXT NOT NULL,
  cf_resource_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'cleaning' | 'done' | 'failed'
  reason TEXT, -- 'project_deleted' | 'resource_replaced'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_resource_cleanup_queue_status ON resource_cleanup_queue(status);
