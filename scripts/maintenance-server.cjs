'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');

function loadProjectEnv(filename = path.join(projectRoot, '.env')) {
  if (!fs.existsSync(filename)) return;
  for (const line of fs.readFileSync(filename, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || Object.prototype.hasOwnProperty.call(process.env, match[1])) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    process.env[match[1]] = value;
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function maintenanceOptions(env = process.env) {
  return {
    host: env.HOST || '0.0.0.0',
    port: positiveInteger(env.PORT, 8090),
    retrySeconds: positiveInteger(env.RC_MAINTENANCE_RETRY_SECONDS, 300),
    message: env.RC_MAINTENANCE_MESSAGE || 'Our chefs are making a few improvements. Please check back shortly.',
  };
}

function createMaintenanceServer(options = maintenanceOptions()) {
  const template = fs.readFileSync(path.join(projectRoot, 'public', 'maintenance.html'), 'utf8');
  const html = template
    .replaceAll('{{MAINTENANCE_MESSAGE}}', escapeHtml(options.message))
    .replaceAll('{{RETRY_SECONDS}}', String(options.retrySeconds));
  const body = Buffer.from(html);

  return http.createServer((req, res) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    const headers = {
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-Robots-Tag': 'noindex, nofollow',
    };

    if (pathname === '/health' || pathname === '/__health') {
      const health = Buffer.from(JSON.stringify({ status: 'maintenance' }));
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': health.length });
      res.end(req.method === 'HEAD' ? undefined : health);
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      res.writeHead(503, {
        ...headers,
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': body.length,
        'Retry-After': String(options.retrySeconds),
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }

    const unavailable = Buffer.from(JSON.stringify({ error: 'service_unavailable', message: options.message }));
    res.writeHead(503, {
      ...headers,
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': unavailable.length,
      'Retry-After': String(options.retrySeconds),
    });
    res.end(unavailable);
  });
}

function main() {
  loadProjectEnv();
  const options = maintenanceOptions();
  const server = createMaintenanceServer(options);
  server.once('error', (error) => {
    console.error(`Maintenance server failed: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(options.port, options.host, () => {
    console.log('============================================================');
    console.log(' Restaurant City Reborn - MAINTENANCE MODE');
    console.log('============================================================');
    console.log(` Listening : http://localhost:${options.port}`);
    console.log(' Stop with : Ctrl+C');
    console.log('============================================================');
  });
}

if (require.main === module) main();

module.exports = { createMaintenanceServer, loadProjectEnv, maintenanceOptions };
