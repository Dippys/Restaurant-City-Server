export interface WorkLimiterSnapshot {
  readonly active: number;
  readonly waiting: number;
  readonly serializedKeys: number;
  readonly maxConcurrency: number;
}

/**
 * Serializes work for one key and caps total active work across all keys.
 * Waiters consume no database connection until their task is admitted.
 */
export class KeyedWorkLimiter {
  private active = 0;
  private waiting = 0;
  private readonly slotWaiters: Array<() => void> = [];
  private readonly keyTails = new Map<string, Promise<void>>();

  constructor(readonly maxConcurrency: number) {
    this.maxConcurrency = Math.max(1, Math.floor(maxConcurrency));
  }

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.keyTails.get(key) ?? Promise.resolve();
    let releaseKey!: () => void;
    const current = new Promise<void>((resolve) => { releaseKey = resolve; });
    const tail = previous.catch(() => undefined).then(() => current);
    this.keyTails.set(key, tail);

    await previous.catch(() => undefined);
    try {
      return await this.runWithSlot(task);
    } finally {
      releaseKey();
      if (this.keyTails.get(key) === tail) this.keyTails.delete(key);
    }
  }

  snapshot(): WorkLimiterSnapshot {
    return {
      active: this.active,
      waiting: this.waiting,
      serializedKeys: this.keyTails.size,
      maxConcurrency: this.maxConcurrency,
    };
  }

  private async runWithSlot<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrency) {
      this.waiting += 1;
      try {
        await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
      } finally {
        this.waiting = Math.max(0, this.waiting - 1);
      }
    } else {
      this.active += 1;
    }
    try {
      return await task();
    } finally {
      const next = this.slotWaiters.shift();
      if (next) next();
      else this.active = Math.max(0, this.active - 1);
    }
  }
}

const configuredPoolMax = positiveInt(process.env.RC_DB_POOL_MAX, 20);
const safeSaveConcurrency = Math.max(1, configuredPoolMax - 4);
const defaultSaveConcurrency = Math.min(8, safeSaveConcurrency);
export const profileSaveWork = new KeyedWorkLimiter(
  Math.min(safeSaveConcurrency, positiveInt(process.env.RC_PROFILE_SAVE_CONCURRENCY, defaultSaveConcurrency)),
);

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
