import { describe, expect, it } from "vitest";
import { classifyDeployFailure } from "./classify.js";

describe("classifyDeployFailure", () => {
  it("codes a timeout by the stage it failed at", () => {
    // The reaper writes "...exceeded the 10-minute deploy window..." per stage.
    expect(
      classifyDeployFailure(
        "uploading",
        "Upload exceeded the 10-minute deploy window — shrink the bundle",
      ).code,
    ).toBe("upload_timeout");
    expect(
      classifyDeployFailure("provisioning", "Provisioning exceeded the 10-minute deploy window")
        .code,
    ).toBe("provision_timeout");
    expect(
      classifyDeployFailure("deploying", "Activation exceeded the 10-minute deploy window").code,
    ).toBe("activation_timeout");
  });

  it("treats the legacy bare 'Deploy timed out' as an activation timeout", () => {
    expect(classifyDeployFailure("deploying", "Deploy timed out").code).toBe("activation_timeout");
  });

  it("codes an oversized worker bundle", () => {
    expect(classifyDeployFailure("deploying", "Error: Payload Too Large").code).toBe(
      "bundle_too_large",
    );
    expect(classifyDeployFailure("deploying", "script is over the 10 MB limit").code).toBe(
      "bundle_too_large",
    );
  });

  it("codes a resource/binding failure", () => {
    expect(
      classifyDeployFailure("deploying", "D1_ERROR: no such column: main.Notification.category")
        .code,
    ).toBe("binding_error");
    expect(classifyDeployFailure("provisioning", "failed to bind R2 bucket").code).toBe(
      "binding_error",
    );
  });

  it("codes [release] migration failures by what to fix, not the D1 error inside", () => {
    // Verbatim from a production deploy (2026-10-07): the wrapped D1 error says
    // "no such table", which the generic rule would call a binding error.
    const failed = classifyDeployFailure(
      "provisioning",
      'migration 0003_broken.sql failed: CF API HTTP 400: {"messages":[],"result":[],"success":false,"errors":[{"code":7500,"message":"no such table: missing_table: SQLITE_ERROR"}]}',
    );
    expect(failed.code).toBe("migration_failed");
    expect(failed.hint).toContain("rolled back");
    expect(
      classifyDeployFailure("provisioning", "migration 0002_seed.sql failed: request timed out")
        .code,
    ).toBe("migration_failed");
    expect(
      classifyDeployFailure(
        "provisioning",
        "migration 0001_big.sql is 147 KB; a release migration must fit in 90 KB so it applies as one batch. Split it into smaller migration files.",
      ).code,
    ).toBe("migration_too_large");
    expect(
      classifyDeployFailure(
        "provisioning",
        "[release] migrations is on but the project has 2 databases and none is bound as DATABASE or DB, so there is no single database to migrate.",
      ).code,
    ).toBe("migration_target");
    // Only the deploy job's provisioning step produces these.
    expect(classifyDeployFailure("deploying", "migration x failed: no such table: t").code).toBe(
      "binding_error",
    );
  });

  it("falls back to a generic deploy_error for anything unrecognized", () => {
    expect(classifyDeployFailure("deploying", "some opaque edge error").code).toBe("deploy_error");
    expect(classifyDeployFailure(null, null).code).toBe("deploy_error");
  });

  it("always returns an actionable, non-empty hint", () => {
    for (const [step, msg] of [
      ["uploading", "Upload exceeded the 10-minute deploy window"],
      ["deploying", "Payload Too Large"],
      ["deploying", "D1_ERROR: no such table"],
      ["deploying", "weird"],
    ] as const) {
      expect(classifyDeployFailure(step, msg).hint.length).toBeGreaterThan(0);
    }
  });
});
