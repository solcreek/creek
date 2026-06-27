import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeSlug, localProjectName } from "./claim.js";

describe("normalizeSlug", () => {
  it("lowercases and replaces out-of-charset runs with a single hyphen", () => {
    expect(normalizeSlug("Crisp Slack Sync")).toBe("crisp-slack-sync");
    expect(normalizeSlug("My_App@2")).toBe("my-app-2");
  });

  it("trims leading/trailing hyphens and collapses repeats", () => {
    expect(normalizeSlug("--Hello--World--")).toBe("hello-world");
    expect(normalizeSlug("a___b")).toBe("a-b");
  });

  it("leaves an already-valid slug unchanged", () => {
    expect(normalizeSlug("crisp-slack-sync")).toBe("crisp-slack-sync");
  });

  it("strips the reserved -git- infix (server rejects it)", () => {
    expect(normalizeSlug("my-git-app")).toBe("my-app");
    // overlapping occurrences collapse fully
    expect(normalizeSlug("a-git-git-b")).toBe("a-b");
    // a leading/standalone "git" segment isn't the reserved infix — keep it
    expect(normalizeSlug("git-app")).toBe("git-app");
  });

  it("returns empty string when nothing valid remains", () => {
    // Caller falls back to the sandbox id in this case.
    expect(normalizeSlug("@@@")).toBe("");
  });

  it("rejects a sub-2-char result (server requires >= 2 chars)", () => {
    // The caller falls back to the sandbox id rather than send "a".
    expect(normalizeSlug("a")).toBe("");
    expect(normalizeSlug("a!")).toBe("");
    expect(normalizeSlug("ab")).toBe("ab");
  });
});

describe("localProjectName", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "creek-claim-test-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads [project].name from a creek.toml in cwd", () => {
    writeFileSync(join(dir, "creek.toml"), '[project]\nname = "crisp-slack-sync"\n');
    expect(localProjectName(dir)).toBe("crisp-slack-sync");
  });

  it("returns null when there's no creek.toml", () => {
    expect(localProjectName(dir)).toBeNull();
  });

  it("returns null on an unparseable creek.toml rather than throwing", () => {
    writeFileSync(join(dir, "creek.toml"), "this is = not [valid toml");
    expect(localProjectName(dir)).toBeNull();
  });
});
