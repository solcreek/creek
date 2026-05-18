#!/usr/bin/env bun
//
// creekd — multi-app daemon (PoC M3)
//
// HTTP server with:
//   - /__creek/apps  POST    deploy a new app
//   - /__creek/apps  GET     list deployed apps
//   - /__creek/apps/:id  DELETE  undeploy
//   - any other path: routed to the worker selected by X-Creek-App header
//     (falls back to ?app=<id> query, or the single deployed app)
//
// All apps share the daemon's Bun process. Isolation is *path-level only*:
// each app gets its own data directory and its own binding instances. A
// crashing app crashes the daemon. That's acceptable for a PoC; real
// isolation is Phase 1 production work.

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  createEnv,
  type BindingsConfig,
  type BindingSpec,
  type ExecutionContextLike,
} from '@solcreek/host-runtime';

const APPS_DIR = resolve(process.env.CREEK_APPS_DIR ?? './.creek/apps');
const PORT = Number(process.env.CREEK_PORT ?? 8080);

type DeployBody = {
  id: string;
  entry: string;
  files: Record<string, string>;
  bindings: BindingsConfig;
};

type LoadedApp = {
  id: string;
  entryPath: string;
  env: Record<string, unknown>;
  module: WorkerModule;
  bindings: BindingsConfig;
};

type WorkerModule = {
  default: {
    fetch: (
      request: Request,
      env: Record<string, unknown>,
      ctx: ExecutionContextLike,
    ) => Response | Promise<Response>;
  };
};

const apps = new Map<string, LoadedApp>();

function rewriteBinding(
  spec: BindingSpec,
  appDir: string,
  name: string,
): BindingSpec {
  switch (spec.type) {
    case 'database':
      return {
        type: 'database',
        path: join(appDir, 'database', `${spec.path || name}.db`),
      };
    case 'cache':
      return {
        type: 'cache',
        path: join(appDir, 'cache', `${spec.path || name}.db`),
      };
    case 'storage':
      return {
        type: 'storage',
        path: join(appDir, 'storage', spec.path || name),
      };
    case 'assets':
      return {
        type: 'assets',
        dir: join(appDir, spec.dir),
      };
  }
}

async function deploy(body: DeployBody): Promise<{ id: string; url: string }> {
  if (!body.id || !/^[a-z0-9][a-z0-9._-]*$/i.test(body.id)) {
    throw new Error(
      `Invalid app id: "${body.id}". Use [a-z0-9._-]+ starting with alphanumeric.`,
    );
  }
  if (!body.entry || !body.files[body.entry]) {
    throw new Error(`entry "${body.entry}" must be one of the uploaded files.`);
  }

  const appDir = join(APPS_DIR, body.id);
  await rm(appDir, { recursive: true, force: true });
  await mkdir(appDir, { recursive: true });

  for (const [filename, b64] of Object.entries(body.files)) {
    const filePath = join(appDir, filename);
    if (!filePath.startsWith(appDir)) {
      throw new Error(`unsafe file path: ${filename}`);
    }
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, Buffer.from(b64, 'base64'));
  }

  const rewritten: BindingsConfig = {};
  for (const [name, spec] of Object.entries(body.bindings)) {
    rewritten[name] = rewriteBinding(spec, appDir, name);
  }

  const entryPath = join(appDir, body.entry);
  const env = createEnv(rewritten);
  // Cache-buster lets re-deploys pick up new code.
  const mod = (await import(`${entryPath}?t=${Date.now()}`)) as WorkerModule;
  if (!mod.default?.fetch) {
    throw new Error(`Entry "${body.entry}" must export default with a fetch handler`);
  }

  apps.set(body.id, {
    id: body.id,
    entryPath,
    env,
    module: mod,
    bindings: rewritten,
  });

  console.log(`[creekd] deployed app "${body.id}" (${Object.keys(body.files).length} files)`);

  return {
    id: body.id,
    url: `http://localhost:${PORT}/?app=${body.id}`,
  };
}

function undeploy(id: string): boolean {
  const had = apps.delete(id);
  if (had) console.log(`[creekd] undeployed app "${id}"`);
  return had;
}

function makeCtx(): ExecutionContextLike {
  const pending = new Set<Promise<unknown>>();
  return {
    waitUntil(promise) {
      pending.add(promise);
      promise.finally(() => pending.delete(promise));
    },
    passThroughOnException() {},
  };
}

function selectApp(req: Request, url: URL): string | null {
  const fromHeader = req.headers.get('x-creek-app');
  if (fromHeader) return fromHeader;
  const fromQuery = url.searchParams.get('app');
  if (fromQuery) return fromQuery;
  if (apps.size === 1) return [...apps.keys()][0]!;
  return null;
}

async function adminHandler(req: Request, url: URL): Promise<Response | null> {
  const path = url.pathname;

  if (path === '/__creek/apps' && req.method === 'POST') {
    try {
      const body = (await req.json()) as DeployBody;
      const result = await deploy(body);
      return Response.json(result, { status: 201 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ error: msg }, { status: 400 });
    }
  }

  if (path === '/__creek/apps' && req.method === 'GET') {
    return Response.json({
      apps: [...apps.values()].map((a) => ({
        id: a.id,
        entry: a.entryPath,
        bindings: Object.keys(a.bindings),
      })),
    });
  }

  const m = path.match(/^\/__creek\/apps\/([^/]+)$/);
  if (m && req.method === 'DELETE') {
    return undeploy(m[1]!)
      ? new Response(null, { status: 204 })
      : Response.json({ error: 'not found' }, { status: 404 });
  }

  if (path === '/__creek/health' && req.method === 'GET') {
    return Response.json({ ok: true, apps: apps.size });
  }

  return null;
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname.startsWith('/__creek/')) {
    const adminResp = await adminHandler(req, url);
    if (adminResp) return adminResp;
    return new Response('Not Found', { status: 404 });
  }

  const appId = selectApp(req, url);
  if (!appId) {
    return Response.json(
      {
        error:
          'No app selected. Set X-Creek-App: <id> header or ?app=<id> query.',
        availableApps: [...apps.keys()],
      },
      { status: 400 },
    );
  }

  const app = apps.get(appId);
  if (!app) {
    return Response.json(
      { error: `App not found: ${appId}`, availableApps: [...apps.keys()] },
      { status: 404 },
    );
  }

  try {
    return await app.module.default.fetch(req, app.env, makeCtx());
  } catch (err) {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error(`[creekd] handler error in "${appId}":`, msg);
    return Response.json({ error: msg }, { status: 500 });
  }
}

async function main(): Promise<void> {
  await mkdir(APPS_DIR, { recursive: true });

  const server = Bun.serve({
    port: PORT,
    hostname: '0.0.0.0',
    fetch: handle,
  });

  console.log(`[creekd] listening on http://localhost:${server.port}`);
  console.log(`[creekd]   apps dir: ${APPS_DIR}`);
  console.log(`[creekd]   admin:    /__creek/apps  /__creek/health`);
  console.log(`[creekd]   routing:  X-Creek-App: <id> header or ?app=<id>`);

  const shutdown = () => {
    console.log('\n[creekd] shutting down');
    server.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[creekd] fatal:', err);
  process.exit(1);
});
