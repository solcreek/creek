import { useState } from "react";

/**
 * Reads room ID from URL `?room=xxx`, or generates a new one.
 * Updates the URL (without reload) so sharing works.
 */
export function useRoomId(): string {
  const [roomId] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const existing = params.get("room");
    if (existing) return existing;

    // Generate short random ID
    const id = crypto.randomUUID().slice(0, 8);
    const url = new URL(window.location.href);
    url.searchParams.set("room", id);
    window.history.replaceState({}, "", url.toString());
    return id;
  });

  return roomId;
}
