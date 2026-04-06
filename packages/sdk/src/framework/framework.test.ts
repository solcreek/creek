import { describe, test, expect } from "vitest";
import {
  detectFramework,
  getDefaultBuildOutput,
  getSSRServerEntry,
  getClientAssetsDir,
} from "./index.js";

describe("detectFramework", () => {
  test("detects Next.js", () => {
    expect(detectFramework({ dependencies: { next: "14.0.0" } })).toBe("nextjs");
  });

  test("detects TanStack Start", () => {
    expect(
      detectFramework({ dependencies: { "@tanstack/react-start": "1.0.0" } }),
    ).toBe("tanstack-start");
  });

  test("detects React Router", () => {
    expect(detectFramework({ dependencies: { "react-router": "7.0.0" } })).toBe(
      "react-router",
    );
  });

  test("detects SvelteKit", () => {
    expect(
      detectFramework({ devDependencies: { "@sveltejs/kit": "2.0.0" } }),
    ).toBe("sveltekit");
  });

  test("detects SolidStart", () => {
    expect(
      detectFramework({ dependencies: { "@solidjs/start": "1.0.0" } }),
    ).toBe("solidstart");
  });

  test("detects Nuxt", () => {
    expect(detectFramework({ dependencies: { nuxt: "3.0.0" } })).toBe("nuxt");
  });

  test("detects Vite + React as vite-react", () => {
    expect(
      detectFramework({ dependencies: { vite: "5.0.0", react: "18.0.0" } }),
    ).toBe("vite-react");
  });

  test("detects Vite + Vue as vite-vue", () => {
    expect(
      detectFramework({ dependencies: { vite: "5.0.0", vue: "3.0.0" } }),
    ).toBe("vite-vue");
  });

  test("detects Vite + Svelte as vite-svelte", () => {
    expect(
      detectFramework({ dependencies: { vite: "5.0.0", svelte: "4.0.0" } }),
    ).toBe("vite-svelte");
  });

  test("detects Vite + Solid as vite-solid", () => {
    expect(
      detectFramework({ dependencies: { vite: "5.0.0", "solid-js": "1.0.0" } }),
    ).toBe("vite-solid");
  });

  test("returns null for unknown deps", () => {
    expect(detectFramework({ dependencies: { express: "4.0.0" } })).toBeNull();
  });

  test("returns null for empty package.json", () => {
    expect(detectFramework({})).toBeNull();
  });

  test("SSR framework takes priority over vite SPA", () => {
    // Next.js project also has vite + react — should detect as nextjs
    expect(
      detectFramework({
        dependencies: { next: "14.0.0", vite: "5.0.0", react: "18.0.0" },
      }),
    ).toBe("nextjs");
  });

  test("uses devDependencies too", () => {
    expect(
      detectFramework({
        dependencies: {},
        devDependencies: { next: "14.0.0" },
      }),
    ).toBe("nextjs");
  });
});

describe("getDefaultBuildOutput", () => {
  test("nextjs -> .open-next", () => {
    expect(getDefaultBuildOutput("nextjs")).toBe(".open-next");
  });

  test("react-router -> build/client", () => {
    expect(getDefaultBuildOutput("react-router")).toBe("build/client");
  });

  test("vite-react -> dist", () => {
    expect(getDefaultBuildOutput("vite-react")).toBe("dist");
  });

  test("null -> dist", () => {
    expect(getDefaultBuildOutput(null)).toBe("dist");
  });
});

describe("getSSRServerEntry", () => {
  test("SSR frameworks return an entry path", () => {
    expect(getSSRServerEntry("nextjs")).toBe("worker.js");
    expect(getSSRServerEntry("tanstack-start")).toBe("server/server.js");
    expect(getSSRServerEntry("react-router")).toBe("../server/index.js");
    expect(getSSRServerEntry("sveltekit")).toBe("../server/index.js");
    expect(getSSRServerEntry("nuxt")).toBe("../server/index.mjs");
    expect(getSSRServerEntry("solidstart")).toBe("../server/index.mjs");
  });

  test("SPA frameworks return null", () => {
    expect(getSSRServerEntry("vite-react")).toBeNull();
    expect(getSSRServerEntry("vite-vue")).toBeNull();
    expect(getSSRServerEntry(null)).toBeNull();
  });
});

describe("getClientAssetsDir", () => {
  test("nextjs -> assets", () => {
    expect(getClientAssetsDir("nextjs")).toBe("assets");
  });

  test("tanstack-start -> client", () => {
    expect(getClientAssetsDir("tanstack-start")).toBe("client");
  });

  test("most frameworks return null (root)", () => {
    expect(getClientAssetsDir("react-router")).toBeNull();
    expect(getClientAssetsDir("sveltekit")).toBeNull();
    expect(getClientAssetsDir("vite-react")).toBeNull();
  });
});
