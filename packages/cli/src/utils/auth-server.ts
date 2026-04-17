import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";

export interface AuthCallbackResult {
  key: string;
  state: string;
}

/**
 * Start a temporary local HTTP server to receive the OAuth-style callback
 * from the dashboard after CLI auth.
 *
 * Flow:
 * 1. Server starts on a random available port
 * 2. CLI opens browser to dashboard /cli-auth?port=X&state=Y
 * 3. Dashboard creates API key, redirects to http://localhost:X/callback?key=...&state=...
 * 4. This server receives the callback, validates state, resolves the promise
 * 5. Server auto-closes
 */
export async function startAuthServer(): Promise<{
  port: number;
  state: string;
  waitForCallback: () => Promise<string>;
  close: () => void;
}> {
  const state = randomBytes(16).toString("hex");
  let resolveCallback: (key: string) => void;
  let rejectCallback: (err: Error) => void;

  const callbackPromise = new Promise<string>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost`);

    if (url.pathname === "/callback") {
      const key = url.searchParams.get("key");
      const returnedState = url.searchParams.get("state");

      if (returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(htmlPage("Authentication Failed", "Invalid state parameter. Please try again."));
        rejectCallback(new Error("State mismatch — possible CSRF attack"));
        return;
      }

      if (!key) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(htmlPage("Authentication Failed", "No API key received. Please try again."));
        rejectCallback(new Error("No API key in callback"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(htmlPage(
        "Authenticated!",
        "You can close this window and return to the terminal.",
      ));

      resolveCallback(key);
      setTimeout(() => server.close(), 500);
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  // Listen on port 0 = OS picks a random available port.
  // server.listen() is async — we MUST await the 'listening' event before
  // reading server.address(), otherwise address() returns null and the
  // callback URL ships ?port=0 to the dashboard (which correctly rejects
  // with "Missing port or state parameter"). Regression seen in the wild
  // on macOS — Node's behavior here is timing-dependent.
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", (err) => reject(err));
    server.listen(0, "localhost");
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  if (port === 0) {
    server.close();
    throw new Error(
      "Could not determine local port for auth callback — server.address() returned null after listening.",
    );
  }

  // Timeout after 2 minutes
  const timeout = setTimeout(() => {
    rejectCallback(new Error("Login timed out after 2 minutes"));
    server.close();
  }, 120_000);

  return {
    port,
    state,
    waitForCallback: () =>
      callbackPromise.finally(() => clearTimeout(timeout)),
    close: () => {
      clearTimeout(timeout);
      server.close();
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function htmlPage(title: string, message: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Creek CLI - ${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #0a0a0a; color: #eee; }
    .card { text-align: center; padding: 2rem; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    p { color: #888; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>`;
}
