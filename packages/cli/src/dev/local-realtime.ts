// Local realtime server for `creek dev`.
//
// Replaces the production Durable Object realtime service (rt.creek.dev)
// with a lightweight Node.js WebSocket server. Same URL routing and
// message format — client code works unchanged.

import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { WebSocketServer, WebSocket } from "ws";

// ─── URL Routing ──────────────────────────────────────────────────────────────
// Copied from packages/realtime-worker/src/parse.ts (pure functions).
// We copy instead of importing to avoid pulling CF-typed package into Node.js.

export interface RealtimeRoute {
  slug: string;
  roomId: string | null;
  action: string; // "/broadcast" | "/ws" | "/status"
}

const VALID_ACTIONS = new Set(["/broadcast", "/ws", "/status"]);

export function parseRealtimePath(pathname: string): RealtimeRoute | null {
  const parts = pathname.split("/").filter(Boolean);

  if (parts.length < 2) return null;

  const slug = parts[0];

  // Room-scoped: /{slug}/rooms/{roomId}/{action}
  if (parts[1] === "rooms") {
    if (parts.length < 4) return null;
    const roomId = parts[2];
    const action = "/" + parts[3];
    if (!VALID_ACTIONS.has(action)) return null;
    if (!roomId) return null;
    return { slug, roomId, action };
  }

  // Project-wide (legacy): /{slug}/{action}
  const action = "/" + parts.slice(1).join("/");
  if (!VALID_ACTIONS.has(action)) return null;
  return { slug, roomId: null, action };
}

export function getDoName(route: RealtimeRoute): string {
  return route.roomId ? `${route.slug}:${route.roomId}` : route.slug;
}

// ─── LocalRealtimeServer ──────────────────────────────────────────────────────

export class LocalRealtimeServer {
  private httpServer: Server | null = null;
  private wss: WebSocketServer | null = null;
  private rooms = new Map<string, Set<WebSocket>>();
  private port: number;

  constructor(options?: { port?: number }) {
    this.port = options?.port ?? 0; // 0 = OS auto-assign
  }

  async start(): Promise<{ port: number }> {
    this.httpServer = createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true });

    this.httpServer.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = parseRealtimePath(url.pathname);

      if (!route || route.action !== "/ws") {
        socket.destroy();
        return;
      }

      this.wss!.handleUpgrade(req, socket as any, head, (ws) => {
        const roomKey = getDoName(route);
        this.addToRoom(roomKey, ws);
      });
    });

    return new Promise((resolve, reject) => {
      this.httpServer!.on("error", reject);
      this.httpServer!.listen(this.port, "127.0.0.1", () => {
        const addr = this.httpServer!.address();
        if (typeof addr === "object" && addr) {
          this.port = addr.port;
        }
        resolve({ port: this.port });
      });
    });
  }

  async stop(): Promise<void> {
    // Close all WebSocket connections
    for (const [, room] of this.rooms) {
      for (const ws of room) {
        ws.close(1001, "Server shutting down");
      }
    }
    this.rooms.clear();

    // Close WebSocket server
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    // Close HTTP server
    return new Promise((resolve) => {
      if (this.httpServer) {
        this.httpServer.close(() => resolve());
        this.httpServer = null;
      } else {
        resolve();
      }
    });
  }

  /** Broadcast a message to all connected clients in a room. */
  broadcast(roomKey: string, message: object): void {
    const room = this.rooms.get(roomKey);
    if (!room) return;
    const data = JSON.stringify(message);
    for (const ws of room) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  /** Get the number of connected clients in a room. */
  getRoomCount(roomKey: string): number {
    return this.rooms.get(roomKey)?.size ?? 0;
  }

  /** Get the port the server is listening on. */
  getPort(): number {
    return this.port;
  }

  /** @internal — inject a mock WebSocket into a room for testing. */
  _testAddSocket(roomKey: string, ws: WebSocket): void {
    let room = this.rooms.get(roomKey);
    if (!room) {
      room = new Set();
      this.rooms.set(roomKey, room);
    }
    room.add(ws);
  }

  // ─── Public handlers (for DevProxy integration) ────────────────────────────

  /** Handle WebSocket upgrade from an external HTTP server. */
  handleUpgrade(
    req: IncomingMessage,
    socket: import("node:net").Socket,
    head: Buffer,
  ): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = parseRealtimePath(url.pathname);

    if (!route || route.action !== "/ws") {
      socket.destroy();
      return;
    }

    if (!this.wss) {
      // Lazy-init WSS if server not started standalone
      this.wss = new WebSocketServer({ noServer: true });
    }

    this.wss.handleUpgrade(req, socket as any, head, (ws) => {
      const roomKey = getDoName(route);
      this.addToRoom(roomKey, ws);
    });
  }

  /** Handle broadcast POST from an external HTTP server. */
  handleBroadcast(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = parseRealtimePath(url.pathname);

    if (!route || route.action !== "/broadcast" || req.method !== "POST") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not Found" }));
      return;
    }

    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      let event: { table?: string; operation?: string };
      try {
        event = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON" }));
        return;
      }

      const roomKey = getDoName(route);
      this.broadcast(roomKey, {
        type: "db_changed",
        table: event.table ?? "unknown",
        operation: event.operation ?? "UNKNOWN",
      });

      const count = this.rooms.get(roomKey)?.size ?? 0;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, clients: count }));
    });
  }

  /** Handle status GET from an external HTTP server. */
  handleStatus(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = parseRealtimePath(url.pathname);

    if (!route) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not Found" }));
      return;
    }

    const roomKey = getDoName(route);
    const count = this.rooms.get(roomKey)?.size ?? 0;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ clients: count }));
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  private addToRoom(roomKey: string, ws: WebSocket): void {
    let room = this.rooms.get(roomKey);
    if (!room) {
      room = new Set();
      this.rooms.set(roomKey, room);
    }
    room.add(ws);
    this.broadcastPeers(roomKey);

    ws.on("close", () => {
      room!.delete(ws);
      if (room!.size === 0) this.rooms.delete(roomKey);
      this.broadcastPeers(roomKey);
    });

    ws.on("error", () => {
      room!.delete(ws);
      if (room!.size === 0) this.rooms.delete(roomKey);
      this.broadcastPeers(roomKey);
    });
  }

  private broadcastPeers(roomKey: string): void {
    const count = this.rooms.get(roomKey)?.size ?? 0;
    this.broadcast(roomKey, { type: "peers", count });
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");

    // Root health check
    if (url.pathname === "/" || url.pathname === "") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ service: "creek-realtime-local", status: "ok" }));
      return;
    }

    const route = parseRealtimePath(url.pathname);

    if (!route) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not Found" }));
      return;
    }

    // Delegate to public handlers
    if (route.action === "/broadcast" && req.method === "POST") {
      this.handleBroadcast(req, res);
      return;
    }

    if (route.action === "/status" && req.method === "GET") {
      this.handleStatus(req, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  }
}
