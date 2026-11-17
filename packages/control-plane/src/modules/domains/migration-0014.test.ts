import { describe, it, expect, afterEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLocalTestEnv,
  seedTestData,
  seedProject,
  type LocalTestEnv,
} from "../../local/test-env.js";

const MIGRATION = "0014_primary_domain_redirect.sql";

describe("migration 0014: primary domain and redirect", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../drizzle");
  let t: LocalTestEnv;
  afterEach(() => t.cleanup());

  /** A database at the schema just before 0014, with `seed` run against it, then migrated. */
  function migrate(seed: (db: LocalTestEnv["db"]["db"]) => void) {
    t = createLocalTestEnv({ applyMigrations: false });
    const db = t.db.db;
    const files = readdirSync(dir)
      .filter((f) => /^\d{4}.*\.sql$/.test(f))
      .sort();
    const at = files.indexOf(MIGRATION);
    expect(at).toBeGreaterThan(0);
    for (const f of files.slice(0, at)) db.exec(readFileSync(join(dir, f), "utf-8"));
    seedTestData(t);
    seed(db);
    for (const f of files.slice(at)) db.exec(readFileSync(join(dir, f), "utf-8"));
    return db;
  }

  const domain = (id: string, projectId: string, status: string, createdAt: number) =>
    `INSERT INTO custom_domain (id, projectId, hostname, status, createdAt)
     VALUES ('${id}', '${projectId}', '${id}.example.com', '${status}', ${createdAt})`;

  const primaries = (db: LocalTestEnv["db"]["db"]) =>
    db
      .prepare("SELECT id FROM custom_domain WHERE isPrimary = 1 ORDER BY id")
      .all()
      .map((r: any) => r.id);

  const redirects = (db: LocalTestEnv["db"]["db"], projectId: string) =>
    (
      db
        .prepare("SELECT redirectToPrimaryDomain AS r FROM project WHERE id = ?")
        .get(projectId) as {
        r: number;
      }
    ).r;

  it("keeps a project that already has a domain off the redirect, and marks its oldest active domain primary", () => {
    const db = migrate((db) => {
      seedProject(t, "site", { id: "p" });
      db.exec(domain("newer", "p", "active", 300));
      db.exec(domain("older", "p", "active", 200));
      db.exec(domain("pending", "p", "pending", 100));
    });

    expect(redirects(db, "p")).toBe(0);
    expect(primaries(db)).toEqual(["older"]);
  });

  it("falls back to the oldest domain when none is active", () => {
    const db = migrate((db) => {
      seedProject(t, "site", { id: "p" });
      db.exec(domain("second", "p", "pending", 200));
      db.exec(domain("first", "p", "failed", 100));
    });

    expect(primaries(db)).toEqual(["first"]);
  });

  it("picks one primary per project", () => {
    const db = migrate((db) => {
      seedProject(t, "one", { id: "p1" });
      seedProject(t, "two", { id: "p2" });
      db.exec(domain("a", "p1", "active", 100));
      db.exec(domain("b", "p2", "active", 100));
      db.exec(domain("c", "p2", "active", 200));
    });

    expect(primaries(db)).toEqual(["a", "b"]);
  });

  it("leaves the redirect on for a project with no domain, and for projects created afterwards", () => {
    const db = migrate(() => {
      seedProject(t, "bare", { id: "bare" });
    });
    seedProject(t, "later", { id: "later" });

    expect(redirects(db, "bare")).toBe(1);
    expect(redirects(db, "later")).toBe(1);
  });

  it("allows only one primary domain per project afterwards", () => {
    const db = migrate((db) => {
      seedProject(t, "site", { id: "p" });
      db.exec(domain("a", "p", "active", 100));
      db.exec(domain("b", "p", "active", 200));
    });

    expect(() => db.exec("UPDATE custom_domain SET isPrimary = 1 WHERE id = 'b'")).toThrow(
      /UNIQUE/,
    );
    db.exec("UPDATE custom_domain SET isPrimary = 0 WHERE id = 'a'");
    db.exec("UPDATE custom_domain SET isPrimary = 1 WHERE id = 'b'");
    expect(primaries(db)).toEqual(["b"]);
  });
});
