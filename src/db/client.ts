import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaPg } from '@prisma/adapter-pg';
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

if (process.env.NODE_ENV === 'production' && !postgresUrl && !process.env.RC_DB_PATH) {
  throw new Error('DATABASE_URL is required in production (RC_DB_PATH remains available for SQLite rollback).');
}

function createClient(): PrismaClient {
  if (postgresUrl) {
    const adapter = new PrismaPg({ connectionString: postgresUrl });
    return new PostgresqlPrismaClient({ adapter }) as unknown as PrismaClient;
  }

  const databasePath = path.resolve(explicitSqlitePath || process.env.RC_DB_PATH || path.join(__dirname, '..', '..', 'dev.db'));
  const adapter = new PrismaBetterSqlite3({ url: databasePath });
  return new PrismaClient({ adapter });
}

export const prisma = createClient();
