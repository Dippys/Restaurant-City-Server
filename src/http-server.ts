import * as fs from 'node:fs';
import * as http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import type { ServerConfig } from './config';
import {
  addAdminOwnedItem,
  createAdminGameEvent,
  createAdminMail,
  createAdminUser,
  deleteAdminEmployee,
  deleteAdminFloor,
  deleteAdminGameEvent,
  deleteAdminGardenPlot,
  deleteAdminIngredient,
  deleteAdminIngredientMarketItem,
  deleteAdminInventoryItem,
  deleteAdminMail,
  deleteAdminOwnedItem,
  deleteAdminPricepoint,
  deleteAdminPurchasableItem,
  deleteAdminUser,
  itemCatalog,
  listEconomy,
  listAdminUsers,
  resetAdminDatabase,
  updateAdminMail,
  updateAdminOwnedItem,
  updateAdminUser,
  upsertAdminEmployee,
  upsertAdminFloor,
  upsertAdminGardenPlot,
  upsertAdminIngredient,
  upsertAdminIngredientMarketItem,
  upsertAdminInventoryItem,
  upsertAdminPricepoint,
  upsertAdminPurchasableItem,
} from './db/admin-store';
import { ensureLoginAccount } from './db/profile-store';
import { loginAccount, purgeExpiredSessions, registerAccount, revokeSession, updateAccountSettings } from './db/auth-store';
import { latestStoredImage } from './db/rpc-store';
import { RequestLog } from './request-log';
import { StaticFileIndex } from './static-files';
import type { CapturedRequest } from './types';
import { buildResponse } from './rpc';
import { writeString } from './rpc/codec';
import { accountFromRequest, accountFromUsername, clientIp, logoutCookie, requestIsSecure, sessionCookie } from './session';
import type { ActiveAccount } from './session';
import { enqueueGlobalLiveEvent, enqueueLiveEvent, listOnlineUsers, LIVE_EVENT_ALERT } from './live-events';

const CROSSDOMAIN = [
  '<?xml version="1.0"?>',
  '<!DOCTYPE cross-domain-policy SYSTEM "http://www.adobe.com/xml/dtds/cross-domain-policy.dtd">',
  '<cross-domain-policy>',
  '  <site-control permitted-cross-domain-policies="none"/>',
  '</cross-domain-policy>',
  '',
].join('\n');

export interface RestaurantCityServer {
  readonly httpServer: http.Server;
  readonly staticFiles: StaticFileIndex;
  readonly requestLog: RequestLog;
}

