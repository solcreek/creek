// creek/hono — Hono middleware for Creek runtime
//
// Usage:
//   import { room } from 'creek/hono';
//   app.use('/api/*', room());

import type { MiddlewareHandler } from "hono";
import { _roomStore, notifyRealtime } from "./index.js";

/**
 * Room middleware — reads `X-Creek-Room` header and scopes
 * all db writes to that room for realtime broadcasts.
 *
 * Uses AsyncLocalStorage for per-request isolation — safe
 * under concurrent requests in the same Worker isolate.
 *
 * Sets `c.var.room` (or `c.get("room")`) to the room ID.
 */
export function room(): MiddlewareHandler {
  return async (c, next) => {
    const roomId = c.req.header("x-creek-room") ?? null;
    if (roomId) {
      c.set("room", roomId);
    }
    // Run the handler inside AsyncLocalStorage context
    // so notifyRealtime() reads the correct roomId per-request
    await _roomStore.run(roomId, next);
  };
}

/**
 * Manually broadcast a realtime event.
 * Fire-and-forget — does not block.
 */
export function broadcast(event?: {
  table?: string;
  operation?: string;
}): void {
  notifyRealtime(event?.table ?? "_manual", event?.operation ?? "NOTIFY");
}
