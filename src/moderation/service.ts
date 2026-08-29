import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db/client';
import type { SaveAuditData } from '../db/profile-store';
import type { ActiveAccount } from '../session';
import { disconnectOnlineUser, listOnlineUsers } from '../live-events';
import { terminateGameInstance } from '../game-instances';
import { recoverFallbackProfileScalars } from '../db/profile-store';
import { evaluateProfile, type RuleFinding } from './rules';
import { captureProfileSnapshot, captureProfileSnapshotTx, listProfileSnapshots, resetProfileToStarter, rollbackProfile } from './snapshots';

const moderationProfileInclude = {
  ownedItems: { select: { globalItemId: true } },
  inventoryItems: { select: { globalItemId: true, number: true, isSelected: true } },
  ingredients: { select: { globalItemId: true, number: true } },
  gardenPlots: { select: { ingredientId: true } },
  employees: { select: { id: true } },
  cashTransactions: { select: { amount: true } },
} satisfies Prisma.UserProfileInclude;

export interface AcceptedSaveEvidence {
  readonly networkUid: string;
  readonly saveVersion: number;
  readonly clientTime: number;
  readonly previousCredits: number;
  readonly credits: number;
  readonly previousGourmet: number;
  readonly gourmetPoint: number;
  readonly previousLevel: number;
  readonly userLevel: number;
  readonly audit: SaveAuditData;
  readonly snapshotId: string;
  readonly acceptedAt: Date;
  /** ADR-0042: the ADR-0031 fence token (one per SWF load) for exact same-session clock comparisons. */
  readonly rpcSessionToken: string;
}

export interface ScanSummary {
  profilesScanned: number;
  findingsCreated: number;
  findingsUpdated: number;
  findingsResolved: number;
}

export async function recordLoginActivity(account: { id: string; networkUid: string }): Promise<void> {
  const now = new Date();
  await prisma.playerActivity.upsert({
    where: { accountId: account.id },
    update: { networkUid: account.networkUid, lastLoginAt: now, lastSeenAt: now, loginCount: { increment: 1 }, requestCount: { increment: 1 } },
    create: { accountId: account.id, networkUid: account.networkUid, firstSeenAt: now, lastSeenAt: now, lastLoginAt: now, loginCount: 1, requestCount: 1 },
  });
}

export async function recordRpcActivity(account: ActiveAccount): Promise<void> {
  if (!account.id) return;
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const existing = await tx.playerActivity.findUnique({ where: { accountId: account.id! } });
    if (!existing) {
      await tx.playerActivity.create({ data: { accountId: account.id!, networkUid: account.networkUid, firstSeenAt: now, lastSeenAt: now, lastLoginAt: now, requestCount: 1, rpcCount: 1 } });
      return;
    }
    const gapSeconds = Math.max(0, Math.floor((now.getTime() - existing.lastSeenAt.getTime()) / 1000));
    await tx.playerActivity.update({ where: { accountId: account.id! }, data: {
      networkUid: account.networkUid, lastSeenAt: now,
      totalActiveSeconds: { increment: Math.min(gapSeconds, 120) },
      requestCount: { increment: 1 }, rpcCount: { increment: 1 },
    } });
  });
}

export async function capturePreSaveSnapshotTx(tx: Prisma.TransactionClient, networkUid: string, saveVersion: number): Promise<string> {
  return captureProfileSnapshotTx(tx, networkUid, 'ACCEPTED_SAVE_BEFORE', `Before accepted save ${saveVersion}`);
}

