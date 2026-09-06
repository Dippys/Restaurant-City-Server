import type { ActiveAccount } from './session';

interface CacheEntry {
  readonly account: ActiveAccount | null;
  readonly expiresAt: number;
}

export interface SessionCacheLoad {
  readonly account: ActiveAccount | null;
  /** Upper bound imposed by the durable session expiry. */
  readonly ttlMs?: number;
}

export interface SessionCacheSnapshot {
  readonly size: number;
  readonly inFlight: number;
  readonly hits: number;
  readonly misses: number;
  readonly coalesced: number;
  readonly evictions: number;
  readonly invalidations: number;
  readonly maxEntries: number;
  readonly positiveTtlSeconds: number;
  readonly negativeTtlSeconds: number;
}

const entries = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<ActiveAccount | null>>();
let hits = 0;
let misses = 0;
let coalesced = 0;
let evictions = 0;
let invalidations = 0;
let generation = 0;

function positiveTtlMs(): number {
  return positiveInt(process.env.RC_SESSION_CACHE_TTL_SECONDS, 30) * 1000;
}

function negativeTtlMs(): number {
  return positiveInt(process.env.RC_SESSION_CACHE_NEGATIVE_TTL_SECONDS, 2) * 1000;
}

function maxEntries(): number {
  return positiveInt(process.env.RC_SESSION_CACHE_MAX, 5000);
}

/**
 * Resolve a session once per short TTL and coalesce concurrent misses for the
 * same token. Only authentication metadata is cached; gameplay state remains
 * database-authoritative.
 */
export async function cachedSessionAccount(
  tokenHash: string,
  loader: () => Promise<SessionCacheLoad>,
): Promise<ActiveAccount | null> {
  const now = Date.now();
  const cached = entries.get(tokenHash);
  if (cached && cached.expiresAt > now) {
    hits += 1;
    // Refresh insertion order so pruning behaves like a small LRU.
    entries.delete(tokenHash);
    entries.set(tokenHash, cached);
    return cached.account;
  }
  if (cached) entries.delete(tokenHash);

  const pending = inFlight.get(tokenHash);
  if (pending) {
    coalesced += 1;
    return pending;
  }

  misses += 1;
  const loadGeneration = generation;
  const load = loader().then(({ account, ttlMs }) => {
    if (generation === loadGeneration) {
      const configuredTtl = account ? positiveTtlMs() : negativeTtlMs();
      setEntry(tokenHash, account, Math.max(1, Math.min(configuredTtl, ttlMs ?? configuredTtl)));
    }
    return account;
  }).finally(() => {
    if (inFlight.get(tokenHash) === load) inFlight.delete(tokenHash);
  });
  inFlight.set(tokenHash, load);
  return load;
}

export function primeSessionCache(tokenHash: string, account: ActiveAccount): void {
  setEntry(tokenHash, account, positiveTtlMs());
}

/** Clear all cached authentication after a bulk session/account mutation. */
export function invalidateAllCachedSessions(): void {
  if (entries.size > 0 || inFlight.size > 0) invalidations += 1;
  generation += 1;
  entries.clear();
  // In-flight reads cannot be cancelled, but clearing their registration
  // prevents later requests from joining a result made stale by revocation.
  inFlight.clear();
}

export function sessionCacheSnapshot(): SessionCacheSnapshot {
  pruneExpired();
  return {
    size: entries.size,
    inFlight: inFlight.size,
    hits,
    misses,
    coalesced,
    evictions,
    invalidations,
    maxEntries: maxEntries(),
    positiveTtlSeconds: positiveTtlMs() / 1000,
    negativeTtlSeconds: negativeTtlMs() / 1000,
  };
}

function setEntry(tokenHash: string, account: ActiveAccount | null, ttlMs: number): void {
  entries.delete(tokenHash);
  entries.set(tokenHash, { account, expiresAt: Date.now() + ttlMs });
  pruneExpired();
  while (entries.size > maxEntries()) {
    const oldest = entries.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    entries.delete(oldest);
    evictions += 1;
  }
}

function pruneExpired(now = Date.now()): void {
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= now) entries.delete(key);
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
