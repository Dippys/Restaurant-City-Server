export interface ExpiringCounter {
  count: number;
  resetAt: number;
}

/**
 * A small insertion-ordered store for rate-limit state. Expired entries are
 * removed opportunistically and the oldest key is evicted at the hard limit,
 * so attacker-controlled identities cannot grow process memory indefinitely.
 */
export class BoundedExpiringCounters {
  private readonly entries = new Map<string, ExpiringCounter>();

  constructor(private readonly maxEntries: number) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: string, now = Date.now()): ExpiringCounter | undefined {
    const value = this.entries.get(key);
    if (!value) return undefined;
    if (value.resetAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return value;
  }

  set(key: string, value: ExpiringCounter, now = Date.now()): void {
    this.pruneExpired(now);
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > Math.max(1, this.maxEntries)) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  pruneExpired(now = Date.now()): void {
    for (const [key, value] of this.entries) {
      if (value.resetAt <= now) this.entries.delete(key);
    }
  }
}
