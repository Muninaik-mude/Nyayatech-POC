// Small in-memory TTL cache (review item 10). Used so repeat lookups inside the window cost no
// captcha solve and no portal hit. In-flight lookups are shared: two simultaneous requests for the
// same key make ONE upstream call.
export class TtlCache<V> {
  private store = new Map<string, { value: V; expires: number }>();
  private inflight = new Map<string, Promise<V>>();
  constructor(private ttlMs: number, private max = 500, private now: () => number = Date.now) {}

  get(key: string): V | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expires <= this.now()) { this.store.delete(key); return undefined; }
    return e.value;
  }
  set(key: string, value: V): void {
    if (this.store.size >= this.max) this.store.delete(this.store.keys().next().value as string); // oldest first
    this.store.set(key, { value, expires: this.now() + this.ttlMs });
  }
  // Returns { value, cached }. Failures are never cached.
  async wrap(key: string, load: () => Promise<V>): Promise<{ value: V; cached: boolean }> {
    const hit = this.get(key);
    if (hit !== undefined) return { value: hit, cached: true };
    let p = this.inflight.get(key);
    const shared = !!p;
    if (!p) {
      p = load().then((v) => { this.set(key, v); return v; }).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return { value: await p, cached: shared };
  }
  clear(): void { this.store.clear(); }
  get size(): number { return this.store.size; }
}