export async function recordAcceptedSaveTx(tx: Prisma.TransactionClient, evidence: AcceptedSaveEvidence): Promise<void> {
  const previousFact = await tx.profileSaveFact.findFirst({ where: { networkUid: evidence.networkUid }, orderBy: { createdAt: 'desc' } });
  const current = await tx.userProfile.findUniqueOrThrow({ where: { networkUid: evidence.networkUid }, include: {
    ownedItems: { select: { id: true } }, inventoryItems: { select: { number: true, isSelected: true, globalItemId: true } },
    ingredients: { select: { number: true } }, employees: { select: { id: true } }, gardenPlots: { select: { ingredientId: true } },
  } });
  const serverDeltaSeconds = previousFact ? Math.max(0, Math.floor((evidence.acceptedAt.getTime() - previousFact.createdAt.getTime()) / 1000)) : 0;
  // timeOnClient is milliseconds since the session's first save
  // (RpcClient.as: `getTimer() - INIT_TIME`). The previous fact may belong to
  // an earlier RPC session — the ADR-0031 fence issues a fresh rpcSessionToken
  // per SWF load and restarts saveVersion at 1, and the SWF reload restarts the
  // client clock — where the raw delta is meaningless (a reload otherwise looks
  // like the clock "reversed"). ADR-0042 compares clocks only across facts
  // carrying the same non-empty fence token, which is exact.
  const sameSession = previousFact !== null
    && previousFact.rpcSessionToken !== ''
    && previousFact.rpcSessionToken === evidence.rpcSessionToken;
  const clientDeltaSeconds = previousFact && sameSession
    ? Math.round((evidence.clientTime - previousFact.clientTime) / 1000)
    : 0;
  await tx.profileSaveFact.create({ data: {
    networkUid: evidence.networkUid, snapshotId: evidence.snapshotId, saveVersion: evidence.saveVersion,
    rpcSessionToken: evidence.rpcSessionToken,
    clientTime: evidence.clientTime, previousClientTime: previousFact?.clientTime ?? 0, serverDeltaSeconds, clientDeltaSeconds,
    previousCredits: evidence.previousCredits, credits: evidence.credits, creditDelta: evidence.credits - evidence.previousCredits,
    previousGourmet: evidence.previousGourmet, gourmetPoint: evidence.gourmetPoint, gourmetDelta: evidence.gourmetPoint - evidence.previousGourmet,
    previousLevel: evidence.previousLevel, userLevel: evidence.userLevel,
    actionCount: evidence.audit.actionCount ?? 0, unknownActionCount: evidence.audit.unknownActionCount ?? 0,
    actionCountsJson: JSON.stringify(evidence.audit.actionTypeCounts ?? {}),
    placedItems: current.ownedItems.length,
    inventoryUnits: current.inventoryItems.reduce((sum, item) => sum + Math.max(0, item.number), 0),
    ingredientUnits: current.ingredients.reduce((sum, item) => sum + Math.max(0, item.number), 0),
    employeeCount: current.employees.length,
    gardenPlotCount: current.gardenPlots.filter((plot) => plot.ingredientId > 0).length,
    selectedRecipeCount: current.inventoryItems.filter((item) => item.isSelected && item.globalItemId >= 5_000_000 && item.globalItemId < 5_400_000).length,
    createdAt: evidence.acceptedAt,
  } });
  await tx.playerActivity.updateMany({ where: { networkUid: evidence.networkUid }, data: { saveCount: { increment: 1 } } });
}

/** Deletes every anomaly finding so a fresh full scan starts from zero. */
export async function resetAllFindings(): Promise<number> {
  const deleted = await prisma.anomalyFinding.deleteMany();
  return deleted.count;
}

