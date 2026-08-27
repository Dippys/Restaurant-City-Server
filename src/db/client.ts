import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import * as path from 'node:path';

if (process.env.NODE_ENV === 'production' && !process.env.RC_DB_PATH) {
  throw new Error('RC_DB_PATH is required in production; keep player data outside the release directory.');
}

const databasePath = path.resolve(process.env.RC_DB_PATH ?? path.join(__dirname, '..', '..', 'dev.db'));
const adapter = new PrismaBetterSqlite3({ url: databasePath });

export const prisma = new PrismaClient({ adapter });
