"use client";

import { useState, useEffect, useRef } from "react";

const REALTIME_URL = "wss://rt.creek.dev";
const PROJECT_SLUG = "www";
const ROOM_ID = "public-homepage";

export function PresenceBadge() {
  const [count, setCount] = useState(0);
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const wsUrl = `${REALTIME_URL}/${PROJECT_SLUG}/rooms/${ROOM_ID}/ws`;

    function connect() {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => setIsConnected(true);

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "peers") setCount(msg.count);
        } catch {}
      };

      ws.onclose = () => {
        wsRef.current = null;
        setIsConnected(false);
        const jitter = 2000 + Math.random() * 2000;
        reconnectTimer.current = setTimeout(connect, jitter);
      };

      ws.onerror = () => ws.close();
    }

    connect();

    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, []);

  if (!isConnected) return null;

  return (
    <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground font-mono">
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
      </span>
      <span>
        {count === 1
          ? "You're here live"
          : `${count} people on this page`}
      </span>
    </div>
  );
}
