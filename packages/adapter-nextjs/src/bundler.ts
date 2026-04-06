/**
 * esbuild bundling for Cloudflare Workers.
 *
 * Approach modeled after @opennextjs/cloudflare:
 * - platform: "node" for proper CJS↔ESM handling
 * - Banner imports for timers (avoids frozen ESM namespace issues)
 * - Shim files via alias (no string concatenation)
 * - Post-build __require normalization
 *
 * Requires wrangler >= 4.59.2 (workerd fix for node:timers setImmediate).
 * See: https://github.com/cloudflare/workerd/pull/5869
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { build, type Plugin } from "esbuild";

export interface BundleOptions {
  workerSource: string;
  outputDir: string;
  serverAssets: Map<string, string>;
  wasmFiles: Map<string, string>;
  distDir: string;
  repoRoot: string;
  standaloneDir: string;
}

export async function bundleForWorkers(opts: BundleOptions): Promise<string[]> {
  const entryPath = path.join(opts.outputDir, "__entry.js");
  await fs.writeFile(entryPath, opts.workerSource);

  if (process.env.CREEK_DEBUG) {
    await fs.writeFile(path.join(opts.outputDir, "__entry_debug.js"), opts.workerSource);
  }

  // Resolve paths for module lookup
  const adapterDir = path.dirname(path.dirname(new URL(import.meta.url).pathname));
  const shimsDir = path.join(adapterDir, "src", "shims");
  const nodePaths = [
    path.join(adapterDir, "node_modules"),
    path.join(opts.repoRoot, "node_modules"),
  ];

  try {
    await build({
      entryPoints: [entryPath],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "esnext",
      outfile: path.join(opts.outputDir, "worker.js"),
      splitting: false,
      // Match opennext: minify whitespace+syntax but preserve identifiers
      // (needed for post-build __require normalization)
      minifyWhitespace: true,
      minifySyntax: true,
      minifyIdentifiers: false,
      treeShaking: true,
      nodePaths,
      external: ["cloudflare:*"],
      conditions: ["workerd", "worker", "import"],
      mainFields: ["module", "main"],
      loader: {
        ".wasm": "copy",
        ".json": "json",
      },
      define: {
        __dirname: '""',
        __filename: '""',
      },
      // Import timers at module scope — avoids frozen ESM namespace issue.
      // workerd >= corresponding to wrangler 4.59.2 fixed the setImmediate
      // assignment on node:timers. This banner ensures the symbols are
      // available in scope even if older workerd is used.
      // See: https://github.com/opennextjs/opennextjs-cloudflare/blob/main/packages/cloudflare/src/cli/build/bundle-server.ts
      banner: {
        js: [
          // Provide require() for CJS modules — with fallback for missing optional modules
          'import{createRequire as ___cr}from"node:module";var ___rr=___cr("file:///worker.js");var require=(id)=>{try{return ___rr(id)}catch(e){if(id.includes("instrumentation")||id.includes("telemetry"))return{};throw e}};require.resolve=___rr.resolve;',
          // Import timers at module scope (avoids frozen namespace)
          'import{setInterval,clearInterval,setTimeout,clearTimeout}from"node:timers";',
          // Ensure AsyncLocalStorage is on globalThis — Next.js checks globalThis.AsyncLocalStorage
          'import{AsyncLocalStorage as ___ALS}from"node:async_hooks";if(!globalThis.AsyncLocalStorage)globalThis.AsyncLocalStorage=___ALS;',
          // Capture uncaught exceptions — prevents CF Workers 1101
          'globalThis.__creekLastError=null;',
          'try{process.on("uncaughtException",(e)=>{globalThis.__creekLastError=e;});}catch{}',
          'try{globalThis.addEventListener("unhandledrejection",(e)=>{globalThis.__creekLastError=e.reason;try{e.preventDefault();}catch{}});}catch{}',
          // Polyfill process gaps — CF Workers process is incomplete
          'if(typeof process<"u"){var _p=process;_p.cwd=_p.cwd||(()=>"/");_p.chdir=_p.chdir||(()=>{});_p.umask=_p.umask||(()=>0);_p.on=_p.on||(()=>_p);_p.off=_p.off||(()=>_p);_p.once=_p.once||(()=>_p);_p.emit=_p.emit||(()=>false);_p.listeners=_p.listeners||(()=>[]);_p.removeAllListeners=_p.removeAllListeners||(()=>_p);_p.removeListener=_p.removeListener||(()=>_p);_p.addListener=_p.addListener||(()=>_p);_p.prependListener=_p.prependListener||(()=>_p);_p.prependOnceListener=_p.prependOnceListener||(()=>_p);_p.eventNames=_p.eventNames||(()=>[]);}',
        ].join(""),
      },
      // Alias unused/problematic modules to shims (like opennext)
      alias: {
        // fs shim — CF Workers doesn't have node:fs.
        "fs": path.join(shimsDir, "fs.js"),
        "node:fs": path.join(shimsDir, "fs.js"),
        "node:fs/promises": path.join(shimsDir, "fs.js"),
        // http shim — provides IncomingMessage/ServerResponse
        "http": path.join(shimsDir, "http.js"),
        "node:http": path.join(shimsDir, "http.js"),
        // Unused modules → empty shim
        "next/dist/compiled/ws": path.join(shimsDir, "empty.js"),
        "next/dist/compiled/edge-runtime": path.join(shimsDir, "empty.js"),
        "@next/env": path.join(shimsDir, "env.js"),
        "next/dist/server/node-environment-extensions/fast-set-immediate.external":
          path.join(shimsDir, "fast-set-immediate.js"),
      },
      logLevel: "warning",
      plugins: [nextServerPlugin()],
    });
  } finally {
    await fs.rm(entryPath, { force: true });
  }

  // Post-build: normalize __require → require (same as opennext)
  // esbuild generates __require / __require2 for CJS interop; workerd
  // needs plain require (provided by nodejs_compat).
  await normalizeRequire(path.join(opts.outputDir, "worker.js"));

  // Copy WASM files alongside the bundle
  for (const [name, absPath] of opts.wasmFiles) {
    await fs.copyFile(absPath, path.join(opts.outputDir, name));
  }

  const files = await fs.readdir(opts.outputDir);
  return files.filter((f) => !f.startsWith("__"));
}

/**
 * Normalize esbuild's __require variants back to require.
 * CF Workers with nodejs_compat provides require() at runtime.
 * Matches opennext's updateWorkerBundledCode approach.
 */
