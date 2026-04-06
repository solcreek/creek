-- Test team for local development
INSERT OR IGNORE INTO teams (id, slug, name)
VALUES ('team-001', 'dev', 'Development Team');

-- Test user
INSERT OR IGNORE INTO users (id, email, github_id, api_key_hash)
VALUES ('user-001', 'dev@creek.dev', NULL, 'unused');

-- Link user to team
INSERT OR IGNORE INTO team_members (team_id, user_id, role)
VALUES ('team-001', 'user-001', 'owner');

-- Token: test-token-12345 (SHA-256 hashed)
INSERT OR IGNORE INTO auth_tokens (id, user_id, token_hash, expires_at)
VALUES (
  'tok-001',
  'user-001',
  'e4c0a87e760240da600e6d0c5c37516742a3d691feb803a33dcbbe8405e64b1e',
  '2099-12-31T23:59:59Z'
);
