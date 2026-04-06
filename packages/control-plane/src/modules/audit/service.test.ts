import { describe, test, expect, beforeEach } from "vitest";
import { createMockD1, TEST_USER, TEST_TEAM, type MockD1 } from "../../test-helpers.js";
import { recordAudit, hashIp, purgeAuditIpLogs } from "./service.js";
import type { AuditRequestContext } from "./types.js";

let db: MockD1;

const TEST_AUDIT_CTX: AuditRequestContext = {
  ip: "203.0.113.42",
  ipHash: "a1b2c3d4e5f67890",
  country: "TW",
  userAgent: "creek-cli/0.3.0",
  cfRay: "8abc123def-TPE",
};

beforeEach(() => {
  db = createMockD1();
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
  test("inserts audit_log and audit_ip_log via batch", async () => {
    await recordAudit(db as any, TEST_USER, TEST_TEAM.id, {
      action: "project.create",
      resourceType: "project",
      resourceId: "proj-123",
      metadata: { slug: "my-app" },
    }, TEST_AUDIT_CTX);

    const executed = db.getExecuted();
    // batch() calls run() on each statement
    expect(executed.length).toBe(2);
    expect(executed[0].sql).toContain("INSERT INTO audit_log");
    expect(executed[1].sql).toContain("INSERT INTO audit_ip_log");
  });

  test("stores correct user identity fields", async () => {
    await recordAudit(db as any, TEST_USER, TEST_TEAM.id, {
      action: "deployment.deploy",
      resourceType: "deployment",
      resourceId: "dep-456",
    }, TEST_AUDIT_CTX);

    const executed = db.getExecuted();
    const auditArgs = executed[0].args;
    // args: id, teamId, userId, userEmail, action, resourceType, resourceId, metadata, ipHash, country, userAgent, cfRay, createdAt
    expect(auditArgs[1]).toBe(TEST_TEAM.id); // teamId
    expect(auditArgs[2]).toBe(TEST_USER.id); // userId
    expect(auditArgs[3]).toBe(TEST_USER.email); // userEmail
    expect(auditArgs[4]).toBe("deployment.deploy"); // action
    expect(auditArgs[5]).toBe("deployment"); // resourceType
    expect(auditArgs[6]).toBe("dep-456"); // resourceId
  });

  test("stores request context fields", async () => {
    await recordAudit(db as any, TEST_USER, TEST_TEAM.id, {
      action: "envvar.set",
      resourceType: "envvar",
      resourceId: "proj-1",
      metadata: { key: "DATABASE_URL" },
    }, TEST_AUDIT_CTX);

    const executed = db.getExecuted();
    const auditArgs = executed[0].args;
    expect(auditArgs[8]).toBe(TEST_AUDIT_CTX.ipHash); // ipHash
    expect(auditArgs[9]).toBe("TW"); // country
    expect(auditArgs[10]).toBe("creek-cli/0.3.0"); // userAgent
    expect(auditArgs[11]).toBe("8abc123def-TPE"); // cfRay
  });

  test("stores raw IP in audit_ip_log", async () => {
    await recordAudit(db as any, TEST_USER, TEST_TEAM.id, {
      action: "project.delete",
      resourceType: "project",
      resourceId: "proj-1",
    }, TEST_AUDIT_CTX);

    const executed = db.getExecuted();
    const ipLogArgs = executed[1].args;
    // args: auditLogId, rawIp, createdAt
    expect(ipLogArgs[1]).toBe("203.0.113.42"); // rawIp
  });

  test("handles null metadata", async () => {
    await recordAudit(db as any, TEST_USER, TEST_TEAM.id, {
      action: "domain.add",
      resourceType: "domain",
    }, TEST_AUDIT_CTX);

    const executed = db.getExecuted();
    const auditArgs = executed[0].args;
    expect(auditArgs[6]).toBeNull(); // resourceId
    expect(auditArgs[7]).toBeNull(); // metadata
  });

  test("truncates userAgent to 512 chars", async () => {
    const longUA = "x".repeat(1000);
    await recordAudit(db as any, TEST_USER, TEST_TEAM.id, {
      action: "project.create",
      resourceType: "project",
    }, { ...TEST_AUDIT_CTX, userAgent: longUA });

    const executed = db.getExecuted();
    const ua = executed[0].args[10] as string;
    expect(ua).toHaveLength(512);
  });

  test("does not throw on db error", async () => {
    // Create a DB mock that throws on batch
    const failingDb = {
      batch: async () => { throw new Error("DB offline"); },
      prepare: () => ({ bind: () => ({ run: async () => ({}) }) }),
    };

    // Should not throw
    await expect(
      recordAudit(failingDb as any, TEST_USER, TEST_TEAM.id, {
        action: "project.create",
        resourceType: "project",
      }, TEST_AUDIT_CTX),
    ).resolves.toBeUndefined();
  });
});

describe("purgeAuditIpLogs", () => {
  test("deletes records older than 30 days", async () => {
    const result = await purgeAuditIpLogs(db as any);
    const executed = db.getExecuted();
    expect(executed.length).toBe(1);
    expect(executed[0].sql).toContain("DELETE FROM audit_ip_log");
    expect(executed[0].sql).toContain("createdAt < ?");
  });
});
