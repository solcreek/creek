const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8787";

/**
 * Fetch wrapper for the Creek API.
 * Always includes credentials for cross-origin cookie auth.
 */
export async function api<T>(path: string, options?: RequestInit & { team?: string }): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options?.team ? { "x-creek-team": options.team } : {}),
  };

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      ...headers,
      ...(options?.headers as Record<string, string>),
    },
    credentials: "include",
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "unknown", message: res.statusText }));
    throw new ApiError(res.status, (body as any).error, (body as any).message, body);
  }

  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    /** The whole error body: some errors carry more than a message (a setup URL, a list). */
    public body: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}
