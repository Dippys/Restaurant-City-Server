import { prisma } from './client';
import { isFirstVisitIngredientId, isQuizIngredientId, resolveIngredientId } from './ingredient-catalog';

type RewardKind = 'firstVisitReward' | 'quizReward';

interface RewardPlan {
  readonly userProfileId: string;
  readonly kind: RewardKind;
  readonly dayKey: string;
  readonly ingredientId: number;
}

export interface IngredientRewardRepairResult {
  readonly apply: boolean;
  readonly missingFirstVisitRewards: number;
  readonly missingQuizRewards: number;
  readonly invalidQuizEvents: number;
  readonly rewardsGranted: number;
}

export interface IngredientRewardRepairProgress {
  readonly phase: 'loading' | 'planning' | 'applying';
  readonly completed?: number;
  readonly total?: number;
}

function markerKey(userProfileId: string, kind: RewardKind, dayKey: string): string {
  return `${userProfileId}\0${kind}\0${dayKey}`;
}

function parseQuizEvent(value: string): { quizId: number; ingredientId: number } | null {
  try {
    const parsed = JSON.parse(value) as { quizId?: unknown; answer?: unknown; correct?: unknown };
    const quizId = Number(parsed.quizId);
    if (parsed.correct !== true || !Number.isInteger(quizId) || quizId <= 0 || typeof parsed.answer !== 'string') return null;
    const ingredientId = resolveIngredientId(parsed.answer);
    return ingredientId !== null && isQuizIngredientId(ingredientId) ? { quizId, ingredientId } : null;
  } catch {
    return null;
  }
}

export async function repairMissingIngredientRewards(
  apply = false,
  onProgress?: (progress: IngredientRewardRepairProgress) => void,
): Promise<IngredientRewardRepairResult> {
  onProgress?.({ phase: 'loading' });
  const [visits, quizEvents, quizMails, markers] = await Promise.all([
    prisma.friendVisit.findMany({ select: { id: true, userProfileId: true, friendNetworkUid: true, giftIngredientId: true } }),
    prisma.gameEvent.findMany({ where: { eventType: 25 }, select: { id: true, userProfileId: true, eventText: true } }),
    prisma.mail.findMany({ where: { type: 2 }, select: { id: true, recipientProfileId: true } }),
    prisma.systemGrant.findMany({ where: { kind: { in: ['firstVisitReward', 'quizReward'] } }, select: { userProfileId: true, kind: true, dayKey: true } }),
  ]);
  onProgress?.({ phase: 'planning' });
  const existing = new Set(markers.map((row) => markerKey(row.userProfileId, row.kind as RewardKind, row.dayKey)));
  const quizOwner = new Map(quizMails.map((mail) => [mail.id, mail.recipientProfileId]));
  const plans: RewardPlan[] = [];

  for (const visit of visits) {
    if (!Number.isInteger(visit.giftIngredientId) || !isFirstVisitIngredientId(visit.giftIngredientId)) continue;
    const key = markerKey(visit.userProfileId, 'firstVisitReward', visit.friendNetworkUid);
    if (existing.has(key)) continue;
    existing.add(key);
    plans.push({
      userProfileId: visit.userProfileId,
      kind: 'firstVisitReward',
      dayKey: visit.friendNetworkUid,
      ingredientId: visit.giftIngredientId,
    });
  }

  let invalidQuizEvents = 0;
  for (const event of quizEvents) {
    const parsed = parseQuizEvent(event.eventText);
    if (!parsed || quizOwner.get(parsed.quizId) !== event.userProfileId) {
      invalidQuizEvents += 1;
      continue;
    }
    const dayKey = String(parsed.quizId);
    const key = markerKey(event.userProfileId, 'quizReward', dayKey);
    if (existing.has(key)) continue;
    existing.add(key);
    plans.push({ userProfileId: event.userProfileId, kind: 'quizReward', dayKey, ingredientId: parsed.ingredientId });
  }

  const missingFirstVisitRewards = plans.filter((plan) => plan.kind === 'firstVisitReward').length;
  const missingQuizRewards = plans.length - missingFirstVisitRewards;
  let rewardsGranted = 0;
  if (apply) {
    onProgress?.({ phase: 'applying', completed: 0, total: plans.length });
    // Keep each interactive transaction small enough for a remote PostgreSQL
    // connection. Completed batches are independently durable and excluded by
    // their markers if an operator resumes after a later batch fails.
    for (let offset = 0; offset < plans.length; offset += 25) {
      const batch = plans.slice(offset, offset + 25);
      await prisma.$transaction(async (tx) => {
        for (const plan of batch) {
          await tx.systemGrant.create({ data: {
            id: `${plan.userProfileId}:${plan.kind}:${plan.dayKey}`,
            userProfileId: plan.userProfileId,
            kind: plan.kind,
            dayKey: plan.dayKey,
            createdAtUnix: Math.floor(Date.now() / 1000),
          } });
          await tx.ingredientInventory.upsert({
            where: { userProfileId_globalItemId: { userProfileId: plan.userProfileId, globalItemId: plan.ingredientId } },
            update: { number: { increment: 1 }, isLocked: true },
            create: {
              id: `${plan.userProfileId}:ingredient:${plan.ingredientId}`,
              userProfileId: plan.userProfileId,
              globalItemId: plan.ingredientId,
              number: 1,
              isLocked: true,
            },
          });
        }
      }, { maxWait: 10_000, timeout: 30_000 });
      rewardsGranted += batch.length;
      onProgress?.({ phase: 'applying', completed: rewardsGranted, total: plans.length });
    }
  }

  return { apply, missingFirstVisitRewards, missingQuizRewards, invalidQuizEvents, rewardsGranted };
}
