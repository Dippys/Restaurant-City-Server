import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Load the repository .env without replacing values explicitly supplied by the
 * service manager or shell.
 */
export function loadProjectEnv(serverRoot = path.resolve(__dirname, '..')): void {
  loadEnvFile(path.join(serverRoot, '.env'));
}

export function loadEnvFile(filename: string): void {
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
