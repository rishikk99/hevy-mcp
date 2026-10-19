// An in-memory KVNamespace covering what the OAuth library uses: get (text or
// json), put with expiration and metadata, delete, and prefix list.

interface Entry {
  value: string;
  expiresAt: number | null;
  metadata: unknown;
}

export class FakeKV {
  readonly store = new Map<string, Entry>();

  private live(key: string): Entry | undefined {
    const entry = this.store.get(key);
    if (entry && entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string, options?: "text" | "json" | { type?: "text" | "json" }): Promise<unknown> {
    const entry = this.live(key);
    if (!entry) return null;
    const type = typeof options === "string" ? options : options?.type;
    return type === "json" ? JSON.parse(entry.value) : entry.value;
  }

  async put(
    key: string,
    value: string,
    options: { expirationTtl?: number; expiration?: number; metadata?: unknown } = {},
  ): Promise<void> {
    const expiresAt = options.expirationTtl
      ? Date.now() + options.expirationTtl * 1000
      : options.expiration
        ? options.expiration * 1000
        : null;
    this.store.set(key, { value, expiresAt, metadata: options.metadata ?? null });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options: { prefix?: string; cursor?: string; limit?: number } = {}) {
    const keys = [...this.store.keys()]
      .filter((k) => k.startsWith(options.prefix ?? "") && this.live(k))
      .sort();
    const start = options.cursor ? Number(options.cursor) : 0;
    const limit = options.limit ?? 1000;
    const page = keys.slice(start, start + limit);
    const done = start + limit >= keys.length;
    return {
      keys: page.map((name) => {
        const e = this.store.get(name)!;
        return { name, metadata: e.metadata, expiration: e.expiresAt ? Math.floor(e.expiresAt / 1000) : undefined };
      }),
      list_complete: done,
      cursor: done ? undefined : String(start + limit),
      cacheStatus: null,
    };
  }

  get kv(): KVNamespace {
    return this as unknown as KVNamespace;
  }
}
