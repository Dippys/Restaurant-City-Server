#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'prisma', 'schema.prisma');
const targetPath = path.join(root, 'prisma', 'schema.postgresql.prisma');
const generatedClient = '../generated/postgresql';

function renderPostgresqlSchema(source) {
  const withProvider = source.replace(
    /datasource db \{\s*provider\s*=\s*"sqlite"\s*\}/m,
    'datasource db {\n  provider = "postgresql"\n}',
  );
  if (withProvider === source) throw new Error('Could not find the SQLite datasource in prisma/schema.prisma.');
  return withProvider.replace(
    /generator client \{\s*provider\s*=\s*"prisma-client-js"\s*\}/m,
    `generator client {\n  provider = "prisma-client-js"\n  output   = "${generatedClient}"\n}`,
  );
}

const rendered = renderPostgresqlSchema(fs.readFileSync(sourcePath, 'utf8'));
if (!fs.existsSync(targetPath) || fs.readFileSync(targetPath, 'utf8') !== rendered) {
  fs.writeFileSync(targetPath, rendered);
}

module.exports = { renderPostgresqlSchema };
