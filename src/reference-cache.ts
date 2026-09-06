export interface ReferenceCacheSnapshot {
  readonly size: number;
  readonly inFlight: number;
  readonly hits: number;
  readonly misses: number;
  readonly invalidations: number;
  readonly ttlSeconds: number;
}

interface Entry {
  readonly value: unknown;
  readonly expiresAt: number;
}

const entries = new Map<string, Entry>();
const inFlight = new Map<string, Promise<unknown>>();
let hits = 0;
let misses = 0;
let invalidations = 0;
let generation = 0;

/** Cache small server-owned reference datasets, never mutable player state. */
export async function cachedReferenceData<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const cached = entries.get(key);
  if (cached && cached.expiresAt > now) {
    hits += 1;
    return cached.value as T;
  }
  if (cached) entries.delete(key);

  const pending = inFlight.get(key);
  if (pending) return pending as Promise<T>;

  misses += 1;
  const loadGeneration = generation;
  const load = loader().then((value) => {
    if (generation === loadGeneration) {
      entries.set(key, { value, expiresAt: Date.now() + ttlMs() });
    }
    return value;
  }).finally(() => {
    if (inFlight.get(key) === load) inFlight.delete(key);
  });
  inFlight.set(key, load);
  return load;
}

export function invalidateReferenceData(...keys: string[]): void {
  generation += 1;
  invalidations += 1;
  if (keys.length === 0) {
    entries.clear();
    inFlight.clear();
  } else {
    for (const key of keys) {
      entries.delete(key);
      inFlight.delete(key);
    }
  }
}

export function referenceCacheSnapshot(): ReferenceCacheSnapshot {
  const now = Date.now();
  for (const [key, entry] of entries) if (entry.expiresAt <= now) entries.delete(key);
  return {
    size: entries.size,
    inFlight: inFlight.size,
    hits,
    misses,
    invalidations,
    ttlSeconds: ttlMs() / 1000,
  };
}

function ttlMs(): number {
  return positiveInt(process.env.RC_REFERENCE_CACHE_TTL_SECONDS, 300) * 1000;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