async function normalizeRequire(filePath: string): Promise<void> {
  let code = await fs.readFile(filePath, "utf-8");
  const before = code;

  code = code.replace(/__require\d?\(/g, "require(");
  code = code.replace(/__require\d?\./g, "require.");

  if (code !== before) {
    await fs.writeFile(filePath, code);
  }
}

/**
 * esbuild plugin for Next.js server compatibility.
 */
function nextServerPlugin(): Plugin {
  return {
    name: "creek-nextjs-server",
    setup(build) {
      // Trace metadata files — not needed at runtime
      build.onResolve({ filter: /\.nft\.json$/ }, () => ({ external: true }));

      // sharp — CF Workers uses CF Image Resizing instead
      build.onResolve({ filter: /^sharp$/ }, () => ({ external: true }));

      const shimsDir = path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), "src", "shims");

      // load-manifest.external — uses fs.readFileSync. Replace with
      // shim that reads from globalThis.__MANIFESTS (embedded at build).
      build.onResolve({ filter: /load-manifest\.external/ }, () => ({
        path: path.join(shimsDir, "load-manifest.js"),
      }));

      // node-fs-methods — fs wrappers used by incremental cache.
      // CF Workers doesn't have fs. Return no-op stubs.
      build.onLoad({ filter: /node-fs-methods\.js$/ }, () => ({
        contents: `
          export const nodeFs = {
            existsSync: () => false,
            readFileSync: () => "",
            writeFileSync: () => {},
            mkdirSync: () => {},
            unlinkSync: () => {},
            readdirSync: () => [],
            statSync: () => ({ isFile: () => false, isDirectory: () => false, mtime: new Date(0) }),
          };
          export default nodeFs;
        `,
        loader: "js",
      }));

      // fast-set-immediate.external — tries to assign to frozen
      // node:timers/promises ESM namespace. Replace with no-op shim.
      build.onLoad(
        { filter: /fast-set-immediate\.external\.js$/ },
        () => ({ contents: "export function install() {}", loader: "js" }),
      );

      // require-hook.js — patches Module.prototype.require for webpack.
      // Not needed in bundled CF Workers (all modules are already resolved).
      build.onLoad(
        { filter: /require-hook\.js$/ },
        (args) => {
          if (args.path.includes("next/dist/server/")) {
            return {
              contents: 'module.exports = { defaultOverrides: {}, hookPropertyMap: new Map(), addHookAliases: () => {} };',
              loader: "js",
            };
          }
          return undefined;
        },
      );

      // Shim ALL node-environment-extensions — they use Node APIs
      // (node:inspector, node:fs, process.*, etc.) not available in CF Workers.
      // DON'T shim node-environment.js itself — it sets up AsyncLocalStorage.
      build.onLoad(
        { filter: /node-environment-extensions\/.*\.js$/ },
        () => ({ contents: "export default {}; export function install() {}", loader: "js" }),
      );
      // setup-node-env.external loads node-environment + require-hook +
      // node-polyfill-crypto. We replace with a minimal version that only
      // ensures ALS is on globalThis (already done by banner), skipping
      // the extensions that use unavailable Node APIs.
      build.onLoad(
        { filter: /setup-node-env\.external\.js$/ },
        () => ({ contents: "/* shimmed — ALS set up by banner */", loader: "js" }),
      );
    },
  };
}
