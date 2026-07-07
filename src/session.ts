import type { IncomingMessage } from 'node:http';

export interface ActiveAccount {
  readonly username: string;
  readonly networkUid: string;
  readonly playfishUid: number;
}

export const USERNAME_COOKIE = 'rc_username';

const DEFAULT_USERNAME = 'Player';

export function defaultAccount(): ActiveAccount {
  return accountFromUsername(DEFAULT_USERNAME);
}

export function accountFromUsername(value: string): ActiveAccount {
  const username = cleanUsername(value);
  const hash = hashUsername(username);
  const playfishUid = 700000000 + (hash % 1000000000);

  return {
    username,
    networkUid: String(playfishUid),
    playfishUid,
  };
}

export function accountFromRequest(req: IncomingMessage): ActiveAccount | null {
  const raw = parseCookies(req.headers.cookie || '')[USERNAME_COOKIE];
  if (!raw) {
    return null;
  }

  try {
    return accountFromUsername(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

export function loginCookie(username: string): string {
  return `${USERNAME_COOKIE}=${encodeURIComponent(cleanUsername(username))}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

export function logoutCookie(): string {
  return `${USERNAME_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}

export function cleanUsername(value: string): string {
  const username = String(value ?? '').trim().replace(/\s+/g, ' ');

  if (username.length < 2 || username.length > 24) {
    throw new Error('Username must be 2-24 characters.');
  }

  if (!/^[A-Za-z0-9 _.-]+$/.test(username)) {
    throw new Error('Username can only use letters, numbers, spaces, dots, underscores, and hyphens.');
  }

  return username;
}

function hashUsername(username: string): number {
  let hash = 2166136261;
  const normalized = username.toLowerCase();

  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }

  return hash >>> 0;
}

function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};

  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) {
      continue;
    }

    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) {
      cookies[key] = value;
    }
  }

  return cookies;
}