export async function scanPlayer(networkUid: string, now = new Date()): Promise<ScanSummary> {
  const account = await prisma.account.findUnique({ where: { networkUid }, select: { id: true, role: true, username: true, disabled: true, createdAt: true } });
  if (!account || account.role === 'ADMIN') return emptySummary();
  const [profile, activity, latestFact, fallbackRecoveryCount] = await Promise.all([
    prisma.userProfile.findUnique({ where: { networkUid }, include: moderationProfileInclude }),
    prisma.playerActivity.findUnique({ where: { accountId: account.id } }),
    prisma.profileSaveFact.findFirst({ where: { networkUid }, orderBy: { createdAt: 'desc' } }),
    prisma.profileSnapshot.count({ where: { networkUid, reason: 'AUTO_BEFORE_FALLBACK_RECOVERY' } }),
  ]);
  if (!profile) return emptySummary();
  // A shipped network-failure fallback previously overwrote three real
  // profiles. Recover that known server-caused state before moderation judges
  // the dependent level, employee, garden, or menu fields.
  if (await recoverFallbackProfileScalars(networkUid)) {
    return scanPlayer(networkUid, now);
  }
  // Existing accounts predate ADR-0034. Give each one an immediate, immutable
  // rollback point the first time it is assessed instead of waiting for its
  // next save. A normal post-save scan already has ACCEPTED_SAVE_BEFORE.
  const snapshotCount = await prisma.profileSnapshot.count({ where: { networkUid } });
  if (snapshotCount === 0) {
    await captureProfileSnapshot(networkUid, 'INITIAL_BASELINE', 'First state observed by moderation');
  }
  const active = evaluateProfile({ ...profile, createdAt: account.createdAt, knownFallbackRecovery: fallbackRecoveryCount > 0 }, activity, latestFact, now);
  return persistFindings(networkUid, active, now);
}

export async function scanAllProfiles(now = new Date()): Promise<ScanSummary> {  const scan = await prisma.moderationScan.create({ data: { startedAt: now } });
  const accounts = await prisma.account.findMany({ where: { role: { not: 'ADMIN' } }, select: { networkUid: true } });
  const total = emptySummary();
  try {
    for (const account of accounts) addSummary(total, await scanPlayer(account.networkUid, now));
    total.profilesScanned = accounts.length;
    await prisma.moderationScan.update({ where: { id: scan.id }, data: { completedAt: new Date(), ...total } });
    return total;
  } catch (error) {
    await prisma.moderationScan.update({ where: { id: scan.id }, data: { completedAt: new Date(), profilesScanned: total.profilesScanned, findingsCreated: total.findingsCreated, findingsUpdated: total.findingsUpdated, findingsResolved: total.findingsResolved, discordError: String(error).slice(0, 1000) } }).catch(() => undefined);
    throw error;
  }
}

export async function moderationOverview() {
  const [findings, accounts, profiles, activities, latestScan] = await Promise.all([
    prisma.anomalyFinding.findMany({ orderBy: [{ score: 'desc' }, { lastSeenAt: 'desc' }] }),
    prisma.account.findMany({ select: { id: true, networkUid: true, username: true, firstName: true, lastName: true, role: true, disabled: true, createdAt: true, lastLoginAt: true, _count: { select: { sessions: true } } } }),
    prisma.userProfile.findMany({ select: { networkUid: true, restaurantName: true, userLevel: true, gourmetPoint: true, credits: true, cashBalance: true, updatedAt: true } }),
    prisma.playerActivity.findMany(),
    prisma.moderationScan.findFirst({ orderBy: { startedAt: 'desc' } }),
  ]);
  const byAccount = new Map(accounts.map((row) => [row.networkUid, row]));
  const byProfile = new Map(profiles.map((row) => [row.networkUid, row]));
  const byActivity = new Map(activities.map((row) => [row.networkUid, row]));
  const grouped = new Map<string, typeof findings>();
  for (const finding of findings) grouped.set(finding.networkUid, [...(grouped.get(finding.networkUid) ?? []), finding]);
  const players = [...new Set([...accounts.map((row) => row.networkUid), ...findings.map((row) => row.networkUid)])].map((networkUid) => {
    const playerFindings = grouped.get(networkUid) ?? [];
    const open = playerFindings.filter((item) => item.status === 'OPEN' || item.status === 'REVIEWED' || item.status === 'CONFIRMED');
    return { networkUid, account: byAccount.get(networkUid) ?? null, profile: byProfile.get(networkUid) ?? null, activity: byActivity.get(networkUid) ?? null,
      riskScore: open.reduce((sum, item) => sum + item.score, 0), highestSeverity: highestSeverity(open.map((item) => item.severity)), openFindings: open.length, findings: playerFindings };
  }).sort((a, b) => severityRank(b.highestSeverity) - severityRank(a.highestSeverity) || b.riskScore - a.riskScore);
  return { players, latestScan, onlineNetworkUids: listOnlineUsers().map((user) => user.networkUid) };
}

