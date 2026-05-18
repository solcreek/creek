import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin, ViteDevServer } from 'vite';
import {
  createEnv,
  type BindingsConfig,
  type ExecutionContextLike,
} from '@solcreek/host-runtime';

export type CreekVitePluginOptions = {
  /** Path to the user's worker entry, relative to the Vite root. */
  entry: string;
  /** Binding map. */
  bindings: BindingsConfig;
  /**
   * Path prefixes that should be routed to the worker. Anything not
   * matching is passed through to Vite's normal handling (static, HMR,
   * SSR, etc.).
   *
   * If a prefix is `'/'`, every request that hasn't already been served
   * by Vite's own asset / HMR endpoints reaches the worker — useful for
   * SSR-style handlers. The plugin still excludes Vite internal paths
   * (`/@vite/`, `/@id/`, `/@fs/`, `/src/`, `/node_modules/`) automatically.
   *
   * Default: `['/api']`.
   */
  routes?: string[];
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

const VITE_INTERNAL_PREFIXES = [
  '/@vite/',
  '/@id/',
  '/@fs/',
  '/@react-refresh',
  '/src/',
  '/node_modules/',
  '/__inspect',
  '/__open-in-editor',
];

function isViteInternal(url: string): boolean {
  for (const p of VITE_INTERNAL_PREFIXES) {
    if (url.startsWith(p)) return true;
  }
  return false;
}

const CF_WORKERS_MODULE = 'cloudflare:workers';
const CF_WORKERS_SHIM = `
// @solcreek/vite-plugin shim for "cloudflare:workers" (PoC M3).
// Re-exports the minimum surface so worker code that uses
// 'cloudflare:workers' imports loads under Vite + Bun.
export const env = new Proxy({}, {
  get(_target, prop) {
    throw new Error(
      \`cloudflare:workers env.\${String(prop)} is not available outside a request scope. \` +
      \`Use the env argument passed to your fetch handler instead.\`
    );
  },
});
export class WorkerEntrypoint {
  constructor(public ctx, public env) {}
}
export class DurableObject {
  constructor(public state, public env) {}
}
`;

export function creek(opts: CreekVitePluginOptions): Plugin {
  const routes = opts.routes ?? ['/api'];
  let env: Record<string, unknown> | null = null;

  return {
    name: '@solcreek/vite-plugin',

    // Provide a synthetic 'cloudflare:workers' module so worker source
    // written against the CF Workers runtime loads under Vite + Bun.
    resolveId(id) {
      if (id === CF_WORKERS_MODULE) {
        return `\0${CF_WORKERS_MODULE}`;
      }
      return null;
    },
    load(id) {
      if (id === `\0${CF_WORKERS_MODULE}`) {
        return CF_WORKERS_SHIM;
      }
      return null;
    },

    configureServer(server) {
      env = createEnv(opts.bindings);

      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? '/';

        // Never intercept Vite's own asset / HMR / source endpoints,
        // even if the user configured a catch-all route.
        if (isViteInternal(url)) return next();
        if (!matchesRoute(url, routes)) return next();

        try {
          // HMR-aware load. Vite re-evaluates the module on file change.
          const mod = (await server.ssrLoadModule(opts.entry)) as WorkerModule;
          if (!mod.default?.fetch) {
            return failWithError(
              res,
              500,
              `Worker entry "${opts.entry}" must export default with a fetch handler.`,
            );
          }

          const webRequest = nodeRequestToWeb(req);
          const ctx = makeCtx();
          const response = await mod.default.fetch(webRequest, env!, ctx);
          await writeWebResponse(res, response);
        } catch (err) {
          handleError(server, res, err);
        }
      });
    },
  };
}

function matchesRoute(url: string, routes: string[]): boolean {
  for (const r of routes) {
    if (r === '/') return true;
    if (url === r || url.startsWith(r + '/') || url.startsWith(r + '?')) {
      return true;
    }
  }
  return false;
}

function nodeRequestToWeb(req: IncomingMessage): Request {
  const host = req.headers.host ?? 'localhost';
  const url = `http://${host}${req.url ?? '/'}`;
  const method = req.method ?? 'GET';
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      for (const item of v) headers.append(k, item);
    } else {
      headers.set(k, v);
    }
  }
  const hasBody = method !== 'GET' && method !== 'HEAD';
  return new Request(url, {
    method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream) : null,
    duplex: hasBody ? 'half' : undefined,
  } as RequestInit);
}

async function writeWebResponse(
  res: ServerResponse,
  response: Response,
): Promise<void> {
  res.statusCode = response.status;

  // Set-Cookie must be appended per-value (Web Headers concatenates them
  // with a comma, which corrupts cookie attributes). All other headers go
  // through setHeader().
  const setCookies =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [];
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') return;
    res.setHeader(key, value);
  });
  for (const cookie of setCookies) {
    res.appendHeader('Set-Cookie', cookie);
  }

  if (!response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } finally {
    reader.releaseLock();
    res.end();
  }
}

function makeCtx(): ExecutionContextLike {
  const pending = new Set<Promise<unknown>>();
  return {
    waitUntil(promise) {
      pending.add(promise);
      promise.finally(() => pending.delete(promise));
    },
    passThroughOnException() {
      // dev stub
    },
  };
}

function handleError(
  server: ViteDevServer,
  res: ServerResponse,
  err: unknown,
): void {
  // Rewrite stack traces to point at original source files in dev.
  if (err instanceof Error) {
    server.ssrFixStacktrace(err);
  }
  const message =
    err instanceof Error ? err.stack ?? err.message : String(err);
  server.config.logger.error(`[creek] handler error: ${message}`);
  failWithError(res, 500, message);
}

function failWithError(
  res: ServerResponse,
  status: number,
  detail: string,
): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'Internal Error', detail }, null, 2));
}
