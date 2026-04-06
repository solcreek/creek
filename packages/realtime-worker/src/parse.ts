// Realtime URL routing — pure function for testability.
//
// Supported patterns:
//   /{slug}/broadcast          → project-wide (legacy)
//   /{slug}/ws                 → project-wide (legacy)
//   /{slug}/status             → project-wide (legacy)
//   /{slug}/rooms/{roomId}/broadcast  → room-scoped
//   /{slug}/rooms/{roomId}/ws         → room-scoped
//   /{slug}/rooms/{roomId}/status     → room-scoped

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

/**
 * Compute the Durable Object name from a parsed route.
 * Room-scoped routes get a separate DO per room.
 */
export function getDoName(route: RealtimeRoute): string {
  return route.roomId ? `${route.slug}:${route.roomId}` : route.slug;
}
