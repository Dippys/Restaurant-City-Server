import { defineConfig } from 'prisma/config';
import { resolve } from 'node:path';

const postgresUrl = process.env.DATABASE_URL?.trim();

if (process.env.NODE_ENV === 'production' && !postgresUrl && !process.env.RC_DB_PATH) {
  throw new Error('DATABASE_URL is required in production (RC_DB_PATH remains available for SQLite rollback).');
}

export default defineConfig({
  schema: postgresUrl ? 'prisma/schema.postgresql.prisma' : 'prisma/schema.prisma',
  datasource: {
    url: postgresUrl || (process.env.RC_DB_PATH ? `file:///${resolve(process.env.RC_DB_PATH).replace(/\\/g, '/')}` : 'file:./dev.db'),
  },
});
