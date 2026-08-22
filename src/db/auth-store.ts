import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { prisma } from './client';
import type { ActiveAccount } from '../session';
import { accountFromUsername, cleanPersonName, cleanPin, cleanUsername, hashSessionToken, newCsrfToken, newSessionToken } from '../session';

const scrypt = promisify(nodeScrypt);
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const PIN_KEY_LENGTH = 64;

export interface AuthResult {
  readonly account: ActiveAccount;
  readonly rawToken: string;
}

export async function registerAccount(input: { username?: string; firstName?: string; lastName?: string; pin?: string }, ip: string, userAgent: string): Promise<AuthResult> {
  const username = cleanUsername(input.username || '');
  const firstName = cleanPersonName(input.firstName || '', 'First name');
  const lastName = cleanPersonName(input.lastName || '', 'Last name');
  const pin = cleanPin(input.pin || '');
  const usernameKey = username.toLocaleLowerCase('en-US');
  if (await prisma.account.findUnique({ where: { usernameKey }, select: { id: true } })) throw new Error('That username is already taken.');

  const legacyIdentity = accountFromUsername(username);
  const salt = randomBytes(16).toString('hex');
  const pinHash = await hashPin(pin, salt);
  const configuredAdmin = String(process.env.RC_ADMIN_USERNAME || '').trim().toLocaleLowerCase('en-US');
  const role = configuredAdmin && configuredAdmin === usernameKey ? 'ADMIN' : 'USER';
  const created = await prisma.account.create({
    data: {
      id: randomBytes(16).toString('hex'), username, usernameKey, firstName, lastName, pinHash, pinSalt: salt,
      networkUid: legacyIdentity.networkUid, playfishUid: legacyIdentity.playfishUid, role,
    },
  });
  return createSession(created, ip, userAgent);
}

export async function loginAccount(input: { username?: string; pin?: string }, ip: string, userAgent: string): Promise<AuthResult | null> {
  let username: string;
  try { username = cleanUsername(input.username || ''); } catch { await fakePinCheck(input.pin || ''); return null; }
  const account = await prisma.account.findUnique({ where: { usernameKey: username.toLocaleLowerCase('en-US') } });
  if (!account) { await fakePinCheck(input.pin || ''); return null; }
  let pin: string;
  try { pin = cleanPin(input.pin || ''); } catch { await fakePinCheck(input.pin || ''); return null; }
  if (account.disabled || !(await verifyPin(pin, account.pinSalt, account.pinHash))) return null;
  await prisma.account.update({ where: { id: account.id }, data: { lastLoginAt: new Date() } });
  return createSession(account, ip, userAgent);
}

export async function findSessionAccount(tokenHash: string): Promise<ActiveAccount | null> {
  const session = await prisma.session.findUnique({ where: { tokenHash }, include: { account: true } });
  if (!session || session.account.disabled || session.expiresAt.getTime() <= Date.now()) {
    if (session) await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  if (Date.now() - session.lastSeenAt.getTime() > 5 * 60 * 1000) {
    await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
  }
  return toActiveAccount(session.account, session.csrfToken, session.id);
}

export async function revokeSession(sessionId?: string): Promise<void> {
  if (sessionId) await prisma.session.delete({ where: { id: sessionId } }).catch(() => undefined);
}

export async function updateAccountSettings(accountId: string, sessionId: string, input: { firstName?: string; lastName?: string; currentPin?: string; newPin?: string }): Promise<void> {
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account) throw new Error('Account not found.');
  let currentPin: string;
  try { currentPin = cleanPin(input.currentPin || ''); } catch { throw new Error('Current PIN is incorrect.'); }
  if (!(await verifyPin(currentPin, account.pinSalt, account.pinHash))) throw new Error('Current PIN is incorrect.');
  const firstName = cleanPersonName(input.firstName || '', 'First name');
  const lastName = cleanPersonName(input.lastName || '', 'Last name');
  const data: { firstName: string; lastName: string; pinSalt?: string; pinHash?: string } = { firstName, lastName };
  if (input.newPin) {
    const newPin = cleanPin(input.newPin);
    if (newPin === currentPin) throw new Error('New PIN must be different from the current PIN.');
    data.pinSalt = randomBytes(16).toString('hex');
    data.pinHash = await hashPin(newPin, data.pinSalt);
  }
  await prisma.account.update({ where: { id: accountId }, data });
  if (input.newPin) await prisma.session.deleteMany({ where: { accountId, id: { not: sessionId } } });
}

export async function purgeExpiredSessions(): Promise<void> {
  await prisma.session.deleteMany({ where: { expiresAt: { lte: new Date() } } });
}

async function createSession(account: { id: string; username: string; firstName: string; lastName: string; networkUid: string; playfishUid: number; role: string }, ip: string, userAgent: string): Promise<AuthResult> {
  const rawToken = newSessionToken();
  const csrfToken = newCsrfToken();
  const session = await prisma.session.create({ data: {
    id: randomBytes(16).toString('hex'), tokenHash: hashSessionToken(rawToken), csrfToken, accountId: account.id,
    expiresAt: new Date(Date.now() + SESSION_MS), ipAddress: ip.slice(0, 100), userAgent: userAgent.slice(0, 300),
  } });

  // Hard kick: only the newest session for an account stays valid. A fresh
  // login elsewhere immediately invalidates every older session, so the other
  // device's next request gets 401 and its game instance dies.
  await prisma.session.deleteMany({ where: { accountId: account.id, id: { not: session.id } } }).catch(() => undefined);

  return { account: toActiveAccount(account, csrfToken, session.id), rawToken };
}

function toActiveAccount(account: { id: string; username: string; firstName: string; lastName: string; networkUid: string; playfishUid: number; role: string }, csrfToken: string, sessionId: string): ActiveAccount {
  return { id: account.id, username: account.username, firstName: account.firstName, lastName: account.lastName, networkUid: account.networkUid, playfishUid: account.playfishUid, role: account.role, csrfToken, sessionId };
}

async function hashPin(pin: string, salt: string): Promise<string> {
  const peppered = `${pin}\0${process.env.RC_PIN_PEPPER || ''}`;
  const key = await scrypt(peppered, salt, PIN_KEY_LENGTH) as Buffer;
  return key.toString('hex');
}

async function verifyPin(pin: string, salt: string, expectedHex: string): Promise<boolean> {
  const actual = Buffer.from(await hashPin(pin, salt), 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function fakePinCheck(pin: string): Promise<void> {
  await hashPin(String(pin), '00000000000000000000000000000000');
}
