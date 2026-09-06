import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient as PostgresqlPrismaClient } from '../../generated/postgresql';
import * as path from 'node:path';
import { loadProjectEnv } from '../env';

// Database modules are imported before main() calls loadConfig(). Load .env at
// this boundary so every entry point selects the configured provider before the
// singleton Prisma client is constructed. An RC_DB_PATH explicitly supplied by
// the parent process remains the test/rollback override even if .env names PG.
const explicitSqlitePath = process.env.RC_DB_PATH?.trim();
loadProjectEnv();
const postgresUrl = explicitSqlitePath ? undefined : process.env.DATABASE_URL?.trim();
export const databaseProvider = postgresUrl ? 'PostgreSQL' : 'SQLite';

export interface DatabasePoolSnapshot {
  readonly provider: 'PostgreSQL' | 'SQLite';
  readonly max: number;
  readonly total: number;
  readonly idle: number;
  readonly waiting: number;
  readonly errors: number;
  readonly lastError: string;
  readonly waitingHighWater: number;
  readonly saturatedSamples: number;
  readonly lastSaturatedAt: string;
  readonly consecutiveSaturatedSamples: number;
}

let postgresPool: Pool | undefined;
let postgresPoolErrors = 0;
let postgresPoolLastError = '';
let postgresWaitingHighWater = 0;
let postgresSaturatedSamples = 0;
let postgresLastSaturatedAt = '';
let postgresConsecutiveSaturatedSamples = 0;
let postgresLastAlertAt = 0;

if (process.env.NODE_ENV === 'production' && !postgresUrl && !process.env.RC_DB_PATH) {
  throw new Error('DATABASE_URL is required in production (RC_DB_PATH remains available for SQLite rollback).');
}

function createClient(): PrismaClient {
  if (postgresUrl) {
    const configuredPoolMax = Number.parseInt(process.env.RC_DB_POOL_MAX ?? '', 10);
    const poolMax = Number.isInteger(configuredPoolMax) && configuredPoolMax > 0 ? configuredPoolMax : 20;
    const statementTimeoutMs = positiveInt(process.env.RC_DB_STATEMENT_TIMEOUT_MS, 30_000);
    postgresPool = new Pool({
      connectionString: postgresUrl,
      max: poolMax,
      connectionTimeoutMillis: 15_000,
      idleTimeoutMillis: 30_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      application_name: `restaurant-city-server:${process.pid}`,
      // Bound individual statements, including lock waits. Interactive
      // transaction lifetime remains governed separately by Prisma.
      statement_timeout: statementTimeoutMs,
      query_timeout: statementTimeoutMs + 5_000,
    });
    const poolMonitor = setInterval(samplePostgresPool, 1000);
    poolMonitor.unref();
    const adapter = new PrismaPg(postgresPool, {
      disposeExternalPool: true,
      onPoolError: (error) => {
        postgresPoolErrors += 1;
        postgresPoolLastError = safeError(error);
        console.error(`PostgreSQL idle pool client error: ${postgresPoolLastError}`);
      },
    });
    return new PostgresqlPrismaClient({
      adapter,
      transactionOptions: { maxWait: 15_000, timeout: 30_000 },
    }) as unknown as PrismaClient;
  }

  const databasePath = path.resolve(explicitSqlitePath || process.env.RC_DB_PATH || path.join(__dirname, '..', '..', 'dev.db'));
  const adapter = new PrismaBetterSqlite3({ url: databasePath });
  return new PrismaClient({ adapter });
}

export const prisma = createClient();

export function databasePoolSnapshot(): DatabasePoolSnapshot {
  if (!postgresPool) {
    return { provider: 'SQLite', max: 0, total: 0, idle: 0, waiting: 0, errors: 0, lastError: '', waitingHighWater: 0, saturatedSamples: 0, lastSaturatedAt: '', consecutiveSaturatedSamples: 0 };
  }
  return {
    provider: 'PostgreSQL',
    max: postgresPool.options.max ?? 10,
    total: postgresPool.totalCount,
    idle: postgresPool.idleCount,
    waiting: postgresPool.waitingCount,
    errors: postgresPoolErrors,
    lastError: postgresPoolLastError,
    waitingHighWater: postgresWaitingHighWater,
    saturatedSamples: postgresSaturatedSamples,
    lastSaturatedAt: postgresLastSaturatedAt,
    consecutiveSaturatedSamples: postgresConsecutiveSaturatedSamples,
  };
}

function samplePostgresPool(): void {
  if (!postgresPool) return;
  postgresWaitingHighWater = Math.max(postgresWaitingHighWater, postgresPool.waitingCount);
  if (postgresPool.totalCount >= (postgresPool.options.max ?? 10) && postgresPool.idleCount === 0) {
    postgresSaturatedSamples += 1;
    postgresConsecutiveSaturatedSamples += 1;
    postgresLastSaturatedAt = new Date().toISOString();
    const now = Date.now();
    if (postgresConsecutiveSaturatedSamples >= 5 && now - postgresLastAlertAt >= 60_000) {
      postgresLastAlertAt = now;
      console.warn(`PostgreSQL pool saturated: ${postgresPool.totalCount}/${postgresPool.options.max ?? 10} connections, ${postgresPool.waitingCount} waiting.`);
    }
  } else {
    postgresConsecutiveSaturatedSamples = 0;
  }
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]+/g, ' ').slice(0, 500);
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
