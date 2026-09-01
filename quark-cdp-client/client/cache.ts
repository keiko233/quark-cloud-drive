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
}
