import { parseRealtimePath, getDoName } from "./parse.js";

interface Env {
  ROOMS: DurableObjectNamespace;
  REALTIME_MASTER_KEY: string;
  /** @deprecated Use REALTIME_MASTER_KEY for per-project HMAC auth */
  REALTIME_SECRET: string;
}

// ─── HMAC-SHA256 verification ───────────────────────────────────────────────

async function verifyHmac(
  masterKey: string,
  slug: string,
  token: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(masterKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(slug),
  );

  const expected = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time comparison
  if (expected.length !== token.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  }
  return mismatch === 0;
}

const WS_TOKEN_MAX_AGE = 5 * 60; // 5 minutes

/**
 * Verify a WebSocket subscribe token.
 * Token format: {timestamp}.{hmac}
 * HMAC is computed over "{slug}:ws:{timestamp}" using the per-project secret.
 * The per-project secret is HMAC(masterKey, slug).
 */
async function verifyWsToken(
  masterKey: string,
  slug: string,
  token: string,
): Promise<boolean> {
  const dotIdx = token.indexOf(".");
  if (dotIdx === -1) return false;

  const timestampStr = token.slice(0, dotIdx);
  const hmacStr = token.slice(dotIdx + 1);
  const timestamp = parseInt(timestampStr, 10);
  if (isNaN(timestamp)) return false;

  // Check expiry
  const now = Math.floor(Date.now() / 1000);
  if (now - timestamp > WS_TOKEN_MAX_AGE) return false;

  // Derive per-project secret: HMAC(masterKey, slug)
  const masterCryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(masterKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const projectSecretBuf = await crypto.subtle.sign(
    "HMAC",
    masterCryptoKey,
    new TextEncoder().encode(slug),
  );
  const projectSecret = Array.from(new Uint8Array(projectSecretBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Verify token: HMAC(projectSecret, "{slug}:ws:{timestamp}")
  const tokenKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(projectSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expectedBuf = await crypto.subtle.sign(
    "HMAC",
    tokenKey,
    new TextEncoder().encode(`${slug}:ws:${timestamp}`),
  );
  const expected = Array.from(new Uint8Array(expectedBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time comparison
  if (expected.length !== hmacStr.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ hmacStr.charCodeAt(i);
  }
  return mismatch === 0;
}

// ─── Durable Object: RealtimeRoom ───────────────────────────────────────────
// One instance per project slug (or per room within a project).
// Maintains WebSocket connections and broadcasts database change events.
//
// Uses the Hibernation API (state.acceptWebSocket / state.getWebSockets)
// so that sessions survive DO eviction from memory.

export class RealtimeRoom implements DurableObject {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;

    // Auto-response: CF handles ping/pong WITHOUT waking the DO.
    // Keeps connections alive during hibernation at zero compute cost.
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // POST /broadcast — called by user workers when DB writes happen
    if (url.pathname === "/broadcast" && request.method === "POST") {
      const event = await request.json<{ table?: string; operation?: string }>();
      const msg = JSON.stringify({ type: "db_changed", ...event });
      const sent = this.broadcast(msg);
      return Response.json({ ok: true, clients: sent });
    }

    // GET /ws — WebSocket upgrade for client subscriptions
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      // Hibernation API: DO survives eviction, sessions persist
      this.state.acceptWebSocket(server);

      // Notify all clients about new peer count
      this.broadcastPeers();

      return new Response(null, { status: 101, webSocket: client });
    }

    // GET /status — health check
    if (url.pathname === "/status") {
      return Response.json({ clients: this.state.getWebSockets().length });
    }

    return new Response("Not Found", { status: 404 });
  }

  /** Send a message to all connected clients. Closes dead sockets. Returns live count. */
  private broadcast(msg: string, exclude?: WebSocket): number {
    let live = 0;
    for (const ws of this.state.getWebSockets()) {
      if (ws === exclude) continue;
      try {
        ws.send(msg);
        live++;
      } catch {
        // Socket is dead — close it so getWebSockets() won't return it again
        try { ws.close(1011, "Unexpected error"); } catch { /* already closed */ }
      }
    }
    return live;
  }

  private broadcastPeers(exclude?: WebSocket): void {
    // Count only live sockets (exclude the one being closed)
    const allSockets = this.state.getWebSockets();
    const count = exclude
      ? allSockets.filter((ws) => ws !== exclude).length
      : allSockets.length;
    this.broadcast(JSON.stringify({ type: "peers", count }), exclude);
  }

  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    // No client-to-client messaging needed.
    // ping/pong handled by setWebSocketAutoResponse — doesn't wake the DO.
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    try { ws.close(code, reason); } catch { /* already closed */ }
    // Exclude the closing socket from peer count
    this.broadcastPeers(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try { ws.close(1011, "WebSocket error"); } catch { /* already closed */ }
    this.broadcastPeers(ws);
  }
}

// ─── Main Router ────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const route = parseRealtimePath(url.pathname);

    if (!route) {
      return Response.json({ service: "creek-realtime", status: "ok" });
    }

    // Authenticate broadcast requests (from user workers)
    if (route.action === "/broadcast") {
      const auth = request.headers.get("Authorization");
      const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;

      if (env.REALTIME_MASTER_KEY) {
        // HMAC per-project auth: verify token = HMAC(masterKey, slug)
        if (!token || !(await verifyHmac(env.REALTIME_MASTER_KEY, route.slug, token))) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
      } else if (env.REALTIME_SECRET) {
        // Legacy: single global secret
        if (token !== env.REALTIME_SECRET) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
      }
      // If neither is set, allow unauthenticated (dev mode)
    }

    // Authenticate WebSocket subscribe requests (from clients)
    // Public rooms (roomId starts with "public-") skip token auth — used for
    // presence-only use cases (e.g. homepage visitor counter).
    if (route.action === "/ws" && env.REALTIME_MASTER_KEY) {
      const isPublicRoom = route.roomId?.startsWith("public-") ?? false;
      if (!isPublicRoom) {
        const wsToken = url.searchParams.get("token");
        if (!wsToken) {
          return Response.json({ error: "unauthorized", message: "Missing token" }, { status: 401 });
        }

        const valid = await verifyWsToken(env.REALTIME_MASTER_KEY, route.slug, wsToken);
        if (!valid) {
          return Response.json({ error: "unauthorized", message: "Invalid or expired token" }, { status: 401 });
        }
      }
    }

    // Route to the appropriate DO instance (project-wide or room-scoped)
    const doName = getDoName(route);
    const id = env.ROOMS.idFromName(doName);
    const stub = env.ROOMS.get(id);

    const doUrl = new URL(request.url);
    doUrl.pathname = route.action;
    return stub.fetch(new Request(doUrl.toString(), request));
  },
};
