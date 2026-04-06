import { build } from "esbuild";

/**
 * Bundle an SSR server entry point into a single standalone worker script.
 * Uses esbuild (same bundler as wrangler) with node: builtins as externals.
 */
export async function bundleSSRServer(entryPoint: string): Promise<string> {
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    write: false,
    minify: false,
    external: [
      "node:async_hooks",
      "node:stream",
      "node:stream/web",
      "node:buffer",
      "node:util",
      "node:events",
      "node:crypto",
      "node:path",
      "node:url",
      "node:string_decoder",
      "node:diagnostics_channel",
      "node:process",
      "node:fs",
      "node:os",
      "node:child_process",
      "node:http",
      "node:https",
      "node:net",
      "node:tls",
      "node:zlib",
      "node:perf_hooks",
      "node:worker_threads",
    ],
    conditions: ["workerd", "worker", "import"],
    mainFields: ["module", "main"],
    logLevel: "warning",
  });

  if (result.errors.length > 0) {
    throw new Error(`esbuild: ${result.errors.map((e) => e.text).join(", ")}`);
  }

  return result.outputFiles[0].text;
}
