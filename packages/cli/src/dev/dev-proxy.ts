// Dev proxy server for `creek dev`.
//
// Single user-facing HTTP server that routes:
//   /__creek/config       → local config response
//   /{slug}/**/broadcast  → realtime server (HTTP)
//   /{slug}/**/ws         → realtime server (WebSocket upgrade)
//   /api/*, /__creek/*    → worker (Miniflare)
//   everything else       → Vite (HMR) or worker (if no Vite)

import {
  createServer,
  request as httpRequest,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import {
  parseRealtimePath,
  type LocalRealtimeServer,
} from "./local-realtime.js";

// Use a minimal type for Vite's middleware to avoid hard vite dependency at compile time
type ConnectServer = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => void;

export interface DevProxyOptions {
  /** User-facing port. */
  port: number;
  /** Miniflare worker URL (e.g. "http://127.0.0.1:8787"). Null if no worker. */
  workerUrl: string | null;
  /** Vite middleware. Null if no Vite (worker-only project). */
  viteMiddleware: ConnectServer | null;
  /** Local realtime server instance. */
  realtimeServer: LocalRealtimeServer;
  /** Project slug. */
  projectSlug: string;
}

export class DevProxy {
  private server: Server | null = null;
  private options: DevProxyOptions;

  constructor(options: DevProxyOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    const { port, workerUrl, viteMiddleware, realtimeServer, projectSlug } =
      this.options;

    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);

      // 1. /__creek/config → local config
      if (url.pathname === "/__creek/config" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            realtimeUrl: `http://localhost:${port}`,
            projectSlug,
            wsToken: null,
          }),
        );
        return;
      }

      // 2. Realtime broadcast: POST /{slug}/**/broadcast
      const route = parseRealtimePath(url.pathname);
      if (route && route.action === "/broadcast" && req.method === "POST") {
        realtimeServer.handleBroadcast(req, res);
        return;
      }

      // 3. Realtime status: GET /{slug}/**/status
      if (route && route.action === "/status" && req.method === "GET") {
        realtimeServer.handleStatus(req, res);
        return;
      }

      // 4. API/worker routes → proxy to Miniflare
      if (workerUrl && isWorkerRoute(url.pathname)) {
        proxyToWorker(req, res, workerUrl);
        return;
      }

      // 5. Everything else → Vite middleware or worker fallback
      if (viteMiddleware) {
        viteMiddleware(req, res, () => {
          // If Vite doesn't handle it and we have a worker, try worker
          if (workerUrl) {
            proxyToWorker(req, res, workerUrl);
          } else {
            res.writeHead(404);
            res.end("Not Found");
          }
        });
        return;
      }

      // No Vite — all traffic to worker
      if (workerUrl) {
        proxyToWorker(req, res, workerUrl);
        return;
      }

      res.writeHead(404);
      res.end("Not Found");
    });

    // WebSocket upgrade routing
    this.server.on("upgrade", (req, socket: Socket, head) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      const route = parseRealtimePath(url.pathname);

      // Realtime WebSocket: /{slug}/**/ws
      if (route && route.action === "/ws") {
        realtimeServer.handleUpgrade(req, socket, head);
        return;
      }

      // Vite HMR WebSocket — pass through to Vite middleware
      if (viteMiddleware) {
        // Vite's middleware handles WebSocket upgrades via the http server's
        // upgrade event. We need to let Vite handle it. Vite listens on the
        // same server's upgrade event, so we should NOT destroy the socket.
        // The Vite server is in middleware mode and registered its own
        // upgrade handler already. We just don't interfere.
        return;
      }

      socket.destroy();
    });

    return new Promise((resolve, reject) => {
      this.server!.on("error", reject);
      this.server!.listen(port, "127.0.0.1", () => resolve());
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
        this.server = null;
      } else {
        resolve();
      }
    });
  }

  /** Get the underlying HTTP server (for Vite HMR upgrade). */
  getServer(): Server | null {
    return this.server;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isWorkerRoute(pathname: string): boolean {
  return (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/__creek/") ||
    pathname === "/__creek"
  );
}

function proxyToWorker(
  req: IncomingMessage,
  res: ServerResponse,
  workerUrl: string,
): void {
  const { hostname, port } = new URL(workerUrl);

  const proxyReq = httpRequest(
    {
      hostname,
      port,
      path: req.url,
      method: req.method,
      headers: req.headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on("error", () => {
    res.writeHead(502);
    res.end("Worker unavailable");
  });

  req.pipe(proxyReq);
}
