// creek/react — client-side hooks
//
// Usage:
//   import { useQuery, useLiveQuery, LiveRoom, useRoom } from 'creek/react';
//
//   <LiveRoom id="room-id">
//     <App />
//   </LiveRoom>
//
//   const { data, mutate, fetch } = useLiveQuery('/api/todos');

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  createElement,
  createContext,
  useContext,
  type ReactNode,
} from "react";

// ─── Types ─────────────────────────────────────────────────────────────────

/** Request descriptor for mutate() — auto-handles JSON, headers, and room context. */
export interface MutateRequest {
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
}

export interface QueryResult<T> {
  data: T | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export interface LiveQueryResult<T, HasInitial extends boolean = false> {
  data: HasInitial extends true ? T : T | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  /**
   * Run a mutation with optional optimistic update.
   * Accepts either a request descriptor or an async action function.
   * If the action fails after all retries, the optimistic update is rolled back.
   */
  mutate: (
    action: MutateRequest | (() => Promise<unknown>),
    optimistic?: (current: HasInitial extends true ? T : T | null) => T,
    options?: { retry?: number; retryDelay?: number },
  ) => Promise<void>;
  isConnected: boolean;
}

// ─── Room Context ──────────────────────────────────────────────────────────

interface QueryCacheEntry {
  data: unknown;
  subscribers: Set<() => void>;
  fetching: boolean;
}

interface RoomContextValue {
  roomId: string;
  isConnected: boolean;
  peers: number;
  /** Subscribe to db_changed events. Callback receives the changed table name (or "*"). */
  subscribe: (cb: (table: string) => void) => () => void;
  queryCache: Map<string, QueryCacheEntry>;
}

const RoomContext = createContext<RoomContextValue | null>(null);

/**
 * Room provider — manages a shared WebSocket for all useLiveQuery hooks
 * inside this subtree. Broadcasts are scoped to this room.
 *
 * @param id - Room ID. Same ID = same room (shared data + realtime).
 * @param realtimeUrl - Full WebSocket URL. If omitted, auto-discovered via `/__creek/config`.
 */
export function LiveRoom({
  id,
  realtimeUrl,
  children,
}: {
  id: string;
  realtimeUrl?: string;
  children: ReactNode;
}) {
  const [isConnected, setIsConnected] = useState(false);
  const [peers, setPeers] = useState(0);
  const [wsUrl, setWsUrl] = useState<string | null>(realtimeUrl ?? null);
  const subscribersRef = useRef(new Set<(table: string) => void>());
  const queryCacheRef = useRef(new Map<string, QueryCacheEntry>());
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Auto-discover realtime URL from server if not provided
  useEffect(() => {
    if (realtimeUrl) return;

    let cancelled = false;
    fetch("/__creek/config")
      .then((r) => r.json() as Promise<{ realtimeUrl: string; projectSlug: string; wsToken?: string }>)
      .then((config) => {
        if (cancelled) return;
        const protocol =
          config.realtimeUrl.startsWith("https") ? "wss:" : "ws:";
        const host = config.realtimeUrl.replace(/^https?:\/\//, "");
        const tokenParam = config.wsToken ? `?token=${config.wsToken}` : "";
        setWsUrl(
          `${protocol}//${host}/${config.projectSlug}/rooms/${id}/ws${tokenParam}`,
        );
      })
      .catch(() => {
        if (!cancelled) {
          const protocol =
            location.protocol === "https:" ? "wss:" : "ws:";
          setWsUrl(`${protocol}//${location.host}/ws?room=${id}`);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [id, realtimeUrl]);

  // WebSocket connection with debounced subscriber notification
  useEffect(() => {
    if (!wsUrl) return;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    let pendingTable = "*";

    function notifySubscribers(table: string) {
      pendingTable = table;
      // Debounce: collapse multiple db_changed events within 50ms into one refetch
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        for (const cb of subscribersRef.current) {
          cb(pendingTable);
        }
        pendingTable = "*";
      }, 50);
    }

    function connect() {
      const ws = new WebSocket(wsUrl!);
      wsRef.current = ws;

      ws.onopen = () => setIsConnected(true);

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "db_changed") {
            notifySubscribers(msg.table ?? "*");
          }
          if (msg.type === "peers") {
            setPeers(msg.count);
          }
        } catch {
          // Ignore non-JSON
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        setIsConnected(false);
        // Reconnect with jitter to avoid thundering herd
        const jitter = 2000 + Math.random() * 2000;
        reconnectTimer.current = setTimeout(connect, jitter);
      };

      ws.onerror = () => ws.close();
    }

    connect();

    return () => {
      clearTimeout(debounceTimer);
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [wsUrl]);

  const subscribe = useCallback((cb: (table: string) => void) => {
    subscribersRef.current.add(cb);
    return () => {
      subscribersRef.current.delete(cb);
    };
  }, []);

  // Memoize context value to prevent unnecessary re-renders of consumers
  const contextValue = useMemo(
    () => ({ roomId: id, isConnected, peers, subscribe, queryCache: queryCacheRef.current }),
    [id, isConnected, peers, subscribe],
  );

  return createElement(
    RoomContext.Provider,
    { value: contextValue },
    children,
  );
}

/**
 * Access room metadata. Must be used inside `<LiveRoom>`.
 */
export function useRoom(): {
  roomId: string;
  isConnected: boolean;
  peers: number;
} {
  const ctx = useContext(RoomContext);
  if (!ctx) {
    throw new Error("useRoom must be used within <LiveRoom>");
  }
  return { roomId: ctx.roomId, isConnected: ctx.isConnected, peers: ctx.peers };
}

// ─── useQuery ──────────────────────────────────────────────────────────────

/**
 * Static query — fetches once, refetch on demand.
 */
export function useQuery<T = unknown>(path: string): QueryResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch(path);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setIsLoading(false);
    }
  }, [path]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { data, isLoading, error, refetch };
}

// ─── useLiveQuery ──────────────────────────────────────────────────────────

/**
 * Live query — fetches initially, auto-refetches on DB changes via WebSocket.
 *
 * Returns `mutate()` for write-then-refresh with optimistic updates (auto-rollback on failure),
 * and `fetch` (room-aware, auto-injects X-Creek-Room header).
 *
 * Inside `<LiveRoom>`: automatically scoped to the room.
 * Outside `<LiveRoom>`: standalone WS to `realtimeUrl` or same-origin `/ws`.
 */
/** Options for useLiveQuery */
export interface LiveQueryOptions<T> {
  initialData?: T;
  realtimeUrl?: string;
  /** Called when data changes. Receives new and previous data. */
  onChange?: (data: T, prev: T | null) => void;
  /** Transform data before it reaches the component. Like a computed/derived value. */
  select?: (data: T) => unknown;
  /** Called when a mutation fails after all retries. Receives the error. */
  onMutationError?: (error: unknown) => void;
  /** Filter refetches by table name. Only refetch when the specified tables change. */
  tables?: string[];
  /** Throw a promise during initial load for React Suspense. Requires a Suspense boundary. */
  suspense?: boolean;
}

// Suspense cache — stores in-flight promises for Suspense mode
const suspenseCache = new Map<string, { promise: Promise<unknown>; data?: unknown; error?: unknown }>();

// Overloads: when initialData is provided, data is never null
export function useLiveQuery<T>(
  path: string,
  options: LiveQueryOptions<T> & { initialData: T },
): LiveQueryResult<T, true>;
export function useLiveQuery<T = unknown>(
  path: string,
  options?: LiveQueryOptions<T>,
): LiveQueryResult<T, false>;
export function useLiveQuery<T = unknown>(
  path: string,
  options?: LiveQueryOptions<T>,
): LiveQueryResult<T, boolean> {
  const roomCtx = useContext(RoomContext);
  const realtimeUrl = options?.realtimeUrl;

  // Suspense mode: throw a promise during initial load
  if (options?.suspense && options?.initialData === undefined) {
    const cacheKey = `${roomCtx?.roomId ?? ""}:${path}`;
    const cached = suspenseCache.get(cacheKey);
    if (cached) {
      if (cached.error) throw cached.error;
      if (cached.data === undefined) throw cached.promise; // Still loading
      // Data ready — continue to normal hook
    } else {
      // Start fetch and throw the promise
      const headers: Record<string, string> = {};
      if (roomCtx) headers["x-creek-room"] = roomCtx.roomId;
      const promise = fetch(path, { headers })
        .then((r) => r.json())
        .then((data) => {
          const entry = suspenseCache.get(cacheKey);
          if (entry) entry.data = options?.select ? options.select(data as T) : data;
        })
        .catch((err) => {
          const entry = suspenseCache.get(cacheKey);
          if (entry) entry.error = err;
        });
      suspenseCache.set(cacheKey, { promise });
      throw promise;
    }
  }

  const onChangeRef = useRef(options?.onChange);
  onChangeRef.current = options?.onChange;
  const selectRef = useRef(options?.select);
  selectRef.current = options?.select;
  const onMutationErrorRef = useRef(options?.onMutationError);
  onMutationErrorRef.current = options?.onMutationError;
  const tablesRef = useRef(options?.tables);
  tablesRef.current = options?.tables;

  // For suspense mode, seed from cache; otherwise use initialData
  const suspenseSeed = options?.suspense
    ? (suspenseCache.get(`${roomCtx?.roomId ?? ""}:${path}`)?.data as T | undefined)
    : undefined;
  const [data, setData] = useState<T | null>(suspenseSeed ?? options?.initialData ?? null);
  const dataRef = useRef<T | null>(options?.initialData ?? null);
  const [isLoading, setIsLoading] = useState(options?.initialData == null);
  const [error, setError] = useState<Error | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const mutationGenRef = useRef(0); // Tracks in-flight mutations for stale refetch detection

  // Room-aware fetch
  const roomFetch = useCallback(
    (input: RequestInfo | URL, init?: RequestInit) => {
      if (!roomCtx) return fetch(input, init);
      const headers = new Headers(init?.headers);
      headers.set("x-creek-room", roomCtx.roomId);
      return fetch(input, { ...init, headers });
    },
    [roomCtx?.roomId],
  );

  const setDataWithRef = useCallback((value: T | null | ((prev: T | null) => T | null)) => {
    if (typeof value === "function") {
      setData((prev) => {
        const next = (value as (prev: T | null) => T | null)(prev);
        if (onChangeRef.current && next !== null && next !== prev) {
          onChangeRef.current(next as T, prev);
        }
        dataRef.current = next;
        return next;
      });
    } else {
      const prev = dataRef.current;
      if (onChangeRef.current && value !== null && value !== prev) {
        onChangeRef.current(value as T, prev);
      }
      dataRef.current = value;
      setData(value);
    }
  }, []);

  const refetch = useCallback(async () => {
    // Query deduplication: if another useLiveQuery with the same path is already
    // fetching inside this LiveRoom, skip. They share the WS subscription and
    // the data will arrive via onChange or a subsequent non-deduped fetch.
    const cache = roomCtx?.queryCache;
    if (cache) {
      const entry = cache.get(path);
      if (entry?.fetching) return; // Already in-flight for this path
      if (!entry) {
        cache.set(path, { data: null, subscribers: new Set(), fetching: true });
      } else {
        entry.fetching = true;
      }
    }

    // Snapshot the mutation generation before fetching.
    // If a mutation happens while we're fetching, the result is stale — discard it.
    const genAtStart = mutationGenRef.current;

    try {
      const res = await roomFetch(path);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = (await res.json()) as T;
      const json = selectRef.current ? selectRef.current(raw) as T : raw;

      // Only apply if no mutations happened during this fetch
      if (mutationGenRef.current === genAtStart) {
        setDataWithRef(json);
        setError(null);
      }

      // Update cache + notify other subscribers of the same path
      if (cache) {
        const entry = cache.get(path);
        if (entry) {
          entry.data = json;
          entry.fetching = false;
          if (mutationGenRef.current === genAtStart) {
            for (const cb of entry.subscribers) {
              cb();
            }
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
      if (cache) {
        const entry = cache.get(path);
        if (entry) entry.fetching = false;
      }
    } finally {
      setIsLoading(false);
    }
  }, [path, roomFetch, setDataWithRef, roomCtx?.queryCache]);

  const mutate = useCallback(
    async (
      action: MutateRequest | (() => Promise<unknown>),
      optimistic?: (current: T | null) => T,
      options?: { retry?: number; retryDelay?: number },
    ) => {
      const snapshot = dataRef.current;
      const maxRetries = options?.retry ?? 0;
      const retryDelay = options?.retryDelay ?? 1000;

      // Increment mutation generation — stale refetches will be discarded
      mutationGenRef.current++;

      // Resolve action: request descriptor → room-aware fetch
      const actionFn =
        typeof action === "function"
          ? action
          : () => {
              const req = action as MutateRequest;
              const init: RequestInit = { method: req.method };
              if (req.body !== undefined) {
                init.headers = { "Content-Type": "application/json" };
                init.body = JSON.stringify(req.body);
              }
              return roomFetch(req.path, init);
            };

      if (optimistic) {
        setDataWithRef((prev) => optimistic(prev));
      }

      // If WS is connected, skip explicit refetch — the broadcast will trigger it.
      // This prevents double-render (optimistic → refetch → WS refetch).
      const wsConnected = roomCtx?.isConnected ?? false;

      let lastError: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          await actionFn();
          if (!wsConnected) {
            await refetch();
          }
          return; // Success — exit
        } catch (e) {
          lastError = e;
          if (attempt < maxRetries) {
            await new Promise((r) => setTimeout(r, retryDelay * (attempt + 1)));
          }
        }
      }

      // All attempts failed — rollback and notify
      if (optimistic) {
        setDataWithRef(snapshot);
      }
      if (onMutationErrorRef.current) {
        onMutationErrorRef.current(lastError);
      } else {
        throw lastError;
      }
    },
    [refetch, setDataWithRef, roomCtx?.isConnected, roomFetch],
  );

  // WebSocket connection
  useEffect(() => {
    if (roomCtx) {
      // Inside LiveRoom: subscribe to shared WS with optional table filtering
      setIsConnected(roomCtx.isConnected);
      const unsub = roomCtx.subscribe((table: string) => {
        const filter = tablesRef.current;
        if (!filter || table === "*" || filter.includes(table)) {
          refetch();
        }
      });
      return unsub;
    }

    if (realtimeUrl) {
      // Explicit realtimeUrl: create standalone WebSocket
      let debounceTimer: ReturnType<typeof setTimeout> | undefined;

      function connect() {
        const ws = new WebSocket(realtimeUrl!);
        wsRef.current = ws;

        ws.onopen = () => setIsConnected(true);

        ws.onmessage = (e) => {
          try {
            const msg = JSON.parse(e.data);
            if (msg.type === "db_changed") {
              clearTimeout(debounceTimer);
              debounceTimer = setTimeout(refetch, 50);
            }
          } catch {
            // Ignore non-JSON
          }
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
      refetch();

      return () => {
        clearTimeout(debounceTimer);
        clearTimeout(reconnectTimer.current);
        wsRef.current?.close();
      };
    }

    // No LiveRoom, no realtimeUrl: just fetch, no WebSocket (same as useQuery)
    refetch();
  }, [roomCtx, realtimeUrl, refetch]);

  // Query cache: register this hook's refetch as a subscriber for dedup
  useEffect(() => {
    const cache = roomCtx?.queryCache;
    if (!cache) return;

    let entry = cache.get(path);
    if (!entry) {
      entry = { data: null, subscribers: new Set(), fetching: false };
      cache.set(path, entry);
    }

    // Subscribe: when another hook for the same path fetches, update our data too
    const syncFromCache = () => {
      const cached = cache.get(path);
      if (cached?.data != null) {
        setDataWithRef(cached.data as T);
      }
    };
    entry.subscribers.add(syncFromCache);

    return () => {
      entry!.subscribers.delete(syncFromCache);
      if (entry!.subscribers.size === 0) {
        cache.delete(path);
      }
    };
  }, [roomCtx?.queryCache, path, setDataWithRef]);

  // Sync connected state from room context
  useEffect(() => {
    if (roomCtx) {
      setIsConnected(roomCtx.isConnected);
    }
  }, [roomCtx?.isConnected]);

  // Initial fetch when inside room
  useEffect(() => {
    if (roomCtx) {
      refetch();
    }
  }, [roomCtx, refetch]);

  return { data, isLoading, error, refetch, mutate, isConnected };
}

// ─── usePresence ────────────────────────────────────────────────────────────

export interface PresenceOptions {
  /** Realtime service URL (e.g. "https://rt.creek.dev"). Required outside Creek apps. */
  realtimeUrl: string;
  /** Project slug. Required outside Creek apps. */
  projectSlug: string;
}

/**
 * Standalone presence hook — shows how many users are connected to a room.
 * No `<LiveRoom>` wrapper needed.
 *
 * For public rooms (roomId starts with "public-"), no authentication is required.
 *
 * @example
 * ```tsx
 * // On a marketing page — no Creek runtime needed
 * const { count, isConnected } = usePresence("public-homepage", {
 *   realtimeUrl: "https://rt.creek.dev",
 *   projectSlug: "www",
 * });
 * return <span>{count} people online</span>;
 * ```
 */
export function usePresence(
  roomId: string,
  options?: PresenceOptions,
): { count: number; isConnected: boolean } {
  const [count, setCount] = useState(0);
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Resolve WebSocket URL
  const [wsUrl, setWsUrl] = useState<string | null>(null);

  useEffect(() => {
    if (options?.realtimeUrl && options?.projectSlug) {
      const protocol = options.realtimeUrl.startsWith("https") ? "wss:" : "ws:";
      const host = options.realtimeUrl.replace(/^https?:\/\//, "");
      setWsUrl(`${protocol}//${host}/${options.projectSlug}/rooms/${roomId}/ws`);
      return;
    }

    // Auto-discover from /__creek/config
    let cancelled = false;
    fetch("/__creek/config")
      .then((r) => r.json() as Promise<{ realtimeUrl: string; projectSlug: string; wsToken?: string }>)
      .then((config) => {
        if (cancelled) return;
        const protocol = config.realtimeUrl.startsWith("https") ? "wss:" : "ws:";
        const host = config.realtimeUrl.replace(/^https?:\/\//, "");
        const tokenParam = config.wsToken ? `?token=${config.wsToken}` : "";
        setWsUrl(`${protocol}//${host}/${config.projectSlug}/rooms/${roomId}/ws${tokenParam}`);
      })
      .catch(() => {
        // Fallback: try current host
        if (!cancelled) {
          const protocol = location.protocol === "https:" ? "wss:" : "ws:";
          setWsUrl(`${protocol}//${location.host}/ws?room=${roomId}`);
        }
      });

    return () => { cancelled = true; };
  }, [roomId, options?.realtimeUrl, options?.projectSlug]);

  // WebSocket connection
  useEffect(() => {
    if (!wsUrl) return;

    function connect() {
      const ws = new WebSocket(wsUrl!);
      wsRef.current = ws;

      ws.onopen = () => setIsConnected(true);

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "peers") {
            setCount(msg.count);
          }
        } catch {
          // Ignore non-JSON
        }
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
  }, [wsUrl]);

  return { count, isConnected };
}
