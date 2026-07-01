/**
 * A tiny single-value cache with TTL and in-flight de-duplication.
 *
 * The catalog is expensive to build (dozens of upstream museum API calls), so
 * we build it once and reuse it until the TTL expires. Concurrent requests that
 * arrive during a (re)build share the same promise instead of stampeding the
 * upstream API.
 */
export class TtlCache<T> {
  private value: T | null = null;
  private expiresAt = 0;
  private inflight: Promise<T> | null = null;

  constructor(
    private readonly ttlMs: number,
    private readonly loader: () => Promise<T>,
  ) {}

  /** Return the cached value, refreshing it if missing or stale. */
  async get(): Promise<T> {
    const now = Date.now();
    if (this.value !== null && now < this.expiresAt) {
      return this.value;
    }
    if (this.inflight) return this.inflight;

    this.inflight = this.loader()
      .then((result) => {
        this.value = result;
        this.expiresAt = Date.now() + this.ttlMs;
        return result;
      })
      .finally(() => {
        this.inflight = null;
      });

    return this.inflight;
  }

  /** Drop the cached value so the next `get()` rebuilds. */
  clear(): void {
    this.value = null;
    this.expiresAt = 0;
  }
}
