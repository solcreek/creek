import { describe, test, expect } from "vitest";
import { shortDeployId, sanitizeBranch, buildSpaWorker } from "./deploy.js";

describe("shortDeployId", () => {
  test("returns first 8 chars", () => {
    expect(shortDeployId("abcdef12-3456-7890-abcd-ef1234567890")).toBe("abcdef12");
  });

  test("handles short input", () => {
    expect(shortDeployId("abc")).toBe("abc");
  });
});

describe("sanitizeBranch", () => {
  test("simple branch name passes through", () => {
    expect(sanitizeBranch("main")).toBe("main");
    expect(sanitizeBranch("dev")).toBe("dev");
  });

  test("lowercases", () => {
    expect(sanitizeBranch("Feature-ABC")).toBe("feature-abc");
  });

  test("replaces slashes with hyphens", () => {
    expect(sanitizeBranch("feature/my-feature")).toBe("feature-my-feature");
  });

  test("strips non-alphanumeric/hyphen chars", () => {
    expect(sanitizeBranch("fix_bug#123")).toBe("fixbug123");
  });

  test("collapses consecutive hyphens", () => {
    expect(sanitizeBranch("a//b///c")).toBe("a-b-c");
  });

  test("strips leading and trailing hyphens", () => {
    expect(sanitizeBranch("-leading-")).toBe("leading");
    expect(sanitizeBranch("/trailing/")).toBe("trailing");
  });

  test("truncates to 27 chars", () => {
    const long = "a".repeat(50);
    expect(sanitizeBranch(long).length).toBe(27);
  });

  test("handles realistic branch names", () => {
    expect(sanitizeBranch("feature/PROJ-123/add-auth")).toBe("feature-proj-123-add-auth");
    expect(sanitizeBranch("dependabot/npm_and_yarn/lodash-4.17.21")).toBe("dependabot-npmandyarn-lodas");
    expect(sanitizeBranch("renovate/react-19.x")).toBe("renovate-react-19x");
  });
});

describe("buildSpaWorker", () => {
  test("embeds index.html content into worker script", () => {
    const html = "<html><body>Hello</body></html>";
    const content = new TextEncoder().encode(html).buffer;
    const { workerFiles, mainModule } = buildSpaWorker(content);

    expect(mainModule).toBe("worker.mjs");
    expect(workerFiles).toHaveLength(1);
    expect(workerFiles[0].name).toBe("worker.mjs");
    expect(workerFiles[0].size).toBeGreaterThan(0);
  });

  test("uses fallback HTML when no index.html provided", () => {
    const { workerFiles, mainModule } = buildSpaWorker(undefined);

    expect(mainModule).toBe("worker.mjs");
    expect(workerFiles).toHaveLength(1);
  });

  test("worker file has correct MIME type", () => {
    const { workerFiles } = buildSpaWorker(undefined);
    expect(workerFiles[0].type).toBe("application/javascript+module");
  });
});
