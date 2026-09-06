import { prisma } from './db/client';

export interface DatabaseReadiness {
  readonly status: 'ready' | 'unavailable';
  readonly checkedAt: string;
  readonly latencyMs: number;
  readonly error?: string;
}

let lastWarningAt = 0;

/**
 * Coalesced, briefly cached database readiness. A timed-out probe remains the
 * only in-flight query until it settles, preventing health checks from piling
 * up behind an exhausted pool.
 */
export class DatabaseReadinessProbe {
  private cached: { readonly value: DatabaseReadiness; readonly expiresAt: number } | undefined;
  private inFlight: Promise<DatabaseReadiness> | undefined;

  constructor(
    private readonly query: () => Promise<unknown>,
    private readonly cacheMs: () => number,
    private readonly timeoutMs: () => number,
    private readonly warn: (error: unknown) => void = () => undefined,
  ) {}

  async check(): Promise<DatabaseReadiness> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt > now) return this.cached.value;
    if (!this.inFlight) {
      const started = Date.now();
      this.inFlight = this.query()
      .then((): DatabaseReadiness => ({ status: 'ready', checkedAt: new Date().toISOString(), latencyMs: Date.now() - started }))
      .catch((error): DatabaseReadiness => {
        this.warn(error);
        return { status: 'unavailable', checkedAt: new Date().toISOString(), latencyMs: Date.now() - started, error: 'database probe failed' };
      })
      .then((value) => {
        this.cached = { value, expiresAt: Date.now() + this.cacheMs() };
        return value;
      })
      .finally(() => { this.inFlight = undefined; });
    }
    return this.withTimeout(this.inFlight, this.timeoutMs());
  }

  private async withTimeout(probe: Promise<DatabaseReadiness>, timeoutMs: number): Promise<DatabaseReadiness> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        probe,
        new Promise<DatabaseReadiness>((resolve) => {
          timeout = setTimeout(() => {
            this.warn(new Error('probe timed out'));
            resolve({
              status: 'unavailable', checkedAt: new Date().toISOString(), latencyMs: timeoutMs,
              error: 'database readiness probe timed out',
            });
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

const readinessProbe = new DatabaseReadinessProbe(
  () => prisma.$queryRawUnsafe('SELECT 1'),
  readinessCacheMs,
  readinessTimeoutMs,
  warnReadiness,
);

export function databaseReadiness(): Promise<DatabaseReadiness> {
  return readinessProbe.check();
}

function readinessCacheMs(): number {
  return positiveInt(process.env.RC_HEALTH_READY_CACHE_MS, 5000);
}

function readinessTimeoutMs(): number {
  return positiveInt(process.env.RC_HEALTH_READY_TIMEOUT_MS, 5000);
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]+/g, ' ').slice(0, 300);
}

function warnReadiness(error: unknown): void {
  const now = Date.now();
  if (now - lastWarningAt < 60_000) return;
  lastWarningAt = now;
  console.warn(`Database readiness failed: ${safeError(error)}`);
}