export async function moderationPlayerDetail(networkUid: string) {
  const overview = await moderationOverview();
  const player = overview.players.find((candidate) => candidate.networkUid === networkUid);
  if (!player) throw new Error('Player was not found.');
  const [snapshots, saves, actions] = await Promise.all([
    listProfileSnapshots(networkUid),
    prisma.profileSaveFact.findMany({ where: { networkUid }, orderBy: { createdAt: 'desc' }, take: 250 }),
    prisma.moderationAction.findMany({ where: { targetNetworkUid: networkUid }, orderBy: { createdAt: 'desc' }, take: 250 }),
  ]);
  return { ...player, snapshots, saves, actions, online: overview.onlineNetworkUids.includes(networkUid) };
}

export async function reviewFinding(findingId: string, actor: ActiveAccount, status: string, note: string) {
  const allowed = new Set(['OPEN', 'REVIEWED', 'DISMISSED', 'CONFIRMED']);
  if (!allowed.has(status)) throw new Error('Unsupported finding status.');
  const cleanNote = String(note || '').trim().slice(0, 1000);
  const finding = await prisma.anomalyFinding.update({ where: { id: findingId }, data: { status, reviewNote: cleanNote, reviewedAt: new Date(), reviewedByAccountId: actor.id, resolvedAt: status === 'OPEN' ? null : undefined } });
  await prisma.moderationAction.create({ data: { id: randomUUID(), targetNetworkUid: finding.networkUid, actorAccountId: actor.id, actorUsername: actor.username, actionType: `FINDING_${status}`, reason: cleanNote || `Finding marked ${status}`, detailsJson: JSON.stringify({ findingId, ruleId: finding.ruleId }) } });
  return finding;
}

export async function terminatePlayerSessions(networkUid: string, actor: ActiveAccount, reason: string) {
  assertNotSelf(networkUid, actor);
  const cleanReason = requiredReason(reason);
  const result = await prisma.$transaction(async (tx) => {
    const account = await tx.account.findUniqueOrThrow({ where: { networkUid }, select: { id: true } });
    const revokedSessions = (await tx.session.deleteMany({ where: { accountId: account.id } })).count;
    await tx.moderationAction.create({ data: { id: randomUUID(), targetNetworkUid: networkUid, actorAccountId: actor.id, actorUsername: actor.username, actionType: 'TERMINATE_SESSIONS', reason: cleanReason, detailsJson: JSON.stringify({ revokedSessions }) } });
    return { revokedSessions };
  });
  terminateRuntime(networkUid);
  return result;
}

export async function setPlayerBan(networkUid: string, banned: boolean, actor: ActiveAccount, reason: string) {
  assertNotSelf(networkUid, actor);
  const cleanReason = requiredReason(reason);
  const result = await prisma.$transaction(async (tx) => {
    const account = await tx.account.findUniqueOrThrow({ where: { networkUid }, select: { id: true, disabled: true } });
    await tx.account.update({ where: { id: account.id }, data: { disabled: banned } });
    const revokedSessions = banned ? (await tx.session.deleteMany({ where: { accountId: account.id } })).count : 0;
    await tx.moderationAction.create({ data: { id: randomUUID(), targetNetworkUid: networkUid, actorAccountId: actor.id, actorUsername: actor.username, actionType: banned ? 'BAN' : 'UNBAN', reason: cleanReason, detailsJson: JSON.stringify({ previousDisabled: account.disabled, revokedSessions }) } });
    return { banned, revokedSessions };
  });
  if (banned) terminateRuntime(networkUid);
  return result;
}

