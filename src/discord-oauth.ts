import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { prisma } from './db/client';
import { parseCookies } from './session';

const DISCORD_API = 'https://discord.com/api/v10';
export const DISCORD_STATE_COOKIE = 'rc_discord_oauth';
export const DISCORD_TICKET_COOKIE = 'rc_discord_ticket';
const STATE_MAX_AGE_SECONDS = 10 * 60;
const TICKET_MAX_AGE_SECONDS = 15 * 60;

export interface DiscordUser {
  readonly id: string;
  readonly username: string;
  readonly globalName: string;
  readonly email?: string;
  readonly avatarHash: string;
}

interface OAuthState {
  readonly nonce: string;
  readonly intent: 'login' | 'link';
  readonly accountId?: string;
  readonly next: string;
  readonly expiresAt: number;
}

export function discordOAuthConfigured(): boolean {
  return Boolean(process.env.RC_DISCORD_CLIENT_ID && process.env.RC_DISCORD_CLIENT_SECRET);
}

export function discordAuthorization(req: IncomingMessage, intent: 'login' | 'link', accountId?: string): {
  url: string;
  cookie: string;
} {
  requireOAuthConfig();
  const state: OAuthState = {
    nonce: randomBytes(24).toString('base64url'), intent, accountId,
    next: safeReturnPath(new URL(req.url || '/', requestOrigin(req)).searchParams.get('next')),
    expiresAt: Date.now() + STATE_MAX_AGE_SECONDS * 1000,
  };
  const redirectUri = discordRedirectUri(req);
  const query = new URLSearchParams({
    response_type: 'code', client_id: process.env.RC_DISCORD_CLIENT_ID || '',
    scope: 'identify email guilds.join', state: state.nonce, redirect_uri: redirectUri,
    prompt: 'consent',
  });
  return {
    url: `https://discord.com/oauth2/authorize?${query}`,
    cookie: cookie(DISCORD_STATE_COOKIE, signState(state), STATE_MAX_AGE_SECONDS, requestIsSecureLike(req), '/auth/discord'),
  };
}

export function readDiscordOAuthState(req: IncomingMessage, returnedState: string): OAuthState {
  const encoded = parseCookies(req.headers.cookie || '')[DISCORD_STATE_COOKIE] || '';
  const state = verifyState(encoded);
  if (!state || state.expiresAt <= Date.now() || !safeEqual(state.nonce, returnedState)) {
    throw new Error('Discord sign-in expired or failed its security check. Please try again.');
  }
  return state;
}

