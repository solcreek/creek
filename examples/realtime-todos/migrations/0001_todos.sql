CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  room_id TEXT NOT NULL,
  text TEXT NOT NULL,
  completed INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_todos_room ON todos(room_id, created_at DESC);
