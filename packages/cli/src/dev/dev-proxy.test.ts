import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import { DevProxy } from "./dev-proxy.js";
import { LocalRealtimeServer } from "./local-realtime.js";

describe("DevProxy", () => {
  let proxy: DevProxy;
  let realtimeServer: LocalRealtimeServer;
  let mockWorkerServer: Server;
  let mockWorkerPort: number;
  let proxyPort: number;

  beforeEach(async () => {
    // Start a mock worker server
    mockWorkerServer = createServer((req, res) => {
      if (req.url === "/api/test") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ worker: true }));
        return;
      }
      res.writeHead(404);
      res.end("Not Found from worker");
    });

    await new Promise<void>((resolve) => {
      mockWorkerServer.listen(0, "127.0.0.1", () => {
        const addr = mockWorkerServer.address();
        mockWorkerPort =
          typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });

    // Start realtime server
    realtimeServer = new LocalRealtimeServer({ port: 0 });
    await realtimeServer.start();

    // Use a random available port for the proxy
    proxyPort = 0;
  });

  afterEach(async () => {
    if (proxy) await proxy.stop();
    await realtimeServer.stop();
    mockWorkerServer.close();
  });

  async function startProxy(
    overrides?: Partial<ConstructorParameters<typeof DevProxy>[0]>,
  ) {
    // Find a free port first
    const tempServer = createServer();
    await new Promise<void>((resolve) => {
      tempServer.listen(0, "127.0.0.1", () => {
        const addr = tempServer.address();
        proxyPort = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
    await new Promise<void>((resolve) => tempServer.close(() => resolve()));

    proxy = new DevProxy({
      port: proxyPort,
      workerUrl: `http://127.0.0.1:${mockWorkerPort}`,
      viteMiddleware: null,
      realtimeServer,
      projectSlug: "my-project",
      ...overrides,
    });
    await proxy.start();
  }

  it("serves /__creek/config with local URLs", async () => {
    await startProxy();

    const res = await fetch(
      `http://127.0.0.1:${proxyPort}/__creek/config`,
    );
    const body = await res.json();

    expect(body.realtimeUrl).toBe(`http://localhost:${proxyPort}`);
    expect(body.projectSlug).toBe("my-project");
    expect(body.wsToken).toBeNull();
  });

  it("proxies /api/* to worker", async () => {
    await startProxy();

    const res = await fetch(`http://127.0.0.1:${proxyPort}/api/test`);
    const body = await res.json();

    expect(body).toEqual({ worker: true });
  });

  it("routes broadcast POST to realtime server", async () => {
    await startProxy();

    const res = await fetch(
      `http://127.0.0.1:${proxyPort}/my-project/rooms/r1/broadcast`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ table: "todos", operation: "INSERT" }),
      },
    );
    const body = await res.json();

    expect(body).toEqual({ ok: true, clients: 0 });
  });

  it("routes WebSocket upgrade to realtime server", async () => {
    await startProxy();

    const ws = await new Promise<WebSocket & { messages: any[] }>(
      (resolve, reject) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${proxyPort}/my-project/rooms/r1/ws`,
        ) as WebSocket & { messages: any[] };
        ws.messages = [];
        ws.on("message", (data) =>
          ws.messages.push(JSON.parse(data.toString())),
        );
        ws.on("open", () => resolve(ws));
        ws.on("error", reject);
      },
    );

    // Wait for peers message
    await new Promise<void>((resolve) => {
      const check = () => {
        if (ws.messages.length >= 1) resolve();
        else ws.on("message", check);
      };
      check();
    });

    expect(ws.messages[0]).toEqual({ type: "peers", count: 1 });

    ws.close();
  });

  it("routes status GET to realtime server", async () => {
    await startProxy();

    const res = await fetch(
      `http://127.0.0.1:${proxyPort}/my-project/rooms/r1/status`,
    );
    const body = await res.json();

    expect(body).toEqual({ clients: 0 });
  });

  it("falls back to worker for non-API, non-Vite paths (worker-only)", async () => {
    await startProxy({ viteMiddleware: null });

    const res = await fetch(`http://127.0.0.1:${proxyPort}/some/path`);
    // Worker returns 404 for unknown paths
    expect(res.status).toBe(404);
  });

  it("returns 404 when no worker and no Vite", async () => {
    await startProxy({ workerUrl: null, viteMiddleware: null });

    const res = await fetch(`http://127.0.0.1:${proxyPort}/anything`);
    expect(res.status).toBe(404);
  });

  it("returns 502 when worker is unreachable", async () => {
    await startProxy({ workerUrl: "http://127.0.0.1:1" }); // port 1 = unlikely

    const res = await fetch(`http://127.0.0.1:${proxyPort}/api/test`);
    expect(res.status).toBe(502);
  });
});
