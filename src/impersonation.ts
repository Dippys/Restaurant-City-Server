import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { createImpersonationSession, findSessionAccount, revokeSession } from './db/auth-store';
import { prisma } from './db/client';
import { accountFromRequest, hashSessionToken, IMPERSONATION_COOKIE, IMPERSONATION_MAX_AGE_SECONDS, parseCookies } from './session';
import type { ActiveAccount } from './session';

interface ImpersonationRecord {
  readonly tokenHash: string;
  readonly actorAccountId: string;
  readonly actorSessionId: string;
  readonly actorUsername: string;
  readonly targetNetworkUid: string;
  readonly targetSessionId: string;
  readonly expiresAt: number;
}

export interface ImpersonationState {
  readonly present: boolean;
  readonly account: ActiveAccount | null;
  readonly actorUsername?: string;
  readonly targetNetworkUid?: string;
}

const records = new Map<string, ImpersonationRecord>();

export async function startImpersonation(
  actor: ActiveAccount,
  targetNetworkUid: string,
  ip: string,
  userAgent: string,
): Promise<{ rawToken: string; expiresAt: string; account: ActiveAccount }> {
  if (actor.role !== 'ADMIN' || !actor.id || !actor.sessionId) throw new Error('Administrator access required.');
  if (actor.networkUid === targetNetworkUid) throw new Error('You are already signed in as this account.');
  await revokeActorImpersonations(actor.sessionId, false);

  const result = await createImpersonationSession(targetNetworkUid, ip, userAgent);
  const tokenHash = hashSessionToken(result.rawToken);
  const expiresAt = Date.now() + IMPERSONATION_MAX_AGE_SECONDS * 1000;
  const record: ImpersonationRecord = {
    tokenHash,
    actorAccountId: actor.id,
    actorSessionId: actor.sessionId,
    actorUsername: actor.username,
    targetNetworkUid: result.account.networkUid,
    targetSessionId: result.account.sessionId!,
    expiresAt,
  };

  try {
    await prisma.moderationAction.create({ data: {
      id: randomUUID(),
      targetNetworkUid: record.targetNetworkUid,
      actorAccountId: actor.id,
      actorUsername: actor.username,
      actionType: 'IMPERSONATION_START',
      reason: 'Administrator opened the player game for diagnosis.',
      detailsJson: JSON.stringify({ expiresAt: new Date(expiresAt).toISOString() }),
    } });
    records.set(tokenHash, record);
  } catch (error) {
    await revokeSession(record.targetSessionId);
    throw error;
  }

  return { rawToken: result.rawToken, expiresAt: new Date(expiresAt).toISOString(), account: result.account };
}

/** Resolve the separate game-only identity while keeping the admin login intact. */
export async function impersonationFromRequest(req: IncomingMessage, resolvedActor?: ActiveAccount | null): Promise<ImpersonationState> {
  const rawToken = parseCookies(req.headers.cookie || '')[IMPERSONATION_COOKIE];
  if (!rawToken) return { present: false, account: null };
  const tokenHash = hashSessionToken(rawToken);
  const record = records.get(tokenHash);
  if (!record || record.expiresAt <= Date.now()) {
    if (record) await removeRecord(record, false);
    return { present: true, account: null };
  }

  const actor = resolvedActor === undefined ? await accountFromRequest(req) : resolvedActor;
  if (actor?.role !== 'ADMIN' || actor.id !== record.actorAccountId || actor.sessionId !== record.actorSessionId) {
    return { present: true, account: null };
  }
  const account = await findSessionAccount(tokenHash);
  if (!account || account.networkUid !== record.targetNetworkUid) {
    await removeRecord(record, false);
    return { present: true, account: null };
  }
  return { present: true, account, actorUsername: record.actorUsername, targetNetworkUid: record.targetNetworkUid };
}

export async function stopImpersonation(req: IncomingMessage, actor: ActiveAccount): Promise<string | null> {
  const rawToken = parseCookies(req.headers.cookie || '')[IMPERSONATION_COOKIE];
  if (!rawToken) return null;
  const record = records.get(hashSessionToken(rawToken));
  if (!record) return null;
  if (actor.role !== 'ADMIN' || actor.id !== record.actorAccountId || actor.sessionId !== record.actorSessionId) {
    throw new Error('This impersonation belongs to a different administrator session.');
  }
  await removeRecord(record, true);
  return record.targetNetworkUid;
}

async function revokeActorImpersonations(actorSessionId: string, audited: boolean): Promise<void> {
  const matches = [...records.values()].filter((record) => record.actorSessionId === actorSessionId);
  for (const record of matches) await removeRecord(record, audited);
}

async function removeRecord(record: ImpersonationRecord, audited: boolean): Promise<void> {
  records.delete(record.tokenHash);
  await revokeSession(record.targetSessionId);
  if (audited) {
    await prisma.moderationAction.create({ data: {
      id: randomUUID(),
      targetNetworkUid: record.targetNetworkUid,
      actorAccountId: record.actorAccountId,
      actorUsername: record.actorUsername,
      actionType: 'IMPERSONATION_STOP',
      reason: 'Administrator ended the diagnostic game session.',
    } });
  }
}