export async function exchangeDiscordCode(req: IncomingMessage, code: string): Promise<DiscordUser> {
  requireOAuthConfig();
  if (!code || code.length > 500) throw new Error('Discord did not return a valid authorization code.');
  const body = new URLSearchParams({
    client_id: process.env.RC_DISCORD_CLIENT_ID || '',
    client_secret: process.env.RC_DISCORD_CLIENT_SECRET || '',
    grant_type: 'authorization_code', code, redirect_uri: discordRedirectUri(req),
  });
  const token = await discordRequest<{ access_token?: string; token_type?: string; scope?: string }>(`${DISCORD_API}/oauth2/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!token.access_token) throw new Error('Discord did not issue an access token.');
  const granted = new Set(String(token.scope || '').split(/\s+/));
  if (!granted.has('identify')) throw new Error('Discord identity permission was not granted.');
  const raw = await discordRequest<{ id?: string; username?: string; global_name?: string | null; email?: string | null; avatar?: string | null }>(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!raw.id || !/^\d{10,30}$/.test(raw.id) || !raw.username) throw new Error('Discord returned an invalid user profile.');
  await joinConfiguredGuild(raw.id, token.access_token).catch((error) => console.error('Discord guild join failed:', error));
  return {
    id: raw.id, username: raw.username, globalName: raw.global_name || '',
    email: raw.email || undefined, avatarHash: raw.avatar || '',
  };
}

export async function createDiscordLoginTicket(user: DiscordUser, secure: boolean): Promise<string> {
  const rawToken = randomBytes(32).toString('base64url');
  await prisma.discordLoginTicket.create({ data: {
    tokenHash: hashToken(rawToken), discordUserId: user.id, username: user.username,
    globalName: user.globalName, email: user.email || null, avatarHash: user.avatarHash,
    expiresAt: new Date(Date.now() + TICKET_MAX_AGE_SECONDS * 1000),
  } });
  return cookie(DISCORD_TICKET_COOKIE, rawToken, TICKET_MAX_AGE_SECONDS, secure, '/');
}

export async function readDiscordLoginTicket(req: IncomingMessage): Promise<DiscordUser> {
  const rawToken = parseCookies(req.headers.cookie || '')[DISCORD_TICKET_COOKIE] || '';
  if (rawToken.length < 32 || rawToken.length > 256) throw new Error('Discord sign-in expired. Please start again.');
  const tokenHash = hashToken(rawToken);
  const ticket = await prisma.discordLoginTicket.findUnique({ where: { tokenHash } });
  if (!ticket || ticket.expiresAt.getTime() <= Date.now()) {
    if (ticket) await prisma.discordLoginTicket.delete({ where: { tokenHash } }).catch(() => undefined);
    throw new Error('Discord sign-in expired. Please start again.');
  }
  return {
    id: ticket.discordUserId, username: ticket.username, globalName: ticket.globalName,
    email: ticket.email || undefined, avatarHash: ticket.avatarHash,
  };
}

export async function consumeDiscordLoginTicket(req: IncomingMessage): Promise<void> {
  const rawToken = parseCookies(req.headers.cookie || '')[DISCORD_TICKET_COOKIE] || '';
  if (rawToken) await prisma.discordLoginTicket.deleteMany({ where: { tokenHash: hashToken(rawToken) } });
}

export async function peekDiscordLoginTicket(req: IncomingMessage): Promise<{ username: string; globalName: string } | null> {
  const rawToken = parseCookies(req.headers.cookie || '')[DISCORD_TICKET_COOKIE] || '';
  if (rawToken.length < 32 || rawToken.length > 256) return null;
  const ticket = await prisma.discordLoginTicket.findUnique({ where: { tokenHash: hashToken(rawToken) } });
  return ticket && ticket.expiresAt.getTime() > Date.now() ? { username: ticket.username, globalName: ticket.globalName } : null;
}

export function clearDiscordCookie(name: typeof DISCORD_STATE_COOKIE | typeof DISCORD_TICKET_COOKIE, secure: boolean): string {
  return cookie(name, '', 0, secure, name === DISCORD_STATE_COOKIE ? '/auth/discord' : '/');
}

export async function purgeExpiredDiscordTickets(): Promise<void> {
  await prisma.discordLoginTicket.deleteMany({ where: { expiresAt: { lte: new Date() } } });
}

export function safeReturnPath(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /[\u0000-\u001f]/.test(value)) return '/game';
  try {
    const parsed = new URL(value, 'https://local.invalid');
    return parsed.origin === 'https://local.invalid' ? `${parsed.pathname}${parsed.search}${parsed.hash}` : '/game';
  } catch { return '/game'; }
}

async function joinConfiguredGuild(discordUserId: string, accessToken: string): Promise<void> {
  const guildId = String(process.env.RC_DISCORD_GUILD_ID || '').trim();
  const botToken = String(process.env.RC_DISCORD_BOT_TOKEN || '').trim();
  if (!guildId || !botToken) return;
  if (!/^\d{10,30}$/.test(guildId)) throw new Error('RC_DISCORD_GUILD_ID is invalid.');
  await discordRequest(`${DISCORD_API}/guilds/${guildId}/members/${discordUserId}`, {
    method: 'PUT',
    headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: accessToken }),
  }, [201, 204]);
}

async function discordRequest<T = unknown>(url: string, init: RequestInit, expected = [200]): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!expected.includes(response.status)) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Discord API returned ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function signState(state: OAuthState): string {
  const payload = Buffer.from(JSON.stringify(state)).toString('base64url');
  return `${payload}.${signature(payload)}`;
}

function verifyState(value: string): OAuthState | null {
  const dot = value.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = value.slice(0, dot);
  if (!safeEqual(signature(payload), value.slice(dot + 1))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as OAuthState;
    if (!parsed || !['login', 'link'].includes(parsed.intent) || typeof parsed.nonce !== 'string' || typeof parsed.expiresAt !== 'number') return null;
    return { ...parsed, next: safeReturnPath(parsed.next) };
  } catch { return null; }
}

function signature(payload: string): string {
  return createHmac('sha256', process.env.RC_DISCORD_CLIENT_SECRET || '').update(payload).digest('base64url');
}

function hashToken(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const first = Buffer.from(a); const second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}

function requestOrigin(req: IncomingMessage): string {
  const configured = String(process.env.RC_PUBLIC_ORIGIN || '').replace(/\/$/, '');
  if (configured) return configured;
  return `${requestIsSecureLike(req) ? 'https' : 'http'}://${req.headers.host || 'localhost:8090'}`;
}

function discordRedirectUri(req: IncomingMessage): string {
  return process.env.RC_DISCORD_REDIRECT_URI || `${requestOrigin(req)}/auth/discord/callback`;
}

function requestIsSecureLike(req: IncomingMessage): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) return true;
  return process.env.RC_TRUST_PROXY === 'true' && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
}

function cookie(name: string, value: string, maxAge: number, secure: boolean, path: string): string {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function requireOAuthConfig(): void {
  if (!discordOAuthConfigured()) throw new Error('Discord sign-in is not configured on this server.');
}
