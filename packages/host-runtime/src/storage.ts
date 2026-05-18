import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { createHash } from 'node:crypto';

export type StoragePutOptions = {
  customMetadata?: Record<string, string>;
  httpMetadata?: Record<string, string>;
};

export type StorageListOptions = {
  prefix?: string;
  limit?: number;
  cursor?: string;
};

export type StorageObject = {
  key: string;
  size: number;
  etag: string;
  uploaded: Date;
  customMetadata?: Record<string, string>;
  httpMetadata?: Record<string, string>;
};

export type StorageObjectBody = StorageObject & {
  body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
};

export type StorageObjects = {
  objects: StorageObject[];
  truncated: boolean;
  cursor?: string;
};

type MetaJson = {
  etag: string;
  uploaded: string;
  customMetadata?: Record<string, string>;
  httpMetadata?: Record<string, string>;
};

class CreekStorage {
  constructor(private base: string) {
    mkdirSync(base, { recursive: true });
  }

  async head(key: string): Promise<StorageObject | null> {
    const p = this.pathFor(key);
    if (!existsSync(p)) return null;
    return this.objectFromDisk(key, p);
  }

  async get(key: string): Promise<StorageObjectBody | null> {
    const p = this.pathFor(key);
    if (!existsSync(p)) return null;
    const obj = this.objectFromDisk(key, p);
    const file = Bun.file(p);
    return {
      ...obj,
      body: file.stream() as unknown as ReadableStream<Uint8Array>,
      arrayBuffer: () => file.arrayBuffer(),
      text: () => file.text(),
      json: <T = unknown>() => file.json() as Promise<T>,
    };
  }

  async put(
    key: string,
    value: string | ReadableStream | ArrayBuffer | Uint8Array | null,
    options?: StoragePutOptions,
  ): Promise<StorageObject> {
    const p = this.pathFor(key);
    await mkdir(dirname(p), { recursive: true });

    let buf: Uint8Array;
    if (value === null) {
      buf = new Uint8Array(0);
    } else if (typeof value === 'string') {
      buf = new TextEncoder().encode(value);
    } else if (value instanceof Uint8Array) {
      buf = value;
    } else if (value instanceof ArrayBuffer) {
      buf = new Uint8Array(value);
    } else if (value instanceof ReadableStream) {
      buf = await readStream(value);
    } else {
      throw new Error('storage put: unsupported value type');
    }

    await writeFile(p, buf);
    const meta: MetaJson = {
      etag: hashBuffer(buf),
      uploaded: new Date().toISOString(),
      ...(options?.customMetadata ? { customMetadata: options.customMetadata } : {}),
      ...(options?.httpMetadata ? { httpMetadata: options.httpMetadata } : {}),
    };
    await writeFile(`${p}.meta.json`, JSON.stringify(meta));
    return {
      key,
      size: buf.byteLength,
      etag: meta.etag,
      uploaded: new Date(meta.uploaded),
      customMetadata: meta.customMetadata,
      httpMetadata: meta.httpMetadata,
    };
  }

  async delete(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) {
      const p = this.pathFor(k);
      if (existsSync(p)) unlinkSync(p);
      const metaPath = `${p}.meta.json`;
      if (existsSync(metaPath)) unlinkSync(metaPath);
    }
  }

  async list(options: StorageListOptions = {}): Promise<StorageObjects> {
    const prefix = options.prefix ?? '';
    const limit = options.limit ?? 1000;
    const all: StorageObject[] = [];
    walk(this.base, (relpath, fullpath) => {
      if (relpath.endsWith('.meta.json')) return;
      if (prefix && !relpath.startsWith(prefix)) return;
      all.push(this.objectFromDisk(relpath, fullpath));
    });
    all.sort((a, b) => a.key.localeCompare(b.key));
    const truncated = all.length > limit;
    const objects = all.slice(0, limit);
    return {
      objects,
      truncated,
      cursor:
        truncated && objects.length > 0
          ? objects[objects.length - 1]!.key
          : undefined,
    };
  }

  private pathFor(key: string): string {
    return join(this.base, key);
  }

  private objectFromDisk(key: string, p: string): StorageObject {
    const st = statSync(p);
    const metaPath = `${p}.meta.json`;
    let meta: Partial<MetaJson> = {};
    if (existsSync(metaPath)) {
      try {
        meta = JSON.parse(
          require('node:fs').readFileSync(metaPath, 'utf-8'),
        ) as MetaJson;
      } catch {
        // ignore malformed meta
      }
    }
    return {
      key,
      size: st.size,
      etag: meta.etag ?? `inode-${st.ino}-${st.size}`,
      uploaded: meta.uploaded ? new Date(meta.uploaded) : st.mtime,
      customMetadata: meta.customMetadata,
      httpMetadata: meta.httpMetadata,
    };
  }
}

function walk(
  base: string,
  cb: (relpath: string, fullpath: string) => void,
): void {
  const stack = [base];
  while (stack.length) {
    const dir = stack.pop()!;
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else {
        cb(relative(base, full), full);
      }
    }
  }
}

function hashBuffer(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex').slice(0, 32);
}

async function readStream(stream: ReadableStream): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as Uint8Array);
    total += (value as Uint8Array).byteLength;
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  return merged;
}

export function openStorage(path: string): CreekStorage {
  return new CreekStorage(path);
}

export type { CreekStorage };
