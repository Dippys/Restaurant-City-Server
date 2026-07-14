import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ServerConfig {
  readonly port: number;
  readonly host: string;
  readonly serverRoot: string;
  readonly rcRoot: string;
  readonly binXmlRoot: string;
  readonly rebuiltAssetRoot: string;
  readonly originalAssetRoot: string;
  readonly rebuiltSwf: string;
  readonly maxLogEntries: number;
}

export function loadConfig(): ServerConfig {
  const serverRoot = path.resolve(__dirname, '..');
  loadEnvFile(path.join(serverRoot, '.env'));
  if (process.env.NODE_ENV === 'production' && !process.env.RC_PIN_PEPPER) {
    throw new Error('RC_PIN_PEPPER is required when NODE_ENV=production.');
  }
  const rcRoot = path.resolve(serverRoot, '..');

  return {
    port: Number(process.env.PORT) || 8090,
    host: process.env.HOST || '0.0.0.0',
    serverRoot,
    rcRoot,
    binXmlRoot: path.join(rcRoot, 'bin-xml'),
    rebuiltAssetRoot: path.join(rcRoot, 'decompiled', 'bin'),
    originalAssetRoot: path.join(rcRoot, 'backup'),
    rebuiltSwf: path.join(rcRoot, 'decompiled', 'game', 'bin', 'game.swf'),
    maxLogEntries: Number(process.env.MAX_LOG_ENTRIES) || 500,
  };
}

function loadEnvFile(filename: string): void {
  if (!fs.existsSync(filename)) return;

  for (const line of fs.readFileSync(filename, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && process.env[key] === undefined) process.env[key] = value;
  }
}
