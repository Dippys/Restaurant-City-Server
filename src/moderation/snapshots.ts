import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db/client';
import { DEFAULT_NEW_PLAYER_DEMAND, STARTER_BUILDING_ITEMS, STARTER_INGREDIENTS, STARTER_RECIPES, STARTER_RESTAURANT_ITEMS } from '../db/defaults';
import type { ActiveAccount } from '../session';
import { terminateGameInstance } from '../game-instances';
import { disconnectOnlineUser } from '../live-events';

const snapshotInclude = {
  ownedItems: { orderBy: { serverId: 'asc' as const } },
  inventoryItems: { orderBy: { globalItemId: 'asc' as const } },
  ingredients: { orderBy: { globalItemId: 'asc' as const } },
  gardenPlots: { orderBy: { plotId: 'asc' as const } },
  floors: { orderBy: { floorIndex: 'asc' as const } },
  employees: { orderBy: { networkUid: 'asc' as const } },
} satisfies Prisma.UserProfileInclude;

type SnapshotProfile = Prisma.UserProfileGetPayload<{ include: typeof snapshotInclude }>;

export interface SnapshotPayloadV1 {
  readonly version: 1;
  readonly profile: {
    readonly restaurantName: string;
    readonly credits: number;
    readonly playCount: number;
    readonly userLevel: number;
    readonly gourmetPoint: number;
    readonly nbVote: number;
    readonly totalMark: number;
    readonly trashPoint: number;
    readonly demandPoint: number;
    readonly musicPlay: number;
    readonly cashBalance: number;
    readonly bookmarkCount: number;
    readonly isInStreet: boolean;
    readonly activeFloorIndex: number;
    readonly saveVersion: number;
    readonly lastSave: number;
    readonly lastSurveyTime: number;
    readonly consecutionCount: number;
    readonly awardsBase64: string | null;
  };
  readonly ownedItems: ReadonlyArray<{ serverId: number; globalItemId: number; positionX: number; positionY: number; data: number; roomIndex: number; employeeNetwork: number; employeeNetworkUid: string; employeePlayfishUid: number }>;
  readonly inventoryItems: ReadonlyArray<{ globalItemId: number; number: number; isSelected: boolean }>;
  readonly ingredients: ReadonlyArray<{ globalItemId: number; number: number; isLocked: boolean }>;
  readonly gardenPlots: ReadonlyArray<{ plotId: number; ingredientId: number; plantWetTime: number; timeToDry: number }>;
  readonly floors: ReadonlyArray<{ floorIndex: number; tilesJson: string }>;
  readonly employees: ReadonlyArray<{ network: number; networkUid: string; playfishUid: number; happiness: number; task: number; notify: boolean }>;
}

export interface SnapshotActor {
  readonly id?: string;
  readonly username?: string;
}

export async function captureProfileSnapshot(
  networkUid: string,
  reason: string,
  label = '',
  actor?: SnapshotActor,
): Promise<string> {
  return prisma.$transaction((tx) => captureProfileSnapshotTx(tx, networkUid, reason, label, actor));
}

export async function captureProfileSnapshotTx(
  tx: Prisma.TransactionClient,
  networkUid: string,
  reason: string,
  label = '',
  actor?: SnapshotActor,
): Promise<string> {
  const profile = await tx.userProfile.findUniqueOrThrow({ where: { networkUid }, include: snapshotInclude });
  const payload = payloadFromProfile(profile);
  return persistSnapshotTx(tx, networkUid, reason, label, payload, actor?.id);
}