export async function createManualSnapshot(networkUid: string, actor: ActiveAccount, label: string) {
  const snapshotId = await captureProfileSnapshot(networkUid, 'ADMIN_MANUAL', String(label || '').trim().slice(0, 200), actor);
  await prisma.moderationAction.create({ data: { id: randomUUID(), targetNetworkUid: networkUid, actorAccountId: actor.id, actorUsername: actor.username, actionType: 'CREATE_SNAPSHOT', reason: String(label || 'Manual snapshot').trim().slice(0, 500), snapshotId } });
  return { snapshotId };
}

export { rollbackProfile, resetProfileToStarter };

async function persistFindings(networkUid: string, active: readonly RuleFinding[], now: Date): Promise<ScanSummary> {
  const summary = emptySummary();
  const activeRules = new Set(active.map((item) => item.ruleId));
  await prisma.$transaction(async (tx) => {
    const existing = await tx.anomalyFinding.findMany({ where: { networkUid } });
    const byRule = new Map(existing.map((item) => [item.ruleId, item]));
    for (const item of active) {
      const old = byRule.get(item.ruleId);
      const evidenceJson = JSON.stringify(item.evidence);
      if (!old) {
        await tx.anomalyFinding.create({ data: { id: randomUUID(), fingerprint: `${networkUid}:${item.ruleId}`, networkUid, ruleId: item.ruleId, severity: item.severity, score: item.score, title: item.title, summary: item.summary, evidenceJson, firstSeenAt: now, lastSeenAt: now } });
        summary.findingsCreated += 1;
      } else {
        const changed = old.evidenceJson !== evidenceJson || old.summary !== item.summary || old.severity !== item.severity || old.score !== item.score;
        const reopen = old.status === 'RESOLVED';
        await tx.anomalyFinding.update({ where: { id: old.id }, data: { severity: item.severity, score: item.score, title: item.title, summary: item.summary, evidenceJson, lastSeenAt: now, occurrenceCount: { increment: 1 }, evidenceVersion: changed ? { increment: 1 } : undefined, status: reopen ? 'OPEN' : undefined, resolvedAt: reopen ? null : undefined } });
        if (changed || reopen) summary.findingsUpdated += 1;
      }
    }
    for (const old of existing) {
      if (!activeRules.has(old.ruleId) && (old.status === 'OPEN' || old.status === 'REVIEWED')) {
        await tx.anomalyFinding.update({ where: { id: old.id }, data: { status: 'RESOLVED', resolvedAt: now, lastSeenAt: now } });
        summary.findingsResolved += 1;
      }
    }
  });
  summary.profilesScanned = 1;
  return summary;
}

function emptySummary(): ScanSummary { return { profilesScanned: 0, findingsCreated: 0, findingsUpdated: 0, findingsResolved: 0 }; }
function addSummary(target: ScanSummary, source: ScanSummary): void { target.profilesScanned += source.profilesScanned; target.findingsCreated += source.findingsCreated; target.findingsUpdated += source.findingsUpdated; target.findingsResolved += source.findingsResolved; }
function highestSeverity(values: readonly string[]): string { for (const value of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']) if (values.includes(value)) return value; return 'NONE'; }
function severityRank(value: string): number { return value === 'CRITICAL' ? 4 : value === 'HIGH' ? 3 : value === 'MEDIUM' ? 2 : value === 'LOW' ? 1 : 0; }
function requiredReason(value: string): string { const reason = String(value || '').trim().replace(/\s+/g, ' '); if (reason.length < 3 || reason.length > 500) throw new Error('A moderation reason of 3–500 characters is required.'); return reason; }
function assertNotSelf(networkUid: string, actor: ActiveAccount): void { if (actor.networkUid === networkUid) throw new Error('An administrator cannot ban or terminate their own active account.'); }
function terminateRuntime(networkUid: string): void { terminateGameInstance(networkUid); disconnectOnlineUser(networkUid); }
