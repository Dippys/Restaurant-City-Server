'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadProjectEnv } = require('../dist/env.js');

test('project environment is loaded before database selection without overriding service variables', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-env-'));
  const loadedKey = `RC_ENV_LOADED_${process.pid}`;
  const preservedKey = `RC_ENV_PRESERVED_${process.pid}`;
  fs.writeFileSync(path.join(root, '.env'), `${loadedKey}="from file"\n${preservedKey}=from-file\n`);
  delete process.env[loadedKey];
  process.env[preservedKey] = 'from-service';

  try {
    loadProjectEnv(root);
    assert.equal(process.env[loadedKey], 'from file');
    assert.equal(process.env[preservedKey], 'from-service');
  } finally {
    delete process.env[loadedKey];
    delete process.env[preservedKey];
    fs.rmSync(root, { recursive: true, force: true });
  }
});
