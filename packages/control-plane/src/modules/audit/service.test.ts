import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createLocalTestEnv, type LocalTestEnv } from "../../local/test-env.js";
import { recordAudit, hashIp, purgeAuditIpLogs } from "./service.js";
import type { AuditRequestContext } from "./types.js";
import type { AuthUser } from "../tenant/types.js";

const TEST_USER: AuthUser = {
  id: "user-1",
  email: "test@example.com",
  name: "Test User",
  role: "user",
  activeOrganizationId: null,
};

const TEST_TEAM_ID = "team-1";

const TEST_AUDIT_CTX: AuditRequestContext = {
  ip: "203.0.113.42",
  ipHash: "a1b2c3d4e5f67890",
  country: "TW",
  userAgent: "creek-cli/0.3.0",
  cfRay: "8abc123def-TPE",
};

let testEnv: LocalTestEnv;

beforeEach(() => {
  testEnv = createLocalTestEnv();
});

afterEach(() => {
  testEnv.cleanup();
});

describe("hashIp", () => {
  test("produces consistent 16-char hex hash", async () => {
    const hash1 = await hashIp("1.2.3.4", "test-salt");
    const hash2 = await hashIp("1.2.3.4", "test-salt");
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(16);
    expect(hash1).toMatch(/^[a-f0-9]{16}$/);
  });

  test("different IPs produce different hashes", async () => {
    const hash1 = await hashIp("1.2.3.4", "salt");
    const hash2 = await hashIp("5.6.7.8", "salt");
    expect(hash1).not.toBe(hash2);
  });

  test("different salts produce different hashes", async () => {
    const hash1 = await hashIp("1.2.3.4", "salt-a");
    const hash2 = await hashIp("1.2.3.4", "salt-b");
    expect(hash1).not.toBe(hash2);
  });
});

describe("recordAudit", () => {
  test("inserts audit_log and audit_ip_log rows", async () => {
    await recordAudit(
      testEnv.env.DB as any,
      TEST_USER,
      TEST_TEAM_ID,
      {
        action: "project.create",
        resourceType: "project",
        resourceId: "proj-123",
        metadata: { slug: "my-app" },
      },
      TEST_AUDIT_CTX,
    );

    const auditRow = (await testEnv.env.DB.prepare(
      "SELECT * FROM audit_log ORDER BY createdAt DESC LIMIT 1",
    ).first()) as any;

    expect(auditRow).not.toBeNull();
    expect(auditRow.action).toBe("project.create");
    expect(auditRow.resourceType).toBe("project");
    expect(auditRow.resourceId).toBe("proj-123");

    const ipRow = (await testEnv.env.DB.prepare(
      "SELECT * FROM audit_ip_log ORDER BY createdAt DESC LIMIT 1",
    ).first()) as any;
    expect(ipRow).not.toBeNull();
  });

  test("stores correct user identity fields", async () => {
    await recordAudit(
      testEnv.env.DB as any,
      TEST_USER,
      TEST_TEAM_ID,
      {
        action: "deployment.deploy",
        resourceType: "deployment",
        resourceId: "dep-456",
      },
      TEST_AUDIT_CTX,
    );

    const row = (await testEnv.env.DB.prepare("SELECT * FROM audit_log WHERE resourceId = ?")
      .bind("dep-456")
      .first()) as any;

    expect(row.teamId).toBe(TEST_TEAM_ID);
    expect(row.userId).toBe(TEST_USER.id);
    expect(row.userEmail).toBe(TEST_USER.email);
    expect(row.action).toBe("deployment.deploy");
  });

  test("stores request context fields", async () => {
    await recordAudit(
      testEnv.env.DB as any,
      TEST_USER,
      TEST_TEAM_ID,
      {
        action: "envvar.set",
        resourceType: "envvar",
        resourceId: "proj-1",
        metadata: { key: "DATABASE_URL" },
      },
      TEST_AUDIT_CTX,
    );

    const row = (await testEnv.env.DB.prepare("SELECT * FROM audit_log WHERE action = ?")
      .bind("envvar.set")
      .first()) as any;

    expect(row.ipHash).toBe(TEST_AUDIT_CTX.ipHash);
    expect(row.country).toBe("TW");
    expect(row.userAgent).toBe("creek-cli/0.3.0");
    expect(row.cfRay).toBe("8abc123def-TPE");
  });

  test("stores raw IP in audit_ip_log", async () => {
    await recordAudit(
      testEnv.env.DB as any,
      TEST_USER,
      TEST_TEAM_ID,
      {
        action: "project.delete",
        resourceType: "project",
        resourceId: "proj-1",
      },
      TEST_AUDIT_CTX,
    );

    const ipRow = (await testEnv.env.DB.prepare(
      "SELECT * FROM audit_ip_log ORDER BY createdAt DESC LIMIT 1",
    ).first()) as any;

    expect(ipRow.rawIp).toBe("203.0.113.42");
  });

  test("handles null metadata and resourceId", async () => {
    await recordAudit(
      testEnv.env.DB as any,
      TEST_USER,
      TEST_TEAM_ID,
      {
        action: "domain.add",
        resourceType: "domain",
      },
      TEST_AUDIT_CTX,
    );

    const row = (await testEnv.env.DB.prepare("SELECT * FROM audit_log WHERE action = ?")
      .bind("domain.add")
      .first()) as any;

    expect(row.resourceId).toBeNull();
    expect(row.metadata).toBeNull();
  });

  test("truncates userAgent to 512 chars", async () => {
    const longUA = "x".repeat(1000);
    await recordAudit(
      testEnv.env.DB as any,
      TEST_USER,
      TEST_TEAM_ID,
      {
        action: "project.create",
        resourceType: "project",
      },
      { ...TEST_AUDIT_CTX, userAgent: longUA },
    );

    const row = (await testEnv.env.DB.prepare(
      "SELECT userAgent FROM audit_log ORDER BY createdAt DESC LIMIT 1",
    ).first()) as any;

    expect(row.userAgent).toHaveLength(512);
  });

  test("does not throw on db error", async () => {
    const failingDb = {
      batch: async () => {
        throw new Error("DB offline");
      },
      prepare: () => ({ bind: () => ({ run: async () => ({}) }) }),
    };

    await expect(
      recordAudit(
        failingDb as any,
        TEST_USER,
        TEST_TEAM_ID,
        {
          action: "project.create",
          resourceType: "project",
        },
        TEST_AUDIT_CTX,
      ),
    ).resolves.toBeUndefined();
  });
});

describe("purgeAuditIpLogs", () => {
  test("deletes records older than 30 days", async () => {
    const db = testEnv.env.DB;
    const now = Date.now();
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;

    await db
      .prepare("INSERT INTO audit_ip_log (auditLogId, rawIp, createdAt) VALUES (?, ?, ?)")
      .bind("fresh-id", "1.2.3.4", now)
      .run();
    await db
      .prepare("INSERT INTO audit_ip_log (auditLogId, rawIp, createdAt) VALUES (?, ?, ?)")
      .bind("old-id", "5.6.7.8", old)
      .run();

    await purgeAuditIpLogs(db as any);

    const remaining = (await db.prepare("SELECT * FROM audit_ip_log").all()) as any;
    expect(remaining.results).toHaveLength(1);
    expect(remaining.results[0].auditLogId).toBe("fresh-id");
  });
});
