import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { findSessionAccount } from './db/auth-store';

export interface ActiveAccount {
  readonly id?: string;
  readonly username: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly networkUid: string;
  readonly playfishUid: number;
  readonly role?: string;
  readonly pinEnabled?: boolean;
  readonly csrfToken?: string;
  readonly sessionId?: string;
}

export const SESSION_COOKIE = 'rc_session';
export const IMPERSONATION_COOKIE = 'rc_impersonation';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
export const IMPERSONATION_MAX_AGE_SECONDS = 60 * 30;
const DEFAULT_USERNAME = 'Player';

export function defaultAccount(): ActiveAccount {
  return accountFromUsername(DEFAULT_USERNAME);
}

export function accountFromUsername(value: string): ActiveAccount {
  const username = cleanUsername(value);
  const hash = hashUsername(username);
  const playfishUid = 700000000 + (hash % 1000000000);
  return { username, networkUid: String(playfishUid), playfishUid, pinEnabled: false };
}

export async function accountFromRequest(req: IncomingMessage): Promise<ActiveAccount | null> {
  const rawToken = parseCookies(req.headers.cookie || '')[SESSION_COOKIE];
  if (!rawToken || rawToken.length < 32 || rawToken.length > 256) return null;
  return findSessionAccount(hashSessionToken(rawToken));
}

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function newCsrfToken(): string {
  return randomBytes(24).toString('base64url');
}

export function hashSessionToken(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function logoutCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function impersonationCookie(token: string, secure: boolean): string {
  return `${IMPERSONATION_COOKIE}=${token}; Path=/; Max-Age=${IMPERSONATION_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function clearImpersonationCookie(secure: boolean): string {
  return `${IMPERSONATION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function cleanUsername(value: string): string {
  const username = String(value ?? '').trim();
  if (username.length < 3 || username.length > 24) throw new Error('Username must be 3-24 characters.');
  if (!/^[A-Za-z0-9_.-]+$/.test(username)) throw new Error('Username can only use letters, numbers, dots, underscores, and hyphens.');
  return username;
}

export function cleanPersonName(value: string, label: string): string {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > 50) throw new Error(`${label} must be 1-50 characters.`);
  if (!/^[\p{L}\p{M}' -]+$/u.test(name)) throw new Error(`${label} contains unsupported characters.`);
  return name;
}

export function cleanPin(value: string): string {
  const pin = String(value ?? '');
  if (!/^\d{6,12}$/.test(pin)) throw new Error('PIN must be 6-12 digits.');
  return pin;
}

export function requestIsSecure(req: IncomingMessage): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) return true;
  return process.env.RC_TRUST_PROXY === 'true' && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
}

export function clientIp(req: IncomingMessage): string {
  const forwarded = process.env.RC_TRUST_PROXY === 'true' ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  return (forwarded || req.socket.remoteAddress || '').slice(0, 100);
}

export function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (key) cookies[key] = part.slice(index + 1).trim();
  }
  return cookies;
}

function hashUsername(username: string): number {
  let hash = 2166136261;
  for (let i = 0; i < username.length; i += 1) {
    hash ^= username.toLowerCase().charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}