export async function listProfileSnapshots(networkUid: string) {
  return prisma.profileSnapshot.findMany({
    where: { networkUid },
    select: { id: true, reason: true, label: true, payloadVersion: true, payloadDigest: true, userLevel: true, gourmetPoint: true, credits: true, cashBalance: true, placedItems: true, inventoryUnits: true, ingredientUnits: true, employeeCount: true, createdByAccountId: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 250,
  });
}

export async function rollbackProfile(networkUid: string, snapshotId: string, actor: ActiveAccount, reason: string) {
  const cleanReason = requiredReason(reason);
  const result = await prisma.$transaction(async (tx) => {
    const target = await tx.profileSnapshot.findUnique({ where: { id: snapshotId } });
    if (!target || target.networkUid !== networkUid) throw new Error('Rollback snapshot was not found for this player.');
    const preRollbackSnapshotId = await captureProfileSnapshotTx(tx, networkUid, 'ADMIN_BEFORE_ROLLBACK', `Before rollback to ${snapshotId}`, actor);
    const payload = parseSnapshotPayload(target.payloadJson);
    await restorePayloadTx(tx, networkUid, payload);
    const revokedSessions = await revokeTargetSessionsTx(tx, networkUid);
    await tx.moderationAction.create({ data: {
      id: randomUUID(), targetNetworkUid: networkUid, actorAccountId: actor.id, actorUsername: actor.username,
      actionType: 'ROLLBACK', reason: cleanReason, snapshotId: preRollbackSnapshotId,
      detailsJson: JSON.stringify({ restoredSnapshotId: snapshotId, revokedSessions }),
    } });
    return { restoredSnapshotId: snapshotId, preRollbackSnapshotId, revokedSessions };
  });
  terminateRuntime(networkUid);
  return result;
}

export async function resetProfileToStarter(networkUid: string, actor: ActiveAccount, reason: string) {
  const cleanReason = requiredReason(reason);
  const result = await prisma.$transaction(async (tx) => {
    const current = await tx.userProfile.findUniqueOrThrow({ where: { networkUid }, select: { firstName: true } });
    const preResetSnapshotId = await captureProfileSnapshotTx(tx, networkUid, 'ADMIN_BEFORE_RESET', 'Before reset to starter profile', actor);
    await restorePayloadTx(tx, networkUid, starterPayload(current.firstName));
    const revokedSessions = await revokeTargetSessionsTx(tx, networkUid);
    await tx.moderationAction.create({ data: {
      id: randomUUID(), targetNetworkUid: networkUid, actorAccountId: actor.id, actorUsername: actor.username,
      actionType: 'RESET_TO_STARTER', reason: cleanReason, snapshotId: preResetSnapshotId,
      detailsJson: JSON.stringify({ revokedSessions }),
    } });
    return { preResetSnapshotId, revokedSessions };
  });
  terminateRuntime(networkUid);
  return result;
}

export async function pruneSnapshots(retentionDays = 90, maxPerPlayer = 250): Promise<number> {
  const protectedRows = await prisma.moderationAction.findMany({ where: { snapshotId: { not: null } }, select: { snapshotId: true } });
  const protectedIds = new Set(protectedRows.map((row) => row.snapshotId).filter((id): id is string => Boolean(id)));
  const cutoff = new Date(Date.now() - Math.max(1, retentionDays) * 86_400_000);
  const groups = await prisma.profileSnapshot.groupBy({ by: ['networkUid'] });
  let removed = 0;
  for (const group of groups) {
    const rows = await prisma.profileSnapshot.findMany({ where: { networkUid: group.networkUid }, select: { id: true, createdAt: true }, orderBy: { createdAt: 'desc' } });
    const ids = rows.filter((row, index) => !protectedIds.has(row.id) && (index >= maxPerPlayer || row.createdAt < cutoff)).map((row) => row.id);
    if (ids.length) removed += (await prisma.profileSnapshot.deleteMany({ where: { id: { in: ids } } })).count;
  }
  return removed;
}

export function payloadFromProfile(profile: SnapshotProfile): SnapshotPayloadV1 {
  return {
    version: 1,
    profile: {
      restaurantName: profile.restaurantName, credits: profile.credits, playCount: profile.playCount,
      userLevel: profile.userLevel, gourmetPoint: profile.gourmetPoint, nbVote: profile.nbVote,
      totalMark: profile.totalMark, trashPoint: profile.trashPoint, demandPoint: profile.demandPoint,
      musicPlay: profile.musicPlay, cashBalance: profile.cashBalance, bookmarkCount: profile.bookmarkCount,
      isInStreet: profile.isInStreet, activeFloorIndex: profile.activeFloorIndex, saveVersion: profile.saveVersion,
      lastSave: profile.lastSave, lastSurveyTime: profile.lastSurveyTime, consecutionCount: profile.consecutionCount,
      awardsBase64: profile.awards ? Buffer.from(profile.awards).toString('base64') : null,
    },
    ownedItems: profile.ownedItems.map(({ serverId, globalItemId, positionX, positionY, data, roomIndex, employeeNetwork, employeeNetworkUid, employeePlayfishUid }) => ({ serverId, globalItemId, positionX, positionY, data, roomIndex, employeeNetwork, employeeNetworkUid, employeePlayfishUid })),
    inventoryItems: profile.inventoryItems.map(({ globalItemId, number, isSelected }) => ({ globalItemId, number, isSelected })),
    ingredients: profile.ingredients.map(({ globalItemId, number, isLocked }) => ({ globalItemId, number, isLocked })),
    gardenPlots: profile.gardenPlots.map(({ plotId, ingredientId, plantWetTime, timeToDry }) => ({ plotId, ingredientId, plantWetTime, timeToDry })),
    floors: profile.floors.map(({ floorIndex, tilesJson }) => ({ floorIndex, tilesJson })),
    employees: profile.employees.map(({ network, networkUid, playfishUid, happiness, task, notify }) => ({ network, networkUid, playfishUid, happiness, task, notify })),
  };
}

async function persistSnapshotTx(tx: Prisma.TransactionClient, networkUid: string, reason: string, label: string, payload: SnapshotPayloadV1, actorAccountId?: string): Promise<string> {
  const payloadJson = JSON.stringify(payload);
  const id = randomUUID();
  await tx.profileSnapshot.create({ data: {
    id, networkUid, reason: reason.slice(0, 80), label: label.slice(0, 200), payloadVersion: 1, payloadJson,
    payloadDigest: createHash('sha256').update(payloadJson).digest('hex'),
    userLevel: payload.profile.userLevel, gourmetPoint: payload.profile.gourmetPoint,
    credits: payload.profile.credits, cashBalance: payload.profile.cashBalance,
    placedItems: payload.ownedItems.length,
    inventoryUnits: payload.inventoryItems.reduce((sum, item) => sum + Math.max(0, item.number), 0),
    ingredientUnits: payload.ingredients.reduce((sum, item) => sum + Math.max(0, item.number), 0),
    employeeCount: payload.employees.length, createdByAccountId: actorAccountId,
  } });
  return id;
}

async function restorePayloadTx(tx: Prisma.TransactionClient, networkUid: string, payload: SnapshotPayloadV1): Promise<void> {
  const profile = await tx.userProfile.findUniqueOrThrow({ where: { networkUid }, select: { id: true } });
  const profileId = profile.id;
  const { awardsBase64, ...profileData } = payload.profile;
  await tx.userProfile.update({ where: { id: profileId }, data: {
    ...profileData,
    awards: awardsBase64 ? new Uint8Array(Buffer.from(awardsBase64, 'base64')) : null,
    saveVersion: Math.max(1, payload.profile.saveVersion),
    lastSave: Math.floor(Date.now() / 1000),
  } });
  await tx.ownedItem.deleteMany({ where: { userProfileId: profileId } });
  await tx.inventoryItem.deleteMany({ where: { userProfileId: profileId } });
  await tx.ingredientInventory.deleteMany({ where: { userProfileId: profileId } });
  await tx.gardenPlot.deleteMany({ where: { userProfileId: profileId } });
  await tx.restaurantFloor.deleteMany({ where: { userProfileId: profileId } });
  await tx.employee.deleteMany({ where: { userProfileId: profileId } });
  if (payload.ownedItems.length) await tx.ownedItem.createMany({ data: payload.ownedItems.map((item) => ({ id: `${profileId}:owned:${item.serverId}`, userProfileId: profileId, ...item })) });
  if (payload.inventoryItems.length) await tx.inventoryItem.createMany({ data: payload.inventoryItems.map((item) => ({ id: `${profileId}:inventory:${item.globalItemId}`, userProfileId: profileId, ...item })) });
  if (payload.ingredients.length) await tx.ingredientInventory.createMany({ data: payload.ingredients.map((item) => ({ id: `${profileId}:ingredient:${item.globalItemId}`, userProfileId: profileId, ...item })) });
  if (payload.gardenPlots.length) await tx.gardenPlot.createMany({ data: payload.gardenPlots.map((item) => ({ id: `${profileId}:garden:${item.plotId}`, userProfileId: profileId, ...item })) });
  if (payload.floors.length) await tx.restaurantFloor.createMany({ data: payload.floors.map((item) => ({ id: `${profileId}:floor:${item.floorIndex}`, userProfileId: profileId, ...item })) });
  if (payload.employees.length) await tx.employee.createMany({ data: payload.employees.map((item) => ({ id: `${profileId}:employee:${item.networkUid}`, userProfileId: profileId, ...item })) });
}

function starterPayload(firstName: string): SnapshotPayloadV1 {
  const seeds = [...STARTER_BUILDING_ITEMS, ...STARTER_RESTAURANT_ITEMS];
  return {
    version: 1,
    profile: { restaurantName: `${firstName}'s Restaurant`, credits: 0, playCount: 1, userLevel: 1, gourmetPoint: 0, nbVote: 0, totalMark: 0, trashPoint: 0, demandPoint: DEFAULT_NEW_PLAYER_DEMAND, musicPlay: 0, cashBalance: 250, bookmarkCount: 0, isInStreet: false, activeFloorIndex: 0, saveVersion: 1, lastSave: 0, lastSurveyTime: 0, consecutionCount: 0, awardsBase64: null },
    ownedItems: seeds.map((item, index) => ({ serverId: index + 1, globalItemId: item.id, positionX: item.x, positionY: item.y, data: item.data ?? 0, roomIndex: item.roomIndex ?? 0, employeeNetwork: 0, employeeNetworkUid: '', employeePlayfishUid: 0 })),
    inventoryItems: STARTER_RECIPES.map((item) => ({ globalItemId: item.id, number: item.level, isSelected: item.selected })),
    ingredients: STARTER_INGREDIENTS.map((item) => ({ globalItemId: item.id, number: item.count, isLocked: false })),
    gardenPlots: [], floors: [0, 1].map((floorIndex) => ({ floorIndex, tilesJson: JSON.stringify(Array.from({ length: 800 }, () => 0)) })), employees: [],
  };
}

function parseSnapshotPayload(value: string): SnapshotPayloadV1 {
  const parsed = JSON.parse(value) as SnapshotPayloadV1;
  if (parsed?.version !== 1 || !parsed.profile || !Array.isArray(parsed.ownedItems)) throw new Error('Snapshot payload is unsupported or corrupt.');
  return parsed;
}

async function revokeTargetSessionsTx(tx: Prisma.TransactionClient, networkUid: string): Promise<number> {
  const account = await tx.account.findUnique({ where: { networkUid }, select: { id: true } });
  return account ? (await tx.session.deleteMany({ where: { accountId: account.id } })).count : 0;
}

function terminateRuntime(networkUid: string): void {
  terminateGameInstance(networkUid);
  disconnectOnlineUser(networkUid);
}

function requiredReason(value: string): string {
  const reason = String(value || '').trim().replace(/\s+/g, ' ');
  if (reason.length < 3 || reason.length > 500) throw new Error('A moderation reason of 3–500 characters is required.');
  return reason;
}
