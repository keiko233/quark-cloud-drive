// TTL cache with prefix-based invalidation. Write operations invalidate the
// read caches they could have made stale (e.g. `setDownloadStatus` clears the
// download-status cache) instead of waiting for the TTL to expire.

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

export class TtlCache<K, V> {
  private store = new Map<K, CacheEntry<V>>();

  constructor(private readonly ttlMs: number) {}

  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  delete(key: K): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * Delete every entry whose key satisfies `predicate`. Used to invalidate
   * read caches from write operations (e.g. all `downloadStatus:` entries).
   */
  invalidateWhere(predicate: (key: K) => boolean): void {
    for (const key of this.store.keys()) {
      if (predicate(key)) this.store.delete(key);
    }
  }
}
