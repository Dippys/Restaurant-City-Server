import { defineConfig } from 'prisma/config';
import { resolve } from 'node:path';

if (process.env.NODE_ENV === 'production' && !process.env.RC_DB_PATH) {
  throw new Error('RC_DB_PATH is required in production; keep player data outside the release directory.');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.RC_DB_PATH ? `file:///${resolve(process.env.RC_DB_PATH).replace(/\\/g, '/')}` : 'file:./dev.db',
  },
});
