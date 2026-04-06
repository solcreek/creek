// Port allocation utilities for `creek dev`.

import { createServer } from "node:net";

/** Check if a port is available on localhost. */
export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

/** Find an available port, starting from the preferred port. */
export async function findAvailablePort(preferred = 3000): Promise<number> {
  if (await isPortAvailable(preferred)) return preferred;

  // Try a few ports around the preferred one
  for (let offset = 1; offset <= 10; offset++) {
    const port = preferred + offset;
    if (await isPortAvailable(port)) return port;
  }

  // Fall back to OS-assigned port
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}
