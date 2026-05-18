import { existsSync, statSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';

export type AssetsBinding = {
  fetch(request: Request): Promise<Response>;
};

class CreekStaticAssets implements AssetsBinding {
  private root: string;

  constructor(dir: string) {
    this.root = resolve(dir);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';

    // Resolve and guard against directory traversal
    const requested = resolve(join(this.root, normalize(pathname)));
    if (!requested.startsWith(this.root + sep) && requested !== this.root) {
      return new Response('Forbidden', { status: 403 });
    }

    if (!existsSync(requested)) {
      // SPA fallback: if a non-asset path is requested, try index.html
      const indexFallback = join(this.root, 'index.html');
      if (existsSync(indexFallback) && !pathname.includes('.')) {
        return new Response(Bun.file(indexFallback));
      }
      return new Response('Not Found', { status: 404 });
    }

    const st = statSync(requested);
    if (st.isDirectory()) {
      const indexInDir = join(requested, 'index.html');
      if (existsSync(indexInDir)) {
        return new Response(Bun.file(indexInDir));
      }
      return new Response('Not Found', { status: 404 });
    }

    // Bun.file infers Content-Type from extension automatically.
    return new Response(Bun.file(requested));
  }
}

export function openAssets(dir: string): CreekStaticAssets {
  return new CreekStaticAssets(dir);
}
