/**
 * Local KVNamespace adapter backed by an in-memory Map with
 * optional TTL expiration. Sufficient for dev — build status
 * is ephemeral anyway.
 */

interface KVEntry {
  value: string;
  expiresAt: number | null;
}

export class LocalKVNamespace {
  private store = new Map<string, KVEntry>();

  async get(key: string, options?: { type?: string }): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async getWithMetadata<T = unknown>(key: string): Promise<{ value: string | null; metadata: T | null }> {
    const value = await this.get(key);
    return { value, metadata: null };
  }

  async put(key: string, value: string, options?: { expirationTtl?: number; metadata?: unknown }): Promise<void> {
    const expiresAt = options?.expirationTtl
      ? Date.now() + options.expirationTtl * 1000
      : null;
    this.store.set(key, { value, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: Array<{ name: string; expiration?: number }>;
    list_complete: boolean;
    cursor?: string;
  }> {
    const prefix = options?.prefix ?? "";
    const limit = options?.limit ?? 1000;
    const keys: Array<{ name: string; expiration?: number }> = [];
    const now = Date.now();

    for (const [key, entry] of this.store) {
      if (!key.startsWith(prefix)) continue;
      if (entry.expiresAt && now > entry.expiresAt) {
        this.store.delete(key);
        continue;
      }
      keys.push({
        name: key,
        ...(entry.expiresAt ? { expiration: Math.floor(entry.expiresAt / 1000) } : {}),
      });
      if (keys.length >= limit) break;
    }

    return { keys, list_complete: keys.length < limit };
  }
}
