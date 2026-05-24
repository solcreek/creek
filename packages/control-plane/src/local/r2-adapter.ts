/**
 * Local R2Bucket adapter backed by the filesystem.
 *
 * Implements the subset of R2 used by the control-plane:
 * - get(key) → R2ObjectBody | null
 * - put(key, value) → R2Object
 * - delete(key) → void
 * - list({ prefix, limit, cursor }) → R2Objects
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";

interface R2ObjectMeta {
  key: string;
  size: number;
  etag: string;
  uploaded: Date;
  httpMetadata?: Record<string, string>;
  customMetadata?: Record<string, string>;
}

class LocalR2Object implements R2ObjectMeta {
  key: string;
  size: number;
  etag: string;
  uploaded: Date;
  httpMetadata?: Record<string, string>;
  customMetadata?: Record<string, string>;

  constructor(key: string, size: number) {
    this.key = key;
    this.size = size;
    this.etag = `"${Date.now().toString(36)}"`;
    this.uploaded = new Date();
  }
}

class LocalR2ObjectBody extends LocalR2Object {
  private data: Buffer;

  constructor(key: string, data: Buffer) {
    super(key, data.length);
    this.data = data;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.data.buffer.slice(this.data.byteOffset, this.data.byteOffset + this.data.byteLength);
  }

  async text(): Promise<string> {
    return this.data.toString("utf-8");
  }

  async json<T>(): Promise<T> {
    return JSON.parse(this.data.toString("utf-8"));
  }

  get body(): ReadableStream {
    const data = this.data;
    return new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(data));
        controller.close();
      },
    });
  }
}

export class LocalR2Bucket {
  private root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(root, { recursive: true });
  }

  private keyPath(key: string): string {
    return join(this.root, key);
  }

  async get(key: string): Promise<LocalR2ObjectBody | null> {
    const path = this.keyPath(key);
    if (!existsSync(path)) return null;
    try {
      const data = readFileSync(path);
      return new LocalR2ObjectBody(key, data);
    } catch {
      return null;
    }
  }

  async put(key: string, value: string | ArrayBuffer | ReadableStream | Blob | Buffer | Uint8Array, options?: { httpMetadata?: Record<string, string>; customMetadata?: Record<string, string> }): Promise<LocalR2Object> {
    const path = this.keyPath(key);
    mkdirSync(dirname(path), { recursive: true });

    let buf: Buffer;
    if (typeof value === "string") {
      buf = Buffer.from(value, "utf-8");
    } else if (value instanceof ArrayBuffer) {
      buf = Buffer.from(value);
    } else if (value instanceof Uint8Array) {
      buf = Buffer.from(value);
    } else if (Buffer.isBuffer(value)) {
      buf = value;
    } else {
      // ReadableStream or Blob — read it
      const chunks: Uint8Array[] = [];
      const reader = (value as ReadableStream).getReader();
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        chunks.push(chunk);
      }
      buf = Buffer.concat(chunks);
    }

    writeFileSync(path, buf);
    return new LocalR2Object(key, buf.length);
  }

  async delete(key: string | string[]): Promise<void> {
    const keys = Array.isArray(key) ? key : [key];
    for (const k of keys) {
      try { unlinkSync(this.keyPath(k)); } catch { /* ignore */ }
    }
  }

  async list(options?: { prefix?: string; limit?: number; cursor?: string; delimiter?: string }): Promise<{
    objects: LocalR2Object[];
    truncated: boolean;
    cursor?: string;
    delimitedPrefixes: string[];
  }> {
    const prefix = options?.prefix ?? "";
    const limit = options?.limit ?? 1000;
    const objects: LocalR2Object[] = [];

    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else {
          const key = relative(this.root, fullPath);
          if (key.startsWith(prefix)) {
            const stat = statSync(fullPath);
            objects.push(new LocalR2Object(key, stat.size));
          }
        }
        if (objects.length > limit) return;
      }
    };

    walk(this.root);
    const truncated = objects.length > limit;
    return { objects: objects.slice(0, limit), truncated, delimitedPrefixes: [] };
  }

  async head(key: string): Promise<LocalR2Object | null> {
    const path = this.keyPath(key);
    if (!existsSync(path)) return null;
    const stat = statSync(path);
    return new LocalR2Object(key, stat.size);
  }
}
