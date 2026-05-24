import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { LocalD1Database } from "./d1-adapter";

describe("LocalD1Database", () => {
  let db: LocalD1Database;

  beforeEach(() => {
    db = new LocalD1Database(":memory:");
    db.inner.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE,
        active INTEGER DEFAULT 1
      )
    `);
  });

  afterEach(() => {
    db.close();
  });

  describe("prepare().run()", () => {
    it("inserts a row", async () => {
      const result = await db.prepare("INSERT INTO users (name, email) VALUES (?, ?)").bind("alice", "a@b.com").run();
      expect(result.success).toBe(true);
      expect(result.meta.changes).toBe(1);
      expect(result.meta.last_row_id).toBe(1);
    });

    it("updates rows", async () => {
      await db.prepare("INSERT INTO users (name, email) VALUES (?, ?)").bind("alice", "a@b.com").run();
      await db.prepare("INSERT INTO users (name, email) VALUES (?, ?)").bind("bob", "b@b.com").run();
      const result = await db.prepare("UPDATE users SET active = 0 WHERE name = ?").bind("alice").run();
      expect(result.meta.changes).toBe(1);
    });

    it("deletes rows", async () => {
      await db.prepare("INSERT INTO users (name, email) VALUES (?, ?)").bind("alice", "a@b.com").run();
      const result = await db.prepare("DELETE FROM users WHERE name = ?").bind("alice").run();
      expect(result.meta.changes).toBe(1);
    });
  });

  describe("prepare().first()", () => {
    it("returns first row as object", async () => {
      await db.prepare("INSERT INTO users (name, email) VALUES (?, ?)").bind("alice", "a@b.com").run();
      const row = await db.prepare("SELECT * FROM users WHERE name = ?").bind("alice").first();
      expect(row).not.toBeNull();
      expect(row!.name).toBe("alice");
      expect(row!.email).toBe("a@b.com");
    });

    it("returns null when no match", async () => {
      const row = await db.prepare("SELECT * FROM users WHERE name = ?").bind("ghost").first();
      expect(row).toBeNull();
    });

    it("returns single column when column name provided", async () => {
      await db.prepare("INSERT INTO users (name, email) VALUES (?, ?)").bind("alice", "a@b.com").run();
      const name = await db.prepare("SELECT * FROM users WHERE email = ?").bind("a@b.com").first("name");
      expect(name).toBe("alice");
    });

    it("returns null column for missing row", async () => {
      const val = await db.prepare("SELECT * FROM users WHERE name = ?").bind("ghost").first("name");
      expect(val).toBeNull();
    });
  });

  describe("prepare().all()", () => {
    it("returns all matching rows", async () => {
      await db.prepare("INSERT INTO users (name, email) VALUES (?, ?)").bind("alice", "a@b.com").run();
      await db.prepare("INSERT INTO users (name, email) VALUES (?, ?)").bind("bob", "b@b.com").run();
      await db.prepare("INSERT INTO users (name, email) VALUES (?, ?)").bind("carol", "c@b.com").run();

      const result = await db.prepare("SELECT * FROM users ORDER BY name").all();
      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(3);
      expect(result.results[0].name).toBe("alice");
      expect(result.results[2].name).toBe("carol");
    });

    it("returns empty results for no match", async () => {
      const result = await db.prepare("SELECT * FROM users WHERE active = 0").all();
      expect(result.results).toHaveLength(0);
    });

    it("reports rows_read", async () => {
      await db.prepare("INSERT INTO users (name, email) VALUES (?, ?)").bind("alice", "a@b.com").run();
      await db.prepare("INSERT INTO users (name, email) VALUES (?, ?)").bind("bob", "b@b.com").run();
      const result = await db.prepare("SELECT * FROM users").all();
      expect(result.meta.rows_read).toBe(2);
    });
  });

  describe("bind()", () => {
    it("returns a new statement (immutable)", async () => {
      const base = db.prepare("SELECT * FROM users WHERE name = ?");
      const bound1 = base.bind("alice");
      const bound2 = base.bind("bob");
      // Binding should not mutate the original
      expect(bound1).not.toBe(bound2);
    });

    it("handles multiple parameters", async () => {
      await db.prepare("INSERT INTO users (name, email, active) VALUES (?, ?, ?)").bind("alice", "a@b.com", 0).run();
      const row = await db.prepare("SELECT * FROM users WHERE name = ? AND active = ?").bind("alice", 0).first();
      expect(row).not.toBeNull();
      expect(row!.active).toBe(0);
    });

    it("handles null parameters", async () => {
      await db.prepare("INSERT INTO users (name, email) VALUES (?, ?)").bind("anon", null).run();
      const row = await db.prepare("SELECT * FROM users WHERE name = ?").bind("anon").first();
      expect(row!.email).toBeNull();
    });
  });

  describe("batch()", () => {
    it("executes multiple statements atomically", async () => {
      const results = await db.batch([
        db.prepare("INSERT INTO users (name, email) VALUES (?, ?)").bind("alice", "a@b.com"),
        db.prepare("INSERT INTO users (name, email) VALUES (?, ?)").bind("bob", "b@b.com"),
        db.prepare("INSERT INTO users (name, email) VALUES (?, ?)").bind("carol", "c@b.com"),
      ]);
      expect(results).toHaveLength(3);
      results.forEach((r) => expect(r.success).toBe(true));

      const all = await db.prepare("SELECT COUNT(*) as cnt FROM users").first();
      expect(all!.cnt).toBe(3);
    });

    it("rolls back on error", async () => {
      await db.prepare("INSERT INTO users (name, email) VALUES (?, ?)").bind("alice", "a@b.com").run();
      try {
        await db.batch([
          db.prepare("INSERT INTO users (name, email) VALUES (?, ?)").bind("bob", "b@b.com"),
          db.prepare("INSERT INTO users (name, email) VALUES (?, ?)").bind("dup", "a@b.com"), // unique violation
        ]);
      } catch {
        // expected
      }
      // Only alice should exist (batch rolled back)
      const count = await db.prepare("SELECT COUNT(*) as cnt FROM users").first();
      expect(count!.cnt).toBe(1);
    });
  });

  describe("exec()", () => {
    it("executes raw SQL", async () => {
      const result = await db.exec("INSERT INTO users (name, email) VALUES ('test', 'test@test.com')");
      expect(result.count).toBe(1);
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it("executes multi-statement SQL", async () => {
      await db.exec(`
        INSERT INTO users (name, email) VALUES ('a', 'a@a.com');
        INSERT INTO users (name, email) VALUES ('b', 'b@b.com');
      `);
      const count = await db.prepare("SELECT COUNT(*) as cnt FROM users").first();
      expect(count!.cnt).toBe(2);
    });
  });

  describe("SQLite edge cases", () => {
    it("handles INTEGER types correctly", async () => {
      db.inner.exec("CREATE TABLE counters (id TEXT PRIMARY KEY, val INTEGER)");
      await db.prepare("INSERT INTO counters VALUES (?, ?)").bind("c1", 9007199254740991).run(); // Number.MAX_SAFE_INTEGER
      const row = await db.prepare("SELECT val FROM counters WHERE id = ?").bind("c1").first();
      expect(row!.val).toBe(9007199254740991);
    });

    it("handles empty string values", async () => {
      await db.prepare("INSERT INTO users (name, email) VALUES (?, ?)").bind("", "empty@test.com").run();
      const row = await db.prepare("SELECT * FROM users WHERE email = ?").bind("empty@test.com").first();
      expect(row!.name).toBe("");
    });

    it("handles unicode", async () => {
      await db.prepare("INSERT INTO users (name, email) VALUES (?, ?)").bind("日本語テスト", "jp@test.com").run();
      const row = await db.prepare("SELECT name FROM users WHERE email = ?").bind("jp@test.com").first();
      expect(row!.name).toBe("日本語テスト");
    });

    it("PRAGMA journal_mode is WAL for file-backed DB", async () => {
      const { mkdtempSync, rmSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");
      const dir = mkdtempSync(join(tmpdir(), "d1-test-"));
      const fileDb = new LocalD1Database(join(dir, "test.db"));
      const row = fileDb.inner.query("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(row.journal_mode).toBe("wal");
      fileDb.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it("foreign keys are enabled", async () => {
      const row = db.inner.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
      expect(row.foreign_keys).toBe(1);
    });
  });
});
