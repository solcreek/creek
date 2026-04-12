import { describe, it, expect } from "vitest";
import {
  PROVIDER_MAP,
  buildDeployPath,
  parseDeploySlug,
  type ParsedDeploySlug,
} from "./deploy-url.js";

describe("parseDeploySlug — standard 3-segment URLs", () => {
  it("parses a plain gh/owner/repo slug", () => {
    const r = parseDeploySlug(["gh", "satnaing", "astro-paper"]);
    expect(r).not.toBeNull();
    expect(r?.providerKey).toBe("gh");
    expect(r?.provider.host).toBe("github.com");
    expect(r?.provider.displayName).toBe("GitHub");
    expect(r?.owner).toBe("satnaing");
    expect(r?.repo).toBe("astro-paper");
    expect(r?.branch).toBeNull();
    expect(r?.subpath).toBeNull();
  });

  it("accepts every provider shortcode", () => {
    for (const shortcode of Object.keys(PROVIDER_MAP)) {
      const r = parseDeploySlug([shortcode, "o", "r"]);
      expect(r, `shortcode ${shortcode} should parse`).not.toBeNull();
      expect(r?.providerKey).toBe(shortcode);
    }
  });

  it("normalises provider case", () => {
    expect(parseDeploySlug(["GH", "o", "r"])?.providerKey).toBe("gh");
    expect(parseDeploySlug(["GitHub", "o", "r"])?.providerKey).toBe("github");
    expect(parseDeploySlug(["GitLab", "o", "r"])?.providerKey).toBe("gitlab");
    expect(parseDeploySlug(["BITBUCKET", "o", "r"])?.providerKey).toBe("bitbucket");
  });

  it("strips a trailing .git suffix from the repo name", () => {
    const r = parseDeploySlug(["gh", "owner", "repo.git"]);
    expect(r?.repo).toBe("repo");
  });

  it("accepts repo names with allowed special characters", () => {
    expect(parseDeploySlug(["gh", "owner", "my-repo"])?.repo).toBe("my-repo");
    expect(parseDeploySlug(["gh", "owner", "my_repo"])?.repo).toBe("my_repo");
    expect(parseDeploySlug(["gh", "owner", "my.repo"])?.repo).toBe("my.repo");
    expect(parseDeploySlug(["gh", "owner", "repo123"])?.repo).toBe("repo123");
  });
});

describe("parseDeploySlug — rejection cases", () => {
  it("returns null for unknown provider shortcodes", () => {
    expect(parseDeploySlug(["sr", "owner", "repo"])).toBeNull();
    expect(parseDeploySlug(["heroku", "owner", "repo"])).toBeNull();
    expect(parseDeploySlug(["", "owner", "repo"])).toBeNull();
  });

  it("returns null for fewer than 3 segments", () => {
    expect(parseDeploySlug([])).toBeNull();
    expect(parseDeploySlug(["gh"])).toBeNull();
    expect(parseDeploySlug(["gh", "owner"])).toBeNull();
  });

  it("returns null for null or undefined input", () => {
    expect(parseDeploySlug(null)).toBeNull();
    expect(parseDeploySlug(undefined)).toBeNull();
  });

  it("returns null for owner or repo with unsafe characters", () => {
    expect(parseDeploySlug(["gh", "owner$", "repo"])).toBeNull();
    expect(parseDeploySlug(["gh", "owner", "repo!"])).toBeNull();
    expect(parseDeploySlug(["gh", "owner/sub", "repo"])).toBeNull();
    expect(parseDeploySlug(["gh", "owner", "repo with space"])).toBeNull();
  });

  it("rejects dot-only segments as a path traversal guard", () => {
    expect(parseDeploySlug(["gh", ".", "repo"])).toBeNull();
    expect(parseDeploySlug(["gh", "..", "repo"])).toBeNull();
    expect(parseDeploySlug(["gh", "...", "repo"])).toBeNull();
    expect(parseDeploySlug(["gh", "owner", "."])).toBeNull();
    expect(parseDeploySlug(["gh", "owner", ".."])).toBeNull();
  });

  it("returns null for empty owner or repo segments", () => {
    expect(parseDeploySlug(["gh", "", "repo"])).toBeNull();
    expect(parseDeploySlug(["gh", "owner", ""])).toBeNull();
  });
});

