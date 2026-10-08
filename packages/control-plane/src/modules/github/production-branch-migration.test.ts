import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLocalTestEnv,
  seedTestData,
  seedProject,
  type LocalTestEnv,
} from "../../local/test-env.js";

const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../drizzle/0012_project_production_branch_from_github.sql",
);

describe("migration 0012: project.productionBranch from github_connection", () => {
  let t: LocalTestEnv;
  afterEach(() => t.cleanup());

  it("copies a connection's production branch onto its project, and touches nothing else", () => {
    t = createLocalTestEnv();
    seedTestData(t);
    seedProject(t, "connected", { id: "p-conn" });
    seedProject(t, "agreed", { id: "p-same" });
    seedProject(t, "unconnected", { id: "p-none" });
    const db = t.db.db;
    db.exec("UPDATE project SET productionBranch = 'trunk' WHERE id = 'p-none'");
    const insert = db.prepare(
      `INSERT INTO github_connection (id, projectId, installationId, repoOwner, repoName, productionBranch, createdAt)
       VALUES (?, ?, 1, 'o', ?, ?, 0)`,
    );
    insert.run("c1", "p-conn", "r1", "release");
    insert.run("c2", "p-same", "r2", "main");

    db.exec(readFileSync(MIGRATION, "utf-8"));
    // Idempotent: running it again changes nothing.
    db.exec(readFileSync(MIGRATION, "utf-8"));

    const branches = Object.fromEntries(
      (
        db.prepare("SELECT id, productionBranch FROM project").all() as {
          id: string;
          productionBranch: string;
        }[]
      ).map((r) => [r.id, r.productionBranch]),
    );
    expect(branches).toEqual({ "p-conn": "release", "p-same": "main", "p-none": "trunk" });
  });
});