export function createServer(config: ServerConfig): RestaurantCityServer {
  const requestLog = new RequestLog(config.maxLogEntries);
  const staticFiles = new StaticFileIndex(config);

  const httpServer = http.createServer((req, res) => {
    applySecurityHeaders(res);
    handleRequest(config, staticFiles, requestLog, req, res).catch((error) => {
      console.error(error);
      if (!res.headersSent) {
        res.writeHead(error instanceof RequestTooLargeError ? 413 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end(error instanceof RequestTooLargeError ? 'request too large' : 'internal server error');
    });
  });

  purgeExpiredSessions().catch((error) => console.error('Session cleanup failed:', error));

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

  if (pathname === '/') {
    serveHtml(config, res, 'home.html');
    return;
  }

  if (pathname === '/login' || pathname === '/signup') {
    serveHtml(config, res, 'auth.html');
    return;
  }

  if (pathname === '/terms' || pathname === '/privacy' || pathname === '/cookies' || pathname === '/community-guidelines') {
    serveHtml(config, res, 'legal.html');
    return;
  }

  if (pathname === '/__dash' || pathname === '/dashboard') {
    if (!(await requireAdmin(req, res))) return;
    const html = fs.readFileSync(path.join(config.serverRoot, 'public', 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (pathname === '/game' || pathname === '/play') {
    if (!(await requireAccount(req, res, true))) return;
    const html = fs.readFileSync(path.join(config.serverRoot, 'public', 'game.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (pathname === '/account') {
    if (!(await requireAccount(req, res, true))) return;
    serveHtml(config, res, 'account.html');
    return;
  }

  if (pathname === '/admin' || pathname === '/database') {
    if (!(await requireAdmin(req, res))) return;
    const html = fs.readFileSync(path.join(config.serverRoot, 'public', 'admin.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (pathname === '/__events') {
    if (!(await requireAdmin(req, res))) return;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    requestLog.addSseClient(res);
    req.on('close', () => requestLog.removeSseClient(res));
    return;
  }

  if (pathname === '/__api/requests') {
    if (!(await requireAdmin(req, res))) return;
    sendJson(res, requestLog.snapshot());
    return;
  }

  if (pathname === '/__api/clear') {
    if (!(await requireAdminMutation(req, res))) return;
    requestLog.clear();
    sendJson(res, { ok: true });
    return;
  }

  if (pathname === '/__api/reindex') {
    if (!(await requireAdminMutation(req, res))) return;
    staticFiles.reindex();
    sendJson(res, { ok: true, files: staticFiles.size });
    return;
  }

  if (pathname === '/__api/session' && req.method === 'GET') {
    const account = await accountFromRequest(req);
    sendJson(res, {
      ok: true,
      loggedIn: Boolean(account),
      account: publicAccount(account),
      csrfToken: account?.csrfToken || null,
    });
    return;
  }

  if (pathname === '/__api/login' && req.method === 'POST') {
    try {
      const input = parseJsonBody<{ username?: string }>(body);
      checkAuthRateLimit(req, String(input.username || ''));
      const result = await loginAccount(input, clientIp(req), String(req.headers['user-agent'] || ''));
      if (!result) { recordAuthFailure(req, String(input.username || '')); sendJson(res, { ok: false, error: 'Invalid username or PIN.' }, 401); return; }
      clearAuthFailures(req, String(input.username || ''));
      const profile = await ensureLoginAccount(result.account);
      res.setHeader('Set-Cookie', sessionCookie(result.rawToken, requestIsSecure(req)));
      sendJson(res, { ok: true, account: publicAccount(result.account), csrfToken: result.account.csrfToken, profile });
    } catch (error) {
      const status = error instanceof RateLimitError ? 429 : 400;
      sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, status);
    }
    return;
  }

  if (pathname === '/__api/signup' && req.method === 'POST') {
    try {
      const input = parseJsonBody<{ username?: string }>(body);
      enforceSignupRateLimit(req);
      const result = await registerAccount(parseJsonBody(body), clientIp(req), String(req.headers['user-agent'] || ''));
      const profile = await ensureLoginAccount(result.account);
      res.setHeader('Set-Cookie', sessionCookie(result.rawToken, requestIsSecure(req)));
      sendJson(res, { ok: true, account: publicAccount(result.account), csrfToken: result.account.csrfToken, profile }, 201);
    } catch (error) {
      const status = error instanceof RateLimitError ? 429 : 400;
      sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, status);
    }
    return;
  }

  if (pathname === '/__api/logout' && req.method === 'POST') {
    const account = await requireMutation(req, res);
    if (!account) return;
    await revokeSession(account.sessionId);
    res.setHeader('Set-Cookie', logoutCookie(requestIsSecure(req)));
    sendJson(res, { ok: true });
    return;
  }

  if (pathname === '/__api/account' && req.method === 'PATCH') {
    const account = await requireMutation(req, res);
    if (!account?.id || !account.sessionId) return;
    try {
      await updateAccountSettings(account.id, account.sessionId, parseJsonBody(body));
      sendJson(res, { ok: true });
    } catch (error) {
      sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
    }
    return;
  }

  if (pathname.startsWith('/__api/profile-image/') && req.method === 'GET') {
    await handleProfileImage(pathname, res);
    return;
  }

  if (pathname.startsWith('/__api/live')) {
    if (!(await requireAdminMutationForMethod(req, res))) return;
    await handleLiveApi(req.method || 'GET', pathname, body, res);
    return;
  }

  if (pathname.startsWith('/__api/db')) {
    if (!(await requireAdminMutationForMethod(req, res))) return;
    await handleDatabaseApi(req.method || 'GET', pathname, body, res);
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

  if (pathname === '/theme.css') {
    const fullPath = path.join(config.serverRoot, 'public', 'theme.css');
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      sendStaticFile(res, fullPath, 'text/css; charset=utf-8', entry, 'public/theme.css');
      requestLog.record(entry);
      return;
    }
  }

  const assetMatch = pathname.match(/^\/assets\/([A-Za-z0-9._-]+\.(?:png|jpg|jpeg|gif|svg|webp))$/);
  if (assetMatch) {
    const filename = assetMatch[1];
    const fullPath = path.join(config.serverRoot, 'public', 'assets', filename);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      const ext = path.extname(filename).toLowerCase();
      const assetMime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
      const mimeType = assetMime[ext] || 'application/octet-stream';
      sendStaticFile(res, fullPath, mimeType, entry, `public/assets/${filename}`);
      requestLog.record(entry);
      return;
    }
  }

  const ruffleMatch = pathname.match(/^\/ruffle\/([A-Za-z0-9._-]+)$/);
  if (ruffleMatch) {
    const filename = ruffleMatch[1];
    const fullPath = path.join(config.serverRoot, 'node_modules', '@ruffle-rs', 'ruffle', filename);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      const mimeType = filename.endsWith('.wasm') ? 'application/wasm' : filename.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
      sendStaticFile(res, fullPath, mimeType, entry, `ruffle/${filename}`);
      requestLog.record(entry);
      return;
    }
  }

  if (isRpcPath(pathname)) {
    await handleRpc(req, res, body, entry);
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
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
  requestLog.record(entry);
}

async function handleRpc(req: IncomingMessage, res: ServerResponse, body: Buffer, entry: CapturedRequest): Promise<void> {
  entry.kind = 'rpc';
  const account = await accountFromRequest(req);
  if (!account) {
    entry.status = 401;
    res.writeHead(401, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(Buffer.from([0, 0, 0]));
    return;
  }

  let response: Buffer;
  try {
    const result = await buildResponse(body, account);
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
    'Cache-Control': 'no-store',
  });
  res.end(response);
}

async function handleLiveApi(method: string, pathname: string, body: Buffer, res: ServerResponse): Promise<void> {
  try {
    if (method === 'GET' && pathname === '/__api/live/online') {
      sendJson(res, { ok: true, users: listOnlineUsers() });
      return;
    }

    if (method === 'POST' && pathname === '/__api/live/alert') {
      const input = parseJsonBody<{ scope?: string; networkUid?: string; title?: string; message?: string }>(body);
      const title = cleanLiveText(input.title || 'Restaurant City', 80);
      const message = cleanLiveText(input.message || '', 500);
      if (!message) {
        throw new Error('Message is required.');
      }

      const eventBody = Buffer.concat([writeString(title), writeString(message)]);
      let delivered = 0;
      if (input.scope === 'global') {
        delivered = enqueueGlobalLiveEvent(LIVE_EVENT_ALERT, eventBody);
      } else {
        const networkUid = String(input.networkUid || '').trim();
        if (!networkUid) {
          throw new Error('Choose an online user or send globally.');
        }
        delivered = enqueueLiveEvent(networkUid, LIVE_EVENT_ALERT, eventBody) ? 1 : 0;
      }

      sendJson(res, { ok: true, delivered, users: listOnlineUsers() });
      return;
    }

    sendJson(res, { ok: false, error: 'unknown live route' }, 404);
  } catch (error) {
    sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
  }
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
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    entry.status = 500;
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('read error');
  }
}

async function handleProfileImage(pathname: string, res: ServerResponse): Promise<void> {
  const parts = pathname.split('/').filter(Boolean);
  const networkUid = decodeURIComponent(parts[2] || '');
  const imageType = Number.parseInt((parts[3] || '').replace(/\.png$/i, ''), 10);

  if (!networkUid || !Number.isInteger(imageType)) {
    sendJson(res, { ok: false, error: 'invalid image path' }, 400);
    return;
  }

  const image = await latestStoredImage(networkUid, imageType);
  if (!image) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end('not found');
    return;
  }

  const png = encodeArgbPng(image.data, image.width, image.height);
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': png.length,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(png);
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

async function handleDatabaseApi(method: string, pathname: string, body: Buffer, res: ServerResponse): Promise<void> {
  try {
    const parts = pathname.split('/').filter(Boolean);

    if (method === 'GET' && pathname === '/__api/db/catalog') {
      sendJson(res, { ok: true, items: itemCatalog() });
      return;
    }

    if (method === 'GET' && pathname === '/__api/db/users') {
      sendJson(res, { ok: true, users: await listAdminUsers() });
      return;
    }

    if (method === 'POST' && pathname === '/__api/db/users') {
      sendJson(res, { ok: true, user: await createAdminUser(parseJsonBody(body)) });
      return;
    }

    if (method === 'POST' && pathname === '/__api/db/reset') {
      await resetAdminDatabase();
      sendJson(res, { ok: true });
      return;
    }

    if (method === 'GET' && pathname === '/__api/db/economy') {
      sendJson(res, { ok: true, economy: await listEconomy() });
      return;
    }

    if (parts.length >= 4 && parts[0] === '__api' && parts[1] === 'db' && parts[2] === 'economy') {
      const resource = parts[3] || '';
      const id = parts.length >= 5 ? Number(parts[4]) : null;
      const payload = parseJsonBody<any>(body);

      if (resource === 'pricepoints') {
        if (method === 'POST') {
          sendJson(res, { ok: true, item: await upsertAdminPricepoint(null, payload) });
          return;
        }
        if (id !== null && method === 'PATCH') {
          sendJson(res, { ok: true, item: await upsertAdminPricepoint(id, payload) });
          return;
        }
        if (id !== null && method === 'DELETE') {
          await deleteAdminPricepoint(id);
          sendJson(res, { ok: true });
          return;
        }
      }

      if (resource === 'purchasable-items') {
        if (method === 'POST') {
          sendJson(res, { ok: true, item: await upsertAdminPurchasableItem(null, payload) });
          return;
        }
        if (id !== null && method === 'PATCH') {
          sendJson(res, { ok: true, item: await upsertAdminPurchasableItem(id, payload) });
          return;
        }
        if (id !== null && method === 'DELETE') {
          await deleteAdminPurchasableItem(id);
          sendJson(res, { ok: true });
          return;
        }
      }

      if (resource === 'ingredient-market') {
        if (method === 'POST') {
          sendJson(res, { ok: true, item: await upsertAdminIngredientMarketItem(null, payload) });
          return;
        }
        if (id !== null && method === 'PATCH') {
          sendJson(res, { ok: true, item: await upsertAdminIngredientMarketItem(id, payload) });
          return;
        }
        if (id !== null && method === 'DELETE') {
          await deleteAdminIngredientMarketItem(id);
          sendJson(res, { ok: true });
          return;
        }
      }
    }

    if (parts.length >= 4 && parts[0] === '__api' && parts[1] === 'db' && parts[2] === 'users') {
      const networkUid = decodeURIComponent(parts[3] || '');

      if (parts.length === 4 && method === 'PATCH') {
        sendJson(res, { ok: true, user: await updateAdminUser(networkUid, parseJsonBody(body)) });
        return;
      }

      if (parts.length === 4 && method === 'DELETE') {
        await deleteAdminUser(networkUid);
        sendJson(res, { ok: true });
        return;
      }

      if (parts.length === 5) {
        const resource = parts[4] || '';
        const payload = parseJsonBody<any>(body);

        if (resource === 'items' && method === 'POST') {
          sendJson(res, { ok: true, user: await addAdminOwnedItem(networkUid, payload) });
          return;
        }

        if (resource === 'inventory' && method === 'POST') {
          sendJson(res, { ok: true, user: await upsertAdminInventoryItem(networkUid, null, payload) });
          return;
        }

        if (resource === 'ingredients' && method === 'POST') {
          sendJson(res, { ok: true, user: await upsertAdminIngredient(networkUid, null, payload) });
          return;
        }

        if (resource === 'garden' && method === 'POST') {
          sendJson(res, { ok: true, user: await upsertAdminGardenPlot(networkUid, null, payload) });
          return;
        }

        if (resource === 'floors' && method === 'POST') {
          sendJson(res, { ok: true, user: await upsertAdminFloor(networkUid, null, payload) });
          return;
        }

        if (resource === 'employees' && method === 'POST') {
          sendJson(res, { ok: true, user: await upsertAdminEmployee(networkUid, null, payload) });
          return;
        }

        if (resource === 'mails' && method === 'POST') {
          sendJson(res, { ok: true, user: await createAdminMail(networkUid, payload) });
          return;
        }

        if (resource === 'events' && method === 'POST') {
          sendJson(res, { ok: true, user: await createAdminGameEvent(networkUid, payload) });
          return;
        }
      }

      if (parts.length === 6) {
        const resource = parts[4] || '';
        const resourceId = decodeURIComponent(parts[5] || '');
        const numericId = Number(resourceId);
        const payload = parseJsonBody<any>(body);

        if (resource === 'items') {
          if (method === 'PATCH') {
            sendJson(res, { ok: true, user: await updateAdminOwnedItem(networkUid, numericId, payload) });
            return;
          }
          if (method === 'DELETE') {
            sendJson(res, { ok: true, user: await deleteAdminOwnedItem(networkUid, numericId) });
            return;
          }
        }

        if (resource === 'inventory') {
          if (method === 'PATCH') {
            sendJson(res, { ok: true, user: await upsertAdminInventoryItem(networkUid, numericId, payload) });
            return;
          }
          if (method === 'DELETE') {
            sendJson(res, { ok: true, user: await deleteAdminInventoryItem(networkUid, numericId) });
            return;
          }
        }

        if (resource === 'ingredients') {
          if (method === 'PATCH') {
            sendJson(res, { ok: true, user: await upsertAdminIngredient(networkUid, numericId, payload) });
            return;
          }
          if (method === 'DELETE') {
            sendJson(res, { ok: true, user: await deleteAdminIngredient(networkUid, numericId) });
            return;
          }
        }

        if (resource === 'garden') {
          if (method === 'PATCH') {
            sendJson(res, { ok: true, user: await upsertAdminGardenPlot(networkUid, numericId, payload) });
            return;
          }
          if (method === 'DELETE') {
            sendJson(res, { ok: true, user: await deleteAdminGardenPlot(networkUid, numericId) });
            return;
          }
        }

        if (resource === 'floors') {
          if (method === 'PATCH') {
            sendJson(res, { ok: true, user: await upsertAdminFloor(networkUid, numericId, payload) });
            return;
          }
          if (method === 'DELETE') {
            sendJson(res, { ok: true, user: await deleteAdminFloor(networkUid, numericId) });
            return;
          }
        }

        if (resource === 'employees') {
          if (method === 'PATCH') {
            sendJson(res, { ok: true, user: await upsertAdminEmployee(networkUid, resourceId, payload) });
            return;
          }
          if (method === 'DELETE') {
            sendJson(res, { ok: true, user: await deleteAdminEmployee(networkUid, resourceId) });
            return;
          }
        }

        if (resource === 'mails') {
          if (method === 'PATCH') {
            sendJson(res, { ok: true, user: await updateAdminMail(networkUid, numericId, payload) });
            return;
          }
          if (method === 'DELETE') {
            sendJson(res, { ok: true, user: await deleteAdminMail(networkUid, numericId) });
            return;
          }
        }

        if (resource === 'events' && method === 'DELETE') {
          sendJson(res, { ok: true, user: await deleteAdminGameEvent(networkUid, numericId) });
          return;
        }
      }
    }

    sendJson(res, { ok: false, error: 'not found' }, 404);
  } catch (error) {
    sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
  }
}

function parseJsonBody<T>(body: Buffer): T {
  if (!body.length) {
    return {} as T;
  }

  return JSON.parse(body.toString('utf8')) as T;
}

function sendJson(res: ServerResponse, value: unknown, status = 200): void {
  res.setHeader('Cache-Control', 'no-store');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function serveHtml(config: ServerConfig, res: ServerResponse, filename: string): void {
  const html = fs.readFileSync(path.join(config.serverRoot, 'public', filename));
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function publicAccount(account: ActiveAccount | null): Omit<ActiveAccount, 'csrfToken' | 'sessionId'> | null {
  if (!account) return null;
  const { csrfToken: _csrfToken, sessionId: _sessionId, ...safe } = account;
  return safe;
}

async function requireAccount(req: IncomingMessage, res: ServerResponse, redirect = false): Promise<ActiveAccount | null> {
  const account = await accountFromRequest(req);
  if (account) return account;
  if (redirect) {
    res.writeHead(303, { Location: `/login?next=${encodeURIComponent(req.url || '/game')}` });
    res.end();
  } else {
    sendJson(res, { ok: false, error: 'Authentication required.' }, 401);
  }
  return null;
}

async function requireAdmin(req: IncomingMessage, res: ServerResponse): Promise<ActiveAccount | null> {
  const account = await requireAccount(req, res);
  if (!account) return null;
  if (account.role !== 'ADMIN') {
    sendJson(res, { ok: false, error: 'Administrator access required.' }, 403);
    return null;
  }
  return account;
}

async function requireMutation(req: IncomingMessage, res: ServerResponse): Promise<ActiveAccount | null> {
  const account = await requireAccount(req, res);
  if (!account) return null;
  if (!sameOrigin(req) || !account.csrfToken || req.headers['x-csrf-token'] !== account.csrfToken) {
    sendJson(res, { ok: false, error: 'Invalid security token. Refresh the page and try again.' }, 403);
    return null;
  }
  return account;
}

async function requireAdminMutation(req: IncomingMessage, res: ServerResponse): Promise<ActiveAccount | null> {
  const account = await requireMutation(req, res);
  if (!account) return null;
  if (account.role !== 'ADMIN') {
    sendJson(res, { ok: false, error: 'Administrator access required.' }, 403);
    return null;
  }
  return account;
}

async function requireAdminMutationForMethod(req: IncomingMessage, res: ServerResponse): Promise<ActiveAccount | null> {
  return req.method === 'GET' || req.method === 'HEAD' ? requireAdmin(req, res) : requireAdminMutation(req, res);
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.host === req.headers.host;
  } catch {
    return false;
  }
}

function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; object-src 'self'; connect-src 'self'; worker-src 'self' blob:; img-src 'self' data:; frame-ancestors 'self'; base-uri 'self'; form-action 'self'");
}

const authAttempts = new Map<string, { count: number; resetAt: number }>();
const signupAttempts = new Map<string, { count: number; resetAt: number }>();

function authRateKey(req: IncomingMessage, username: string): string {
  return `${clientIp(req)}:${username.trim().toLocaleLowerCase('en-US')}`;
}

function checkAuthRateLimit(req: IncomingMessage, username: string): void {
  const now = Date.now();
  const key = authRateKey(req, username);
  const current = authAttempts.get(key);
  if (current && current.resetAt > now && current.count >= 10) throw new RateLimitError('Too many attempts. Try again in 15 minutes.');
  if (current && current.resetAt <= now) authAttempts.delete(key);
}

function recordAuthFailure(req: IncomingMessage, username: string): void {
  const key = authRateKey(req, username);
  const current = authAttempts.get(key);
  authAttempts.set(key, !current || current.resetAt <= Date.now() ? { count: 1, resetAt: Date.now() + 15 * 60 * 1000 } : { ...current, count: current.count + 1 });
}

function clearAuthFailures(req: IncomingMessage, username: string): void {
  authAttempts.delete(authRateKey(req, username));
}

function enforceSignupRateLimit(req: IncomingMessage): void {
  const key = clientIp(req);
  const now = Date.now();
  const current = signupAttempts.get(key);
  if (!current || current.resetAt <= now) { signupAttempts.set(key, { count: 1, resetAt: now + 60 * 60 * 1000 }); return; }
  if (current.count >= 5) throw new RateLimitError('Too many accounts created. Try again later.');
  current.count += 1;
}

class RateLimitError extends Error {}
class RequestTooLargeError extends Error {}

function cleanLiveText(value: string, maxLength: number): string {
  const text = String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const flashSafe = Array.from(text).filter((char) => {
    const codePoint = char.codePointAt(0) ?? 0;
    return codePoint === 9 || codePoint === 10 || (codePoint >= 32 && codePoint <= 0xffff);
  });
  return flashSafe.slice(0, maxLength).join('');
}

function encodeArgbPng(argb: Buffer, width: number, height: number): Buffer {
  const pixelCount = width * height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || argb.length < pixelCount * 4) {
    throw new Error('invalid stored image dimensions');
  }

  const raw = Buffer.alloc((width * 4 + 1) * height);
  let source = 0;
  let target = 0;

  for (let y = 0; y < height; y += 1) {
    raw[target] = 0;
    target += 1;
    for (let x = 0; x < width; x += 1) {
      const alpha = argb[source] ?? 0xff;
      const red = argb[source + 1] ?? 0;
      const green = argb[source + 2] ?? 0;
      const blue = argb[source + 3] ?? 0;
      raw[target] = red;
      raw[target + 1] = green;
      raw[target + 2] = blue;
      raw[target + 3] = alpha;
      source += 4;
      target += 4;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', pngHeader(width, height)),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngHeader(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return header;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = Array.from({ length: 256 }, (_value, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return crc >>> 0;
});

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) {
        reject(new RequestTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
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
