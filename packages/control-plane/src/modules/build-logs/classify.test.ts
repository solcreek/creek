import { describe, expect, it } from "vitest";
import { classifyDeployFailure } from "./classify.js";

describe("classifyDeployFailure", () => {
  it("codes a timeout by the stage it failed at", () => {
    // The reaper writes "...exceeded the 10-minute deploy window..." per stage.
    expect(classifyDeployFailure("uploading", "Upload exceeded the 10-minute deploy window — shrink the bundle").code).toBe("upload_timeout");
    expect(classifyDeployFailure("provisioning", "Provisioning exceeded the 10-minute deploy window").code).toBe("provision_timeout");
    expect(classifyDeployFailure("deploying", "Activation exceeded the 10-minute deploy window").code).toBe("activation_timeout");
  });

  it("treats the legacy bare 'Deploy timed out' as an activation timeout", () => {
    expect(classifyDeployFailure("deploying", "Deploy timed out").code).toBe("activation_timeout");
  });

  it("codes an oversized worker bundle", () => {
    expect(classifyDeployFailure("deploying", "Error: Payload Too Large").code).toBe("bundle_too_large");
    expect(classifyDeployFailure("deploying", "script is over the 10 MB limit").code).toBe("bundle_too_large");
  });

  it("codes a resource/binding failure", () => {
    expect(classifyDeployFailure("deploying", "D1_ERROR: no such column: main.Notification.category").code).toBe("binding_error");
    expect(classifyDeployFailure("provisioning", "failed to bind R2 bucket").code).toBe("binding_error");
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
