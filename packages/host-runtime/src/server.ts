import { isAbsolute, resolve } from "node:path";
import { createEnv, type BindingsConfig } from "./env.ts";

export type ExecutionContextLike = {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
};

export type WorkerModule = {
  default: {
    fetch: (
      request: Request,
      env: Record<string, unknown>,
      ctx: ExecutionContextLike,
    ) => Response | Promise<Response>;
  };
};

export type RunOptions = {
  entry: string;
  bindings: BindingsConfig;
  port?: number;
  hostname?: string;
};

export type RunHandle = {
  stop: () => void;
  url: string;
  port: number;
};

export async function run(opts: RunOptions): Promise<RunHandle> {
  const { entry, bindings, port = 8787, hostname = "0.0.0.0" } = opts;

  const absPath = isAbsolute(entry) ? entry : resolve(process.cwd(), entry);
  const mod = (await import(absPath)) as WorkerModule;
  if (!mod.default?.fetch) {
    throw new Error(
      `Module ${entry} must export default with a fetch handler:\n\n` +
        `  export default {\n` +
        `    async fetch(req, env, ctx) { ... }\n` +
        `  }`,
    );
  }

  const env = createEnv(bindings);

  const pending = new Set<Promise<unknown>>();
  const ctx: ExecutionContextLike = {
    waitUntil(promise) {
      pending.add(promise);
      promise.finally(() => pending.delete(promise));
    },
    passThroughOnException() {
      // M1 stub — CF Workers semantics not needed in dev
    },
  };

  const userFetch = mod.default.fetch;

  const server = Bun.serve({
    port,
    hostname,
    async fetch(req) {
      try {
        return await userFetch(req, env, ctx);
      } catch (err) {
        const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
        console.error("[creek] handler error:", message);
        return new Response(JSON.stringify({ error: "Internal Error", detail: message }, null, 2), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    },
  });

  const displayHost = hostname === "0.0.0.0" ? "localhost" : hostname;
  const actualPort = server.port ?? port;
  return {
    stop: () => server.stop(),
    url: `http://${displayHost}:${actualPort}`,
    port: actualPort,
  };
}
