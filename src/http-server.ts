import * as fs from 'node:fs';
import * as http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as path from 'node:path';
import type { ServerConfig } from './config';
import { RequestLog } from './request-log';
import { StaticFileIndex } from './static-files';
import type { CapturedRequest } from './types';
import { buildResponse } from './rpc';

const CROSSDOMAIN = [
  '<?xml version="1.0"?>',
  '<!DOCTYPE cross-domain-policy SYSTEM "http://www.adobe.com/xml/dtds/cross-domain-policy.dtd">',
  '<cross-domain-policy>',
  '  <allow-access-from domain="*" to-ports="*"/>',
  '  <allow-http-request-headers-from domain="*" headers="*"/>',
  '</cross-domain-policy>',
  '',
].join('\n');

const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

export interface RestaurantCityServer {
  readonly httpServer: http.Server;
  readonly staticFiles: StaticFileIndex;
  readonly requestLog: RequestLog;
}

export function createServer(config: ServerConfig): RestaurantCityServer {
  const requestLog = new RequestLog(config.maxLogEntries);
  const staticFiles = new StaticFileIndex(config);

  const httpServer = http.createServer((req, res) => {
    handleRequest(config, staticFiles, requestLog, req, res).catch((error) => {
      console.error(error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end('internal server error');
    });
  });

  return { httpServer, staticFiles, requestLog };
}

async function handleRequest(
  config: ServerConfig,
  staticFiles: StaticFileIndex,
  requestLog: RequestLog,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  const url = new URL(req.url || '/', `http://localhost:${config.port}`);
  const pathname = decodeURIComponent(url.pathname);

  const entry = createEntry(requestLog.nextId(), req, url, pathname, body);

  if (pathname === '/__dash' || pathname === '/' || pathname === '/dashboard') {
    const html = fs.readFileSync(path.join(config.serverRoot, 'public', 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (pathname === '/__events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('retry: 2000\n\n');
    requestLog.addSseClient(res);
    req.on('close', () => requestLog.removeSseClient(res));
    return;
  }

  if (pathname === '/__api/requests') {
    sendJson(res, requestLog.snapshot());
    return;
  }

  if (pathname === '/__api/clear') {
    requestLog.clear();
    sendJson(res, { ok: true });
    return;
  }

  if (pathname === '/__api/reindex') {
    staticFiles.reindex();
    sendJson(res, { ok: true, files: staticFiles.size });
    return;
  }

  if (pathname === '/crossdomain.xml') {
    entry.status = 200;
    entry.matched = '(crossdomain policy)';
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(CROSSDOMAIN);
    requestLog.record(entry);
    return;
  }

  if (isRpcPath(pathname)) {
    handleRpc(res, body, entry);
    requestLog.record(entry);
    return;
  }

  if (/^\/news\d+\.png$/i.test(pathname)) {
    sendGeneratedPng(res, entry, '(generated newsletter placeholder)');
    requestLog.record(entry);
    return;
  }

  const match = staticFiles.find(pathname);
  if (match) {
    sendStaticFile(res, match.fullPath, match.mimeType, entry, match.displayPath);
    requestLog.record(entry);
    return;
  }

  entry.status = 404;
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end('not found');
  requestLog.record(entry);
}

function handleRpc(res: ServerResponse, body: Buffer, entry: CapturedRequest): void {
  entry.kind = 'rpc';

  let response: Buffer;
  try {
    const result = buildResponse(body);
    response = result.response;
    entry.rpc = result.summary;
  } catch (error) {
    response = Buffer.from([0, 0, 0]);
    entry.rpc = { call: 'parse-error', error: error instanceof Error ? error.message : String(error) };
  }

  entry.respLen = response.length;
  entry.respHex = response.toString('hex');
  entry.status = 200;

  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': response.length,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(response);
}

function sendGeneratedPng(res: ServerResponse, entry: CapturedRequest, displayPath: string): void {
  entry.status = 200;
  entry.matched = displayPath;
  entry.respLen = TRANSPARENT_PNG.length;

  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': TRANSPARENT_PNG.length,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(TRANSPARENT_PNG);
}

function sendStaticFile(
  res: ServerResponse,
  fullPath: string,
  mimeType: string,
  entry: CapturedRequest,
  displayPath: string,
): void {
  try {
    const data = fs.readFileSync(fullPath);
    entry.status = 200;
    entry.matched = displayPath;
    entry.respLen = data.length;
    res.writeHead(200, {
      'Content-Type': mimeType,
      'Content-Length': data.length,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    entry.status = 500;
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('read error');
  }
}

function createEntry(id: number, req: IncomingMessage, url: URL, pathname: string, body: Buffer): CapturedRequest {
  return {
    id,
    time: new Date().toISOString(),
    method: req.method,
    path: pathname,
    rawUrl: req.url,
    query: Object.fromEntries(url.searchParams.entries()),
    headers: req.headers,
    bodyLen: body.length,
    bodyHex: body.length ? body.toString('hex') : '',
    bodyBase64: body.length ? body.toString('base64') : '',
    bodyText: body.length ? utf8Preview(body) : '',
    kind: 'http',
    matched: null,
    status: 0,
  };
}

function isRpcPath(pathname: string): boolean {
  return /\/g\/rpc\//i.test(pathname) || /\/g\/billing\//i.test(pathname) || /\/g\/fbfeed\//i.test(pathname);
}

function sendJson(res: ServerResponse, value: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function utf8Preview(buf: Buffer): string {
  let value = '';
  for (const byte of buf) {
    value += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.';
  }
  return value;
}
