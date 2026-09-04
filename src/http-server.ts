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
  createAdminMails,
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
  getAdminUser,
  listEconomy,
  listAdminUserOptions,
  listAdminUsers,
  listEnabledAccountNetworkUids,
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
import { activeGameInstance, claimGameInstance } from './game-instances';
import { createSessionForAccountId, discordStateForAccount, dismissDiscordLinkPrompt, linkDiscordIdentity, loginAccount, loginAndLinkDiscord, markDiscordLogin, purgeExpiredSessions, registerAccount, registerDiscordAccount, revokeSession, setDiscordNotifications, unlinkDiscordIdentity, updateAccountSettings } from './db/auth-store';
import { clearDiscordCookie, consumeDiscordLoginTicket, createDiscordLoginTicket, discordAuthorization, discordOAuthConfigured, DISCORD_STATE_COOKIE, DISCORD_TICKET_COOKIE, exchangeDiscordCode, peekDiscordLoginTicket, purgeExpiredDiscordTickets, readDiscordLoginTicket, readDiscordOAuthState, safeReturnPath } from './discord-oauth';
import { initializeDiscordNotificationState } from './discord-notifications';
import { prisma } from './db/client';
import { leaderboardPage } from './db/leaderboard';
import { latestStoredImage } from './db/rpc-store';
import { RequestLog } from './request-log';
import { StaticFileIndex } from './static-files';
import type { CapturedRequest } from './types';
import { buildResponse } from './rpc';
import { writeString } from './rpc/codec';
import { accountFromUsername, clientIp, logoutCookie, requestIsSecure, sessionCookie } from './session';
import type { ActiveAccount } from './session';
import { RequestContext, resolveRequestContext } from './request-context';
import { backgroundJobs, type SchedulerHandle } from './job-runner';
import { performanceMetrics } from './performance';
import { enqueueGlobalLiveEvent, enqueueLiveEvent, listOnlineUsers, LIVE_EVENT_ALERT } from './live-events';
import { actOnLink, adminLifecycle, adminLinkDetail, cancelPlayerLink, createAdminLink, createPlayerLink, listAdminLinks, publicLink, socialImageTarget, sweepExpiredEscrow } from './social-links/service';
import { renderSocialLanding } from './social-links/landing';
import { forceDailyIngredientSync } from './daily-ingredients/scheduler';
import { recordRpcActivity } from './moderation/service';
import { createManualSnapshot, moderationOverview, moderationPlayerDetail, rebuildPlayerSave, repairFallbackPlayer, resetAllFindings, resetProfileToStarter, reviewFinding, rollbackProfile, scanAllProfiles, setPlayerBan, terminatePlayerSessions } from './moderation/service';
import { runModerationCycle } from './moderation/scheduler';
import { startImpersonation, stopImpersonation } from './impersonation';
import { clearImpersonationCookie, impersonationCookie } from './session';

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
  readonly backgroundScheduler: SchedulerHandle;
}

