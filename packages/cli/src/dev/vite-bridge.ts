// Vite dev server integration for `creek dev`.
//
// Uses Vite's middleware mode — no separate HTTP server.
// HMR WebSocket is handled through Vite's own middleware.

import type { IncomingMessage, ServerResponse } from "node:http";

type ConnectMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => void;

export class ViteBridge {
  private viteServer: any = null; // ViteDevServer — dynamically imported
  private cwd: string;

  constructor(options: { cwd: string }) {
    this.cwd = options.cwd;
  }

  async start(): Promise<void> {
    let vite: any;
    try {
      vite = await import("vite");
    } catch {
      throw new Error(
        "[creek dev] Vite is not installed. Run `npm install -D vite` to enable client-side HMR.",
      );
    }

    this.viteServer = await vite.createServer({
      root: this.cwd,
      server: {
        middlewareMode: true,
        hmr: true,
      },
      appType: "spa",
    });
  }

  async stop(): Promise<void> {
    if (this.viteServer) {
      await this.viteServer.close();
      this.viteServer = null;
    }
  }

  /** Vite's Connect middleware stack — plug into the proxy server. */
  get middlewares(): ConnectMiddleware {
    if (!this.viteServer) {
      throw new Error("ViteBridge not started");
    }
    return this.viteServer.middlewares;
  }
}