describe("parseDeploySlug — subpath support (tree/branch/...)", () => {
  it("parses tree/branch with no subpath", () => {
    const r = parseDeploySlug(["gh", "withastro", "astro", "tree", "main"]);
    expect(r).not.toBeNull();
    expect(r?.branch).toBe("main");
    expect(r?.subpath).toBeNull();
  });

  it("parses tree/branch/subpath (single segment)", () => {
    const r = parseDeploySlug([
      "gh", "vitejs", "vite", "tree", "main", "docs",
    ]);
    expect(r).not.toBeNull();
    expect(r?.branch).toBe("main");
    expect(r?.subpath).toBe("docs");
  });

  it("parses tree/branch/subpath (multi segment)", () => {
    const r = parseDeploySlug([
      "gh", "withastro", "astro", "tree", "main", "examples", "blog",
    ]);
    expect(r).not.toBeNull();
    expect(r?.branch).toBe("main");
    expect(r?.subpath).toBe("examples/blog");
  });

  it("parses a deep nested subpath up to the 10-segment cap", () => {
    const deep = Array.from({ length: 10 }, (_, i) => `d${i}`);
    const r = parseDeploySlug(["gh", "o", "r", "tree", "main", ...deep]);
    expect(r).not.toBeNull();
    expect(r?.subpath).toBe(deep.join("/"));
  });

  it("returns null when subpath depth exceeds the cap", () => {
    const tooDeep = Array.from({ length: 11 }, (_, i) => `d${i}`);
    const r = parseDeploySlug(["gh", "o", "r", "tree", "main", ...tooDeep]);
    expect(r).toBeNull();
  });

  it("returns null when the `tree` literal is missing", () => {
    expect(parseDeploySlug(["gh", "o", "r", "main"])).toBeNull();
    expect(parseDeploySlug(["gh", "o", "r", "src", "main"])).toBeNull();
    expect(parseDeploySlug(["gh", "o", "r", "blob", "main", "file"])).toBeNull();
  });

  it("returns null when `tree` has no branch following", () => {
    expect(parseDeploySlug(["gh", "o", "r", "tree"])).toBeNull();
  });

  it("returns null for invalid branch name", () => {
    expect(parseDeploySlug(["gh", "o", "r", "tree", "bad$branch"])).toBeNull();
    expect(parseDeploySlug(["gh", "o", "r", "tree", ""])).toBeNull();
  });

  it("returns null for invalid subpath segments", () => {
    expect(
      parseDeploySlug(["gh", "o", "r", "tree", "main", "bad$dir"]),
    ).toBeNull();
    expect(
      parseDeploySlug(["gh", "o", "r", "tree", "main", "ok", "bad!"]),
    ).toBeNull();
  });

  it("rejects subpath segments that are all dots (path traversal guard)", () => {
    expect(parseDeploySlug(["gh", "o", "r", "tree", "main", ".."])).toBeNull();
    expect(parseDeploySlug(["gh", "o", "r", "tree", "main", "."])).toBeNull();
    expect(parseDeploySlug(["gh", "o", "r", "tree", "main", "a", ".."])).toBeNull();
    expect(
      parseDeploySlug(["gh", "o", "r", "tree", "main", "..", "secret"]),
    ).toBeNull();
  });

  it("rejects branch that is all dots", () => {
    expect(parseDeploySlug(["gh", "o", "r", "tree", ".."])).toBeNull();
  });
});

describe("buildDeployPath", () => {
  it("round-trips a 3-segment slug", () => {
    const parsed = parseDeploySlug(["gh", "satnaing", "astro-paper"])!;
    expect(buildDeployPath(parsed)).toBe("gh/satnaing/astro-paper");
  });

  it("round-trips a tree/branch slug", () => {
    const parsed = parseDeploySlug(["gh", "vuejs", "docs", "tree", "main"])!;
    expect(buildDeployPath(parsed)).toBe("gh/vuejs/docs/tree/main");
  });

  it("round-trips a tree/branch/subpath slug", () => {
    const parsed = parseDeploySlug([
      "gh", "vitejs", "vite", "tree", "main", "docs",
    ])!;
    expect(buildDeployPath(parsed)).toBe("gh/vitejs/vite/tree/main/docs");
  });

  it("round-trips deep nested subpath", () => {
    const parsed = parseDeploySlug([
      "gh", "withastro", "astro", "tree", "main", "examples", "blog",
    ])!;
    expect(buildDeployPath(parsed)).toBe(
      "gh/withastro/astro/tree/main/examples/blog",
    );
  });
});

describe("PROVIDER_MAP completeness", () => {
  it("maps both short and long forms for every provider", () => {
    const expected = ["gh", "github", "gl", "gitlab", "bb", "bitbucket"];
    for (const key of expected) {
      expect(PROVIDER_MAP[key]).toBeDefined();
    }
  });

  it("both forms of each provider resolve to the same host", () => {
    expect(PROVIDER_MAP.gh.host).toBe(PROVIDER_MAP.github.host);
    expect(PROVIDER_MAP.gl.host).toBe(PROVIDER_MAP.gitlab.host);
    expect(PROVIDER_MAP.bb.host).toBe(PROVIDER_MAP.bitbucket.host);
  });
});