export function createServer(config: ServerConfig): RestaurantCityServer {
  const requestLog = new RequestLog(config.maxLogEntries, config.requestLogStdout);
  const staticFiles = new StaticFileIndex(config);

  const httpServer = http.createServer((req, res) => {
    const requestStartedAt = performanceMetrics.requestStarted();
    let requestFinished = false;
    const finishRequest = () => {
      if (requestFinished) return;
      requestFinished = true;
      performanceMetrics.requestFinished(performance.now() - requestStartedAt);
    };
    res.once('finish', finishRequest);
    res.once('close', finishRequest);
    applySecurityHeaders(res);
    resolveRequestContext(requestLog.nextId(), req)
      .then((context) => handleRequest(config, staticFiles, requestLog, context, req, res))
      .catch((error) => {
        console.error(error);
        if (!res.headersSent) {
          res.writeHead(error instanceof RequestTooLargeError ? 413 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
        }
        res.end(error instanceof RequestTooLargeError ? 'request too large' : 'internal server error');
      });
  });

  purgeExpiredSessions().catch((error) => console.error('Session cleanup failed:', error));
  purgeExpiredDiscordTickets().catch((error) => console.error('Discord ticket cleanup failed:', error));
  const sweepSocialEscrow = () => backgroundJobs.run('social-escrow-cleanup', () => sweepExpiredEscrow()).catch((error) => console.error('Social escrow cleanup failed:', error));
  void sweepSocialEscrow();
  const socialSweep = setInterval(() => void sweepSocialEscrow(), 60_000);
  socialSweep.unref();
  return { httpServer, staticFiles, requestLog, backgroundScheduler: { stop: () => clearInterval(socialSweep) } };
}

async function handleRequest(
  config: ServerConfig,
  staticFiles: StaticFileIndex,
  requestLog: RequestLog,
  context: RequestContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  const url = new URL(req.url || '/', `http://localhost:${config.port}`);
  const pathname = decodeURIComponent(url.pathname);

  const entry = createEntry(context.requestId, req, url, pathname, body, config.rpcCaptureMode);

  // Stamp the authenticated player (best-effort) so the dashboard can show who
  // caused each request. Anonymous requests stay unstamped.
  if (context.account) {
    entry.account = { username: context.account.username, networkUid: context.account.networkUid };
  }

  if (pathname === '/') {
    serveHtml(config, res, 'home.html');
    return;
  }

  if (pathname === '/preserve' || pathname === '/preservation') {
    serveHtml(config, res, 'preserve.html');
    return;
  }

  if (pathname === '/login' || pathname === '/signup') {
    serveHtml(config, res, 'auth.html');
    return;
  }

  if (pathname === '/discord/complete' && req.method === 'GET') {
    if (!(await peekDiscordLoginTicket(req))) {
      res.writeHead(303, { Location: '/login?discordError=' + encodeURIComponent('Discord sign-in expired. Please try again.') });
      res.end();
      return;
    }
    serveHtml(config, res, 'discord-complete.html');
    return;
  }

  if (pathname === '/auth/discord' && req.method === 'GET') {
    try {
      const intent = url.searchParams.get('intent') === 'link' ? 'link' : 'login';
      const account = intent === 'link' ? await requireAccount(context, req, res, true) : null;
      if (intent === 'link' && !account?.id) return;
      const authorization = discordAuthorization(req, intent, account?.id);
      res.setHeader('Set-Cookie', authorization.cookie);
      res.writeHead(303, { Location: authorization.url });
      res.end();
    } catch (error) {
      res.writeHead(303, { Location: '/login?discordError=' + encodeURIComponent(error instanceof Error ? error.message : String(error)) });
      res.end();
    }
    return;
  }

  if (pathname === '/auth/discord/callback' && req.method === 'GET') {
    const secure = requestIsSecure(req);
    try {
      if (url.searchParams.get('error')) throw new Error('Discord authorization was cancelled.');
      const state = readDiscordOAuthState(req, url.searchParams.get('state') || '');
      const discord = await exchangeDiscordCode(req, url.searchParams.get('code') || '');
      const linked = await prisma.discordIdentity.findUnique({ where: { discordUserId: discord.id } });
      if (state.intent === 'link') {
        const account = context.account;
        if (!account?.id || account.id !== state.accountId) throw new Error('Your login changed during Discord linking. Please try again.');
        await linkDiscordIdentity(account.id, discord);
        res.setHeader('Set-Cookie', clearDiscordCookie(DISCORD_STATE_COOKIE, secure));
        res.writeHead(303, { Location: appendResult(state.next, 'discord', 'linked') }); res.end(); return;
      }
      if (linked) {
        await markDiscordLogin(discord.id);
        const result = await createSessionForAccountId(linked.accountId, clientIp(req), String(req.headers['user-agent'] || ''));
        res.setHeader('Set-Cookie', [clearDiscordCookie(DISCORD_STATE_COOKIE, secure), sessionCookie(result.rawToken, secure)]);
        res.writeHead(303, { Location: state.next }); res.end(); return;
      }
      const ticketCookie = await createDiscordLoginTicket(discord, secure);
      res.setHeader('Set-Cookie', [clearDiscordCookie(DISCORD_STATE_COOKIE, secure), ticketCookie]);
      res.writeHead(303, { Location: `/discord/complete?next=${encodeURIComponent(state.next)}` }); res.end();
    } catch (error) {
      res.setHeader('Set-Cookie', clearDiscordCookie(DISCORD_STATE_COOKIE, secure));
      res.writeHead(303, { Location: '/login?discordError=' + encodeURIComponent(error instanceof Error ? error.message : String(error)) });
      res.end();
    }
    return;
  }

  const socialPage = pathname.match(/^\/s\/([A-Za-z0-9_-]{32})$/);
  if (socialPage && (req.method === 'GET' || req.method === 'HEAD')) {
    const account = context.account;
    const state = await publicLink(socialPage[1], account);
    if (!state) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(req.method === 'HEAD' ? undefined : 'Social link not found.'); return; }
    const origin = publicOrigin(req);
    const html = renderSocialLanding(state, origin, account?.csrfToken ?? '');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=30' });
    res.end(req.method === 'HEAD' ? undefined : html);
    return;
  }

  const socialImage = pathname.match(/^\/s\/([A-Za-z0-9_-]{32})\/image\.png$/);
  if (socialImage && (req.method === 'GET' || req.method === 'HEAD')) {
    const target = await socialImageTarget(socialImage[1]);
    const stored = target ? await latestStoredImage(target.networkUid, target.imageType) : null;
    if (!stored) { res.writeHead(302, { Location: '/assets/building.png', 'Cache-Control': 'public, max-age=60' }); res.end(); return; }
    const png = encodeArgbPng(stored.data, stored.width, stored.height);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'public, max-age=300', 'X-Robots-Tag': 'noindex' });
    res.end(req.method === 'HEAD' ? undefined : png); return;
  }

  if (pathname === '/terms' || pathname === '/privacy' || pathname === '/cookies' || pathname === '/community-guidelines') {
    serveHtml(config, res, 'legal.html');
    return;
  }

  if (pathname === '/__dash' || pathname === '/dashboard' || pathname === '/database') {
    // All admin surfaces were consolidated into the single /admin dashboard.
    if (!(await requireAdmin(context, req, res))) return;
    res.writeHead(302, { Location: '/admin' });
    res.end();
    return;
  }

  if (pathname === '/game' || pathname === '/play') {
    if (!(await requireGameAccount(context, req, res, true))) return;
    const html = fs.readFileSync(path.join(config.serverRoot, 'public', 'game.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (pathname === '/account') {
    if (!(await requireAccount(context, req, res, true))) return;
    serveHtml(config, res, 'account.html');
    return;
  }

  if (pathname === '/leaderboards' || pathname === '/leaderboard') {
    serveHtml(config, res, 'leaderboards.html');
    return;
  }

  if (pathname === '/admin') {
    if (!(await requireAdmin(context, req, res))) return;
    const html = fs.readFileSync(path.join(config.serverRoot, 'public', 'admin.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // Admin SPA modules (compiled from src/admin by tsconfig.admin.json).
  const adminAsset = pathname.match(/^\/admin\/([A-Za-z0-9_./-]+\.(?:js|css|map))$/);
  if (adminAsset) {
    const filename = adminAsset[1];
    const fullPath = path.join(config.serverRoot, 'public', 'admin', filename);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      const ext = path.extname(filename).toLowerCase();
      const mimeType = ext === '.js' ? 'text/javascript; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : 'application/json; charset=utf-8';
      sendStaticFile(res, fullPath, mimeType, entry, `admin/${filename}`);
      requestLog.record(entry);
      return;
    }
  }

  if (pathname === '/__events') {
    if (!(await requireAdmin(context, req, res))) return;
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
    if (!(await requireAdmin(context, req, res))) return;
    sendJson(res, requestLog.snapshot());
    return;
  }

  if (pathname === '/__api/clear') {
    if (!(await requireAdminMutation(context, req, res))) return;
    requestLog.clear();
    sendJson(res, { ok: true });
    return;
  }

  if (pathname === '/__api/reindex') {
    if (!(await requireAdminMutation(context, req, res))) return;
    staticFiles.reindex();
    sendJson(res, { ok: true, files: staticFiles.size });
    return;
  }

  if (pathname === '/__api/admin/overview' && req.method === 'GET') {
    if (!(await requireAdmin(context, req, res))) return;
    const requests = requestLog.snapshot();
    sendJson(res, {
      ok: true,
      staticFiles: staticFiles.size,
      servesRebuiltGameSwf: staticFiles.servesRebuiltGameSwf(),
      requestBuffer: requests.length,
      maxLogEntries: config.maxLogEntries,
      rpcCount: requests.filter((entry) => entry.kind === 'rpc').length,
      notFoundCount: requests.filter((entry) => entry.status === 404).length,
      onlineUsers: listOnlineUsers(),
      uptimeSeconds: Math.floor(process.uptime()),
      dbSizeBytes: dbFileSize(config),
      serverTime: new Date().toISOString(),
      performance: performanceMetrics.snapshot(),
    });
    return;
  }

  if (pathname === '/__api/admin/assets' && req.method === 'GET') {
    if (!(await requireAdmin(context, req, res))) return;
    const files = staticFiles.entries().map(({ name, path: relativePath }) => {
      let size = 0;
      try {
        size = fs.statSync(path.join(config.rcRoot, relativePath)).size;
      } catch {
        size = 0;
      }
      return { name, path: relativePath, size };
    });
    sendJson(res, { ok: true, files, servesRebuiltGameSwf: staticFiles.servesRebuiltGameSwf() });
    return;
  }

  if (pathname === '/__api/session' && req.method === 'GET') {
    const gameSession = req.headers['x-rc-game-session'] === '1' || url.searchParams.get('game') === '1';
    const impersonation = gameSession ? await context.impersonation() : { present: false, account: null };
    const account = impersonation.present ? impersonation.account : context.account;
    if (gameSession && impersonation.present && !impersonation.account) res.setHeader('Set-Cookie', clearImpersonationCookie(requestIsSecure(req)));
    const discord = account?.id ? await discordStateForAccount(account.id) : { linked: false };
    const promptRow = account?.id && !discord.linked
      ? await prisma.account.findUnique({ where: { id: account.id }, select: { discordLinkPromptedAt: true } })
      : null;
    sendJson(res, {
      ok: true,
      loggedIn: Boolean(account),
      account: publicAccount(account),
      csrfToken: account?.csrfToken || null,
      impersonating: Boolean(impersonation.account),
      impersonator: impersonation.actorUsername || null,
      discord: {
        ...discord,
        configured: discordOAuthConfigured(),
        showLinkPrompt: Boolean(account && !discord.linked && !promptRow?.discordLinkPromptedAt),
      },
    });
    return;
  }

  if (pathname === '/__api/leaderboards' && req.method === 'GET') {
    const account = context.account;
    const result = await leaderboardPage(url.searchParams, account?.networkUid, config.leaderboardCacheMs);
    res.setHeader('Cache-Control', 'private, max-age=15');
    res.setHeader('Vary', 'Cookie');
    res.setHeader('X-Leaderboard-Cache', result.cache);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, ...result }));
    return;
  }

  if (pathname === '/__api/discord/pending' && req.method === 'GET') {
    const pending = await peekDiscordLoginTicket(req);
    if (!pending) { sendJson(res, { ok: false, error: 'Discord sign-in expired.' }, 401); return; }
    sendJson(res, { ok: true, discord: pending });
    return;
  }

  if (pathname === '/__api/discord/complete' && req.method === 'POST') {
    try {
      const input = parseJsonBody<{ mode?: string; username?: string; pin?: string; firstName?: string; lastName?: string; next?: string }>(body);
      const discord = await readDiscordLoginTicket(req);
      let result;
      if (input.mode === 'existing') {
        checkAuthRateLimit(req, String(input.username || ''));
        result = await loginAndLinkDiscord(input, discord, clientIp(req), String(req.headers['user-agent'] || ''));
        if (!result) { recordAuthFailure(req, String(input.username || '')); sendJson(res, { ok: false, error: 'Invalid username or PIN.' }, 401); return; }
        clearAuthFailures(req, String(input.username || ''));
      } else if (input.mode === 'new') {
        enforceSignupRateLimit(req);
        result = await registerDiscordAccount(input, discord, clientIp(req), String(req.headers['user-agent'] || ''));
      } else {
        sendJson(res, { ok: false, error: 'Choose whether you already have a profile.' }, 400); return;
      }
      await ensureLoginAccount(result.account);
      if (result.account.id) await initializeDiscordNotificationState(result.account.id);
      await consumeDiscordLoginTicket(req);
      const secure = requestIsSecure(req);
      res.setHeader('Set-Cookie', [clearDiscordCookie(DISCORD_TICKET_COOKIE, secure), sessionCookie(result.rawToken, secure)]);
      sendJson(res, { ok: true, next: safeReturnPath(input.next) }, input.mode === 'new' ? 201 : 200);
    } catch (error) {
      sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, error instanceof RateLimitError ? 429 : 400);
    }
    return;
  }

  if (pathname === '/__api/account/discord/prompt' && req.method === 'POST') {
    const account = await requireMutation(context, req, res); if (!account?.id) return;
    await dismissDiscordLinkPrompt(account.id); sendJson(res, { ok: true }); return;
  }

  if (pathname === '/__api/account/discord' && req.method === 'PATCH') {
    const account = await requireMutation(context, req, res); if (!account?.id) return;
    try {
      const input = parseJsonBody<{ dmNotificationsEnabled?: boolean }>(body);
      await setDiscordNotifications(account.id, input.dmNotificationsEnabled !== false);
      sendJson(res, { ok: true });
    } catch (error) { sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 400); }
    return;
  }

  if (pathname === '/__api/account/discord' && req.method === 'DELETE') {
    const account = await requireMutation(context, req, res); if (!account?.id) return;
    try { await unlinkDiscordIdentity(account.id); sendJson(res, { ok: true }); }
    catch (error) { sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 400); }
    return;
  }

  if (pathname === '/__api/admin/impersonation' && req.method === 'POST') {
    const actor = await requireAdminMutation(context, req, res);
    if (!actor) return;
    try {
      const input = parseJsonBody<{ networkUid?: string }>(body);
      const result = await startImpersonation(actor, String(input.networkUid || '').trim(), clientIp(req), String(req.headers['user-agent'] || ''));
      res.setHeader('Set-Cookie', impersonationCookie(result.rawToken, requestIsSecure(req)));
      sendJson(res, { ok: true, account: publicAccount(result.account), expiresAt: result.expiresAt, url: '/game?impersonating=1' });
    } catch (error) {
      sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
    }
    return;
  }

  if (pathname === '/__api/game/impersonation' && req.method === 'DELETE') {
    const gameAccount = await requireGameMutation(context, req, res);
    if (!gameAccount) return;
    const actor = context.account;
    if (!actor) { sendJson(res, { ok: false, error: 'Administrator session expired.' }, 401); return; }
    try {
      const targetNetworkUid = await stopImpersonation(req, actor);
      res.setHeader('Set-Cookie', clearImpersonationCookie(requestIsSecure(req)));
      sendJson(res, { ok: true, targetNetworkUid });
    } catch (error) {
      sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 403);
    }
    return;
  }

  const socialState = pathname.match(/^\/__api\/social-links\/([A-Za-z0-9_-]{32})$/);
  if (socialState && req.method === 'GET') {
    const state = await publicLink(socialState[1], await accountForInteractiveRequest(context, req));
    if (!state) { sendJson(res, { ok: false, error: 'Social link not found.' }, 404); return; }
    sendJson(res, { ok: true, link: state });
    return;
  }

  if (pathname === '/__api/social-links' && req.method === 'POST') {
    const account = await requireInteractiveMutation(context, req, res); if (!account) return;
    try {
      enforceSocialRateLimit('create', clientIp(req), 20, 60_000);
      sendJson(res, { ok: true, ...(await createPlayerLink(account, parseJsonBody(body))) }, 201);
    } catch (error) { sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, error instanceof RateLimitError ? 429 : 400); }
    return;
  }

  const socialAction = pathname.match(/^\/__api\/social-links\/([A-Za-z0-9_-]{32})\/actions$/);
  if (socialAction && req.method === 'POST') {
    const account = await requireInteractiveMutation(context, req, res); if (!account) return;
    try {
      enforceSocialRateLimit('action', `${clientIp(req)}:${account.id}`, 60, 60_000);
      const input = parseJsonBody<{ action?: string; idempotencyKey?: string }>(body);
      const key = String(req.headers['idempotency-key'] || input.idempotencyKey || '');
      const result = await actOnLink(socialAction[1], account, String(input.action || ''), key);
      sendJson(res, result, result.ok ? 200 : result.code === 'ALREADY_DONE' ? 409 : 400);
    } catch (error) { sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, error instanceof RateLimitError ? 429 : 400); }
    return;
  }

  const socialCancel = pathname.match(/^\/__api\/social-links\/([A-Za-z0-9_-]{32})\/cancel$/);
  if (socialCancel && req.method === 'POST') {
    const account = await requireInteractiveMutation(context, req, res); if (!account) return;
    try { enforceSocialRateLimit('action', `${clientIp(req)}:${account.id}`, 60, 60_000); await cancelPlayerLink(socialCancel[1], account); sendJson(res, { ok: true }); }
    catch (error) { sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, error instanceof RateLimitError ? 429 : 400); }
    return;
  }

  if (pathname === '/__api/admin/social-links' && req.method === 'GET') {
    if (!(await requireAdmin(context, req, res))) return;
    sendJson(res, { ok: true, links: await listAdminLinks() }); return;
  }
  if (pathname === '/__api/admin/social-links' && req.method === 'POST') {
    const account = await requireAdminMutation(context, req, res); if (!account) return;
    try { enforceSocialRateLimit('admin', account.id || clientIp(req), 100, 60_000); sendJson(res, { ok: true, ...(await createAdminLink(account, parseJsonBody(body))) }, 201); }
    catch (error) { sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, error instanceof RateLimitError ? 429 : 400); } return;
  }
  const adminSocial = pathname.match(/^\/__api\/admin\/social-links\/([A-Za-z0-9-]+)(?:\/(activate|pause|resume|revoke|expire|duplicate|actions))?$/);
  if (adminSocial) {
    if (req.method === 'GET') {
      if (!(await requireAdmin(context, req, res))) return;
      const detail = await adminLinkDetail(adminSocial[1]);
      if (!detail) { sendJson(res, { ok: false, error: 'Social link not found.' }, 404); return; }
      if (adminSocial[2] === 'actions' && url.searchParams.get('format') === 'csv') {
        const rows = (detail as { actions?: Array<{ action: string; outcome: string; resultSummary: string; createdAt: Date }> }).actions ?? [];
        const csv = ['action,outcome,result,createdAt', ...rows.map((row) => [row.action, row.outcome, row.resultSummary, row.createdAt.toISOString()].map(csvCell).join(','))].join('\n');
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="social-link-${adminSocial[1]}-actions.csv"` }); res.end(csv); return;
      }
      sendJson(res, { ok: true, link: detail }); return;
    }
    if (req.method === 'PATCH' || req.method === 'POST') {
      const account = await requireAdminMutation(context, req, res); if (!account) return;
      try { enforceSocialRateLimit('admin', account.id || clientIp(req), 100, 60_000); sendJson(res, { ok: true, link: await adminLifecycle(account, adminSocial[1], adminSocial[2] || 'patch', parseJsonBody(body)) }); }
      catch (error) { sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, error instanceof RateLimitError ? 429 : 400); } return;
    }
  }

  // Game instance claim: the newest instance of a player's game wins; older
  // instances detect the swap via polling and stop themselves (hard kick).
  if (pathname === '/__api/game/claim' && req.method === 'POST') {
    const account = await requireGameMutation(context, req, res);
    if (!account) return;
    const input = parseJsonBody<{ instanceId?: string }>(body);
    const instanceId = String(input.instanceId || '').trim();
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(instanceId)) {
      sendJson(res, { ok: false, error: 'Invalid instance id.' }, 400);
      return;
    }
    const displaced = claimGameInstance(account.networkUid, instanceId);
    sendJson(res, { ok: true, active: instanceId, displaced });
    return;
  }

  if (pathname === '/__api/game/claim' && req.method === 'GET') {
    const account = await context.gameAccount();
    if (!account) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Not logged in.' }));
      return;
    }
    sendJson(res, { ok: true, active: activeGameInstance(account.networkUid) });
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
      if (context.account) {
        sendJson(res, { ok: false, error: 'You are already logged in. Log out first to create another account.' }, 400);
        return;
      }
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
    const account = await requireMutation(context, req, res);
    if (!account) return;
    await revokeSession(account.sessionId);
    res.setHeader('Set-Cookie', logoutCookie(requestIsSecure(req)));
    sendJson(res, { ok: true });
    return;
  }

  if (pathname === '/__api/account' && req.method === 'PATCH') {
    const account = await requireMutation(context, req, res);
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
    if (!(await requireAdminMutationForMethod(context, req, res))) return;
    await handleLiveApi(config, req.method || 'GET', pathname, body, res);
    return;
  }

  if (pathname.startsWith('/__api/moderation')) {
    const actor = await requireAdminMutationForMethod(context, req, res);
    if (!actor) return;
    await handleModerationApi(config, context, req, req.method || 'GET', pathname, body, actor, res);
    return;
  }

  if (pathname.startsWith('/__api/db')) {
    if (!(await requireAdminMutationForMethod(context, req, res))) return;
    await handleDatabaseApi(req.method || 'GET', pathname, url.searchParams, body, res);
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

  // SEO: robots + sitemap live at the site root (see deploy/README.md).
  if (pathname === '/robots.txt') {
    const fullPath = path.join(config.serverRoot, 'public', 'robots.txt');
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      sendStaticFile(res, fullPath, 'text/plain; charset=utf-8', entry, 'public/robots.txt');
      requestLog.record(entry);
      return;
    }
  }

  if (pathname === '/sitemap.xml') {
    const fullPath = path.join(config.serverRoot, 'public', 'sitemap.xml');
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      sendStaticFile(res, fullPath, 'application/xml; charset=utf-8', entry, 'public/sitemap.xml');
      requestLog.record(entry);
      return;
    }
  }

  // Ingredient social previews are packaged in their own directory. Keep this
  // route exact instead of recursively exposing public/assets: item IDs are the
  // only accepted path component and the generated previews are always PNGs.
  const ingredientAssetMatch = pathname.match(/^\/assets\/ingredients\/(\d{7})\.png$/);
  if (ingredientAssetMatch) {
    const filename = `${ingredientAssetMatch[1]}.png`;
    const fullPath = path.join(config.serverRoot, 'public', 'assets', 'ingredients', filename);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      sendStaticFile(res, fullPath, 'image/png', entry, `public/assets/ingredients/${filename}`);
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
    // Pinned Ruffle runtime is vendored under public/ruffle (see ../docs/release.md);
    // the npm package is only a fallback for stale installs.
    const vendoredPath = path.join(config.serverRoot, 'public', 'ruffle', filename);
    const npmPath = path.join(config.serverRoot, 'node_modules', '@ruffle-rs', 'ruffle', filename);
    const fullPath = fs.existsSync(vendoredPath) ? vendoredPath : npmPath;
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      const mimeType = filename.endsWith('.wasm') ? 'application/wasm' : filename.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
      sendStaticFile(res, fullPath, mimeType, entry, `ruffle/${filename}`);
      requestLog.record(entry);
      return;
    }
  }

  if (isRpcPath(pathname)) {
    await handleRpc(context, req, res, body, entry);
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

async function handleModerationApi(config: ServerConfig, context: RequestContext, req: IncomingMessage, method: string, pathname: string, body: Buffer, actor: ActiveAccount, res: ServerResponse): Promise<void> {
  try {
    if (method === 'GET' && pathname === '/__api/moderation') {
      sendJson(res, { ok: true, ...(await moderationOverview()) });
      return;
    }
    if (method === 'POST' && pathname === '/__api/moderation/scan') {
      sendJson(res, { ok: true, result: await runModerationCycle(config.discordAnomalyWebhook, config.moderationSnapshotRetentionDays, config.moderationMaxSnapshotsPerPlayer) });
      return;
    }
    if (method === 'POST' && pathname === '/__api/moderation/reset') {
      // Wipe every finding, then immediately re-scan so only fresh results
      // remain. No Discord digest here: a reset would otherwise re-notify every
      // recreated finding.
      const reset = await resetAllFindings();
      const summary = await scanAllProfiles();
      sendJson(res, { ok: true, result: { ...summary, reset } });
      return;
    }
    const finding = pathname.match(/^\/__api\/moderation\/findings\/([A-Za-z0-9-]+)$/);
    if (finding && method === 'PATCH') {
      const input = parseJsonBody<{ status?: string; note?: string }>(body);
      sendJson(res, { ok: true, finding: await reviewFinding(finding[1], actor, String(input.status || ''), String(input.note || '')) });
      return;
    }
    const player = pathname.match(/^\/__api\/moderation\/players\/([^/]+)(?:\/(snapshots|rollback|reset|ban|unban|terminate|fix-fallback|rebuild-save))?$/);
    if (player) {
      const networkUid = decodeURIComponent(player[1]);
      const operation = player[2] || '';
      if (method === 'GET' && !operation) {
        sendJson(res, { ok: true, player: await moderationPlayerDetail(networkUid) });
        return;
      }
      const input = parseJsonBody<{ reason?: string; snapshotId?: string; label?: string }>(body);
      if (method === 'POST' && operation === 'snapshots') {
        sendJson(res, { ok: true, result: await createManualSnapshot(networkUid, actor, String(input.label || 'Manual moderation snapshot')) }); return;
      }
      if (method === 'POST' && operation === 'rollback') {
        sendJson(res, { ok: true, result: await rollbackProfile(networkUid, String(input.snapshotId || ''), actor, String(input.reason || '')) }); return;
      }
      if (method === 'POST' && operation === 'reset') {
        sendJson(res, { ok: true, result: await resetProfileToStarter(networkUid, actor, String(input.reason || '')) }); return;
      }
      if (method === 'POST' && operation === 'ban') {
        sendJson(res, { ok: true, result: await setPlayerBan(networkUid, true, actor, String(input.reason || '')) }); return;
      }
      if (method === 'POST' && operation === 'unban') {
        sendJson(res, { ok: true, result: await setPlayerBan(networkUid, false, actor, String(input.reason || '')) }); return;
      }
      if (method === 'POST' && operation === 'terminate') {
        sendJson(res, { ok: true, result: await terminatePlayerSessions(networkUid, actor, String(input.reason || '')) }); return;
      }
      if (method === 'POST' && operation === 'fix-fallback') {
        // Keep the active diagnostic session usable after the repair. The old
        // implementation revoked it but left the impersonation cookie/record
        // alive; the next boot then failed RPC init and Flash created Dummy0.
        const impersonation = await context.impersonation();
        const activeTargetSessionId = impersonation.account?.networkUid === networkUid
          ? impersonation.account.sessionId
          : undefined;
        sendJson(res, { ok: true, result: await repairFallbackPlayer(networkUid, actor, activeTargetSessionId) }); return;
      }
      if (method === 'POST' && operation === 'rebuild-save') {
        const impersonation = await context.impersonation();
        const activeTargetSessionId = impersonation.account?.networkUid === networkUid
          ? impersonation.account.sessionId
          : undefined;
        sendJson(res, { ok: true, result: await rebuildPlayerSave(networkUid, actor, activeTargetSessionId) }); return;
      }
    }
    sendJson(res, { ok: false, error: 'not found' }, 404);
  } catch (error) {
    sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
  }
}

async function handleRpc(context: RequestContext, req: IncomingMessage, res: ServerResponse, body: Buffer, entry: CapturedRequest): Promise<void> {
  entry.kind = 'rpc';
  const account = await context.gameAccount();
  if (!account) {
    entry.status = 401;
    res.writeHead(401, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(Buffer.from([0, 0, 0]));
    return;
  }
  entry.account = { username: account.username, networkUid: account.networkUid };
  recordRpcActivity(account);

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
  if (entry.bodyHex !== undefined) entry.respHex = response.toString('hex');
  entry.status = 200;
  performanceMetrics.recordRpc(entry.rpc?.call || 'unknown', performance.now() - context.startedAt);

  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': response.length,
    'Cache-Control': 'no-store',
  });
  res.end(response);
}

async function handleLiveApi(config: ServerConfig, method: string, pathname: string, body: Buffer, res: ServerResponse): Promise<void> {
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

    if (method === 'POST' && pathname === '/__api/live/mail') {
      const input = parseJsonBody<{
        scope?: string;
        recipientNetworkUids?: string[];
        senderNetworkUid?: string;
        globalItemIds?: number[];
        itemId?: number;
        message?: string;
        type?: number;
      }>(body);

      let recipientNetworkUids: string[];
      if (input.scope === 'online') {
        recipientNetworkUids = listOnlineUsers().map((user) => user.networkUid);
      } else if (input.scope === 'everyone') {
        recipientNetworkUids = await listEnabledAccountNetworkUids();
      } else if (input.scope === 'specific') {
        recipientNetworkUids = Array.isArray(input.recipientNetworkUids)
          ? input.recipientNetworkUids.map(String)
          : [];
        if (recipientNetworkUids.length === 0) throw new Error('Choose at least one recipient.');
      } else {
        throw new Error('Choose Online players, Everyone, or Specific people.');
      }

      const result = await createAdminMails({ ...input, recipientNetworkUids });
      sendJson(res, { ok: true, ...result, users: listOnlineUsers() });
      return;
    }

    if (method === 'POST' && pathname === '/__api/live/daily-ingredients/sync') {
      const result = await forceDailyIngredientSync(config.serverRoot, config.discordDailyIngredientsWebhook);
      sendJson(res, { ok: true, ...result });
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

export function createEntry(
  id: number,
  req: IncomingMessage,
  url: URL,
  pathname: string,
  body: Buffer,
  captureMode: ServerConfig['rpcCaptureMode'],
): CapturedRequest {
  const entry: CapturedRequest = {
    id,
    time: new Date().toISOString(),
    method: req.method,
    path: pathname,
    bodyLen: body.length,
    kind: 'http',
    matched: null,
    status: 0,
    durationMs: 0,
  };
  if (captureMode !== 'full') return entry;

  entry.rawUrl = redactedRawUrl(url);
  entry.query = redactedQuery(url);
  entry.headers = redactedHeaders(req.headers);
  if (body.length > 0 && !sensitiveBodyPath(pathname)) {
    const capturedBody = isRpcPath(pathname) ? redactRpcSession(body) : body;
    entry.bodyHex = capturedBody.toString('hex');
    entry.bodyBase64 = capturedBody.toString('base64');
    entry.bodyText = utf8Preview(capturedBody);
  }
  return entry;
}

const SECRET_FIELD = /(?:authorization|cookie|csrf|pin|password|secret|session|token|code|state)/i;

function redactedHeaders(headers: IncomingMessage['headers']): IncomingMessage['headers'] {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, SECRET_FIELD.test(key) ? '[redacted]' : value]));
}

function redactedQuery(url: URL): Record<string, string> {
  return Object.fromEntries([...url.searchParams.entries()].map(([key, value]) => [key, SECRET_FIELD.test(key) ? '[redacted]' : value]));
}

function redactedRawUrl(url: URL): string {
  const query = new URLSearchParams(redactedQuery(url)).toString();
  return `${url.pathname}${query ? `?${query}` : ''}`;
}

function sensitiveBodyPath(pathname: string): boolean {
  return /^\/__api\/(?:login|signup|discord\/complete|account(?:\/|$))/.test(pathname);
}

/** Preserve RPC framing for debugging while removing the top-level session value. */
function redactRpcSession(body: Buffer): Buffer {
  if (body.length < 3) return body;
  let offset = 2;
  let charLength = 0;
  let groups = 0;
  while (offset < body.length && groups < 5) {
    const byte = body[offset++];
    charLength = (charLength << 7) | (byte & 0x7f);
    groups += 1;
    if ((byte & 0x80) === 0) break;
  }
  if (groups === 0 || charLength < 1 || offset + charLength > body.length) return body;
  // Runtime session identifiers are ASCII. Refuse to guess at a multibyte
  // field because changing its encoded byte width would invalidate the frame.
  for (let i = 0; i < charLength; i += 1) if (body[offset + i] >= 0x80) return body;
  const redacted = Buffer.from(body);
  redacted.fill(0x2a, offset, offset + charLength);
  return redacted;
}

function isRpcPath(pathname: string): boolean {
  return /\/g\/rpc\//i.test(pathname) || /\/g\/billing\//i.test(pathname) || /\/g\/fbfeed\//i.test(pathname);
}

async function handleDatabaseApi(method: string, pathname: string, searchParams: URLSearchParams, body: Buffer, res: ServerResponse): Promise<void> {
  try {
    const parts = pathname.split('/').filter(Boolean);

    if (method === 'GET' && pathname === '/__api/db/catalog') {
      sendJson(res, { ok: true, items: itemCatalog() });
      return;
    }

    if (method === 'GET' && pathname === '/__api/db/users') {
      const result = await listAdminUsers(
        Number(searchParams.get('page') || 1),
        Number(searchParams.get('pageSize') || 50),
        searchParams.get('q') || '',
      );
      sendJson(res, { ok: true, ...result });
      return;
    }

    if (method === 'GET' && pathname === '/__api/db/user-options') {
      sendJson(res, { ok: true, users: await listAdminUserOptions() });
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

      if (parts.length === 4 && method === 'GET') {
        sendJson(res, { ok: true, user: await getAdminUser(networkUid) });
        return;
      }

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

function publicOrigin(req: IncomingMessage): string {
  const configured = String(process.env.RC_PUBLIC_ORIGIN || '').replace(/\/$/, '');
  if (configured) return configured;
  return `${requestIsSecure(req) ? 'https' : 'http'}://${req.headers.host || 'localhost:8090'}`;
}

function csvCell(value: unknown): string {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

const socialRateLimits = new Map<string, { count: number; resetAt: number }>();
function enforceSocialRateLimit(bucket: string, identity: string, maximum: number, windowMs: number): void {
  const now = Date.now(); const key = `${bucket}:${identity}`; const prior = socialRateLimits.get(key);
  if (!prior || prior.resetAt <= now) { socialRateLimits.set(key, { count: 1, resetAt: now + windowMs }); return; }
  if (prior.count >= maximum) throw new RateLimitError('Too many social-link requests. Try again shortly.');
  prior.count += 1;
}

function serveHtml(config: ServerConfig, res: ServerResponse, filename: string): void {
  const html = fs.readFileSync(path.join(config.serverRoot, 'public', filename));
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function dbFileSize(config: ServerConfig): number {
  const dbPath = process.env.RC_DB_PATH || path.join(config.serverRoot, 'dev.db');
  try {
    return fs.statSync(dbPath).size;
  } catch {
    return 0;
  }
}

function publicAccount(account: ActiveAccount | null): Omit<ActiveAccount, 'csrfToken' | 'sessionId'> | null {
  if (!account) return null;
  const { csrfToken: _csrfToken, sessionId: _sessionId, ...safe } = account;
  return safe;
}

async function requireAccount(context: RequestContext, req: IncomingMessage, res: ServerResponse, redirect = false): Promise<ActiveAccount | null> {
  const account = context.account;
  if (account) return account;
  if (redirect) {
    res.writeHead(303, { Location: `/login?next=${encodeURIComponent(req.url || '/game')}` });
    res.end();
  } else {
    sendJson(res, { ok: false, error: 'Authentication required.' }, 401);
  }
  return null;
}

function appendResult(pathname: string, key: string, value: string): string {
  const url = new URL(safeReturnPath(pathname), 'https://local.invalid');
  url.searchParams.set(key, value);
  return `${url.pathname}${url.search}${url.hash}`;
}

async function accountForInteractiveRequest(context: RequestContext, req: IncomingMessage): Promise<ActiveAccount | null> {
  return req.headers['x-rc-game-session'] === '1' ? context.gameAccount() : context.account;
}

async function requireGameAccount(context: RequestContext, req: IncomingMessage, res: ServerResponse, redirect = false): Promise<ActiveAccount | null> {
  const impersonation = await context.impersonation();
  const account = impersonation.present ? impersonation.account : context.account;
  if (!account && impersonation.present) res.setHeader('Set-Cookie', clearImpersonationCookie(requestIsSecure(req)));
  if (account) return account;
  if (redirect) {
    res.writeHead(303, { Location: `/login?next=${encodeURIComponent(req.url || '/game')}` });
    res.end();
  } else {
    sendJson(res, { ok: false, error: 'Authentication required.' }, 401);
  }
  return null;
}

async function requireGameMutation(context: RequestContext, req: IncomingMessage, res: ServerResponse): Promise<ActiveAccount | null> {
  const account = await requireGameAccount(context, req, res);
  if (!account) return null;
  if (!sameOrigin(req) || !account.csrfToken || req.headers['x-csrf-token'] !== account.csrfToken) {
    sendJson(res, { ok: false, error: 'Invalid security token. Refresh the page and try again.' }, 403);
    return null;
  }
  return account;
}

async function requireInteractiveMutation(context: RequestContext, req: IncomingMessage, res: ServerResponse): Promise<ActiveAccount | null> {
  return req.headers['x-rc-game-session'] === '1' ? requireGameMutation(context, req, res) : requireMutation(context, req, res);
}

async function requireAdmin(context: RequestContext, req: IncomingMessage, res: ServerResponse): Promise<ActiveAccount | null> {
  const account = await requireAccount(context, req, res);
  if (!account) return null;
  if (account.role !== 'ADMIN') {
    sendJson(res, { ok: false, error: 'Administrator access required.' }, 403);
    return null;
  }
  return account;
}

async function requireMutation(context: RequestContext, req: IncomingMessage, res: ServerResponse): Promise<ActiveAccount | null> {
  const account = await requireAccount(context, req, res);
  if (!account) return null;
  if (!sameOrigin(req) || !account.csrfToken || req.headers['x-csrf-token'] !== account.csrfToken) {
    sendJson(res, { ok: false, error: 'Invalid security token. Refresh the page and try again.' }, 403);
    return null;
  }
  return account;
}

async function requireAdminMutation(context: RequestContext, req: IncomingMessage, res: ServerResponse): Promise<ActiveAccount | null> {
  const account = await requireMutation(context, req, res);
  if (!account) return null;
  if (account.role !== 'ADMIN') {
    sendJson(res, { ok: false, error: 'Administrator access required.' }, 403);
    return null;
  }
  return account;
}

async function requireAdminMutationForMethod(context: RequestContext, req: IncomingMessage, res: ServerResponse): Promise<ActiveAccount | null> {
  return req.method === 'GET' || req.method === 'HEAD' ? requireAdmin(context, req, res) : requireAdminMutation(context, req, res);
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return req.headers['sec-fetch-site'] === 'same-origin';
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
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; object-src 'self'; connect-src 'self' https://static.cloudflareinsights.com; worker-src 'self' blob:; img-src 'self' data:; frame-src 'self' https://discord.com https://*.discord.com; frame-ancestors 'self'; base-uri 'self'; form-action 'self' https://discord.gg https://discord.com https://*.discord.com");
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
