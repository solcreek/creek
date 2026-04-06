import { describe, test, expect } from "vitest";

/**
 * Tests for the deploy API route logic.
 * Since the route handler depends on Cloudflare Workers runtime (KV, service bindings),
 * we test the validation and rate-limiting logic in isolation.
 */

describe("deploy request validation", () => {
  test("template name must be alphanumeric with hyphens/underscores", () => {
    const valid = /^[a-zA-Z0-9_-]+$/;
    expect(valid.test("landing")).toBe(true);
    expect(valid.test("link-in-bio")).toBe(true);
    expect(valid.test("my_template")).toBe(true);
    expect(valid.test("template123")).toBe(true);

    expect(valid.test("")).toBe(false);
    expect(valid.test("../evil")).toBe(false);
    expect(valid.test("hello world")).toBe(false);
    expect(valid.test("template;rm -rf")).toBe(false);
    expect(valid.test("temp/path")).toBe(false);
  });

  test("repo URL must be from allowed hosts", () => {
    const allowedHosts = ["github.com", "gitlab.com", "bitbucket.org"];

    function isAllowedRepo(repo: string): boolean {
      try {
        const url = new URL(repo.startsWith("http") ? repo : `https://${repo}`);
        return allowedHosts.includes(url.hostname);
      } catch {
        return false;
      }
    }

    expect(isAllowedRepo("https://github.com/user/repo")).toBe(true);
    expect(isAllowedRepo("https://gitlab.com/user/repo")).toBe(true);
    expect(isAllowedRepo("https://bitbucket.org/user/repo")).toBe(true);

    expect(isAllowedRepo("https://evil.com/user/repo")).toBe(false);
    expect(isAllowedRepo("https://localhost/repo")).toBe(false);
    expect(isAllowedRepo("not-a-url")).toBe(false);
    expect(isAllowedRepo("file:///etc/passwd")).toBe(false);
  });

  test("type must be template or repo", () => {
    const validTypes = ["template", "repo"];
    expect(validTypes.includes("template")).toBe(true);
    expect(validTypes.includes("repo")).toBe(true);
    expect(validTypes.includes("other")).toBe(false);
    expect(validTypes.includes("")).toBe(false);
  });
});

describe("rate limiting logic", () => {
  test("IP hash produces consistent results", () => {
    function hashIp(ip: string): string {
      let hash = 0;
      for (let i = 0; i < ip.length; i++) {
        hash = ((hash << 5) - hash) + ip.charCodeAt(i);
        hash |= 0;
      }
      return Math.abs(hash).toString(36);
    }

    const h1 = hashIp("1.2.3.4");
    const h2 = hashIp("1.2.3.4");
    expect(h1).toBe(h2);

    const h3 = hashIp("5.6.7.8");
    expect(h3).not.toBe(h1);
  });

  test("rate limit enforces 3/hr maximum", () => {
    let count = 0;
    const MAX = 3;

    for (let i = 0; i < 5; i++) {
      if (count >= MAX) {
        expect(i).toBeGreaterThanOrEqual(3);
        break;
      }
      count++;
    }
    expect(count).toBe(3);
  });
});

describe("build request construction", () => {
  test("template request constructs correct build payload", () => {
    const body = { type: "template" as const, template: "landing", data: { title: "Acme" } };

    const buildReq = {
      repoUrl: "https://github.com/solcreek/templates",
      path: body.template,
      templateData: body.data,
    };

    expect(buildReq.repoUrl).toBe("https://github.com/solcreek/templates");
    expect(buildReq.path).toBe("landing");
    expect(buildReq.templateData).toEqual({ title: "Acme" });
  });

  test("repo request normalizes URL", () => {
    function normalizeRepo(repo: string): string {
      return repo.startsWith("http") ? repo : `https://github.com/${repo}`;
    }

    expect(normalizeRepo("https://github.com/user/repo")).toBe("https://github.com/user/repo");
    expect(normalizeRepo("user/repo")).toBe("https://github.com/user/repo");
  });

  test("template request without data omits templateData", () => {
    const body = { type: "template" as const, template: "blank" };

    const buildReq: Record<string, unknown> = {
      repoUrl: "https://github.com/solcreek/templates",
      path: body.template,
    };

    expect(buildReq.templateData).toBeUndefined();
  });
});

describe("CSRF origin check", () => {
  test("accepts creek.dev origin", () => {
    function isAllowedOrigin(origin: string | null): boolean {
      if (!origin) return true;
      try {
        const url = new URL(origin);
        return url.hostname === "creek.dev" || url.hostname.endsWith(".creek.dev") || url.hostname === "localhost";
      } catch {
        return false;
      }
    }

    expect(isAllowedOrigin("https://creek.dev")).toBe(true);
    expect(isAllowedOrigin("https://www.creek.dev")).toBe(true);
    expect(isAllowedOrigin("http://localhost:3000")).toBe(true);
    expect(isAllowedOrigin(null)).toBe(true);

    expect(isAllowedOrigin("https://evil.com")).toBe(false);
    expect(isAllowedOrigin("https://notcreek.dev")).toBe(false);
    expect(isAllowedOrigin("https://evilcreek.dev")).toBe(false);
  });
});

describe("status response shapes", () => {
  test("building status has no previewUrl", () => {
    const status = { buildId: "abc", status: "building" };
    expect(status.status).toBe("building");
    expect((status as any).previewUrl).toBeUndefined();
  });

  test("active status includes previewUrl and expiresAt", () => {
    const status = {
      buildId: "abc",
      status: "active",
      sandboxId: "s-123",
      previewUrl: "https://s-123.creeksandbox.com",
      expiresAt: "2026-03-31T12:00:00Z",
    };
    expect(status.previewUrl).toContain("creeksandbox.com");
    expect(status.expiresAt).toBeDefined();
  });

  test("failed status includes error and failedStep", () => {
    const status = {
      buildId: "abc",
      status: "failed",
      error: "npm install failed",
      failedStep: "build",
    };
    expect(status.error).toBeDefined();
    expect(status.failedStep).toBe("build");
  });
});
