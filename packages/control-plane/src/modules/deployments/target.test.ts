import { describe, test, expect } from "vitest";
import { resolveDeployTarget, cloudflareWfpTarget } from "./target.js";
import { creekdFleetTarget } from "./creekd-fleet.js";
import { localTarget } from "./local-target.js";
import type { Env } from "../../types.js";

const env = (t?: Env["DEPLOY_TARGET"]) => ({ DEPLOY_TARGET: t }) as Env;

describe("resolveDeployTarget", () => {
  test("defaults to Cloudflare WfP when DEPLOY_TARGET is unset", () => {
    expect(resolveDeployTarget(env(undefined))).toBe(cloudflareWfpTarget);
  });

  test("returns Cloudflare WfP for 'cloudflare-wfp'", () => {
    expect(resolveDeployTarget(env("cloudflare-wfp"))).toBe(cloudflareWfpTarget);
  });

  test("returns the creekd fleet target for 'creekd-fleet'", () => {
    expect(resolveDeployTarget(env("creekd-fleet"))).toBe(creekdFleetTarget);
  });

  test("returns the local target for 'local'", () => {
    expect(resolveDeployTarget(env("local"))).toBe(localTarget);
  });

  test("throws 'unknown DEPLOY_TARGET' for an unrecognized value", () => {
    expect(() => resolveDeployTarget({ DEPLOY_TARGET: "nope" } as unknown as Env)).toThrow(
      /unknown DEPLOY_TARGET/i,
    );
  });
});
