import { randomInt } from 'node:crypto';
import { prisma } from '../db/client';
import { dailyIngredientCatalog, selectDailyIngredients, type DailyIngredient } from './catalog';
import { sendDailyIngredientsDiscord } from './discord';
import { renderDailyIngredientsImage } from './image';
import { backgroundJobs, type SchedulerHandle } from '../job-runner';

const NOON_UTC_HOUR = 12;

export function dueUtcDate(now: Date): string | null {
  if (now.getUTCHours() < NOON_UTC_HOUR) return null;
  return now.toISOString().slice(0, 10);
}

export function rotationUtcDate(now: Date, force: boolean): string | null {
  return force ? now.toISOString().slice(0, 10) : dueUtcDate(now);
}

export function millisecondsUntilNextNoonUtc(now: Date): number {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), NOON_UTC_HOUR));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

function materialize(idsJson: string): DailyIngredient[] {
  const ids = JSON.parse(idsJson) as unknown;
  if (!Array.isArray(ids)) throw new Error('Stored daily ingredient ids are invalid.');
  const byId = new Map(dailyIngredientCatalog().map((ingredient) => [ingredient.id, ingredient]));
  return ids.map((id) => {
    const ingredient = byId.get(Number(id));
    if (!ingredient) throw new Error(`Stored daily ingredient ${String(id)} is no longer in the eligible catalog.`);
    return ingredient;
  });
}

export async function runDailyIngredientRotation(
  serverRoot: string,
  webhookUrl: string | undefined,
  now = new Date(),
  force = false,
): Promise<boolean> {
  const outcome = await backgroundJobs.run('daily-ingredients', () => runDailyIngredientRotationCore(serverRoot, webhookUrl, now, force));
  return outcome.status === 'completed' ? outcome.value : false;
}

async function runDailyIngredientRotationCore(
  serverRoot: string,
  webhookUrl: string | undefined,
  now: Date,
  force: boolean,
): Promise<boolean> {
  const utcDate = rotationUtcDate(now, force);
  if (!utcDate) return false;

  let rotation = await prisma.dailyIngredientRotation.findUnique({ where: { utcDate } });
  if (!rotation) {
    rotation = await prisma.$transaction(async (tx) => {
      const alreadyCreated = await tx.dailyIngredientRotation.findUnique({ where: { utcDate } });
      if (alreadyCreated) return alreadyCreated;
      const previous = await tx.dailyIngredientRotation.findFirst({ orderBy: { utcDate: 'desc' } });
      const previousIds = new Set<number>(previous ? JSON.parse(previous.ingredientIdsJson) as number[] : []);
      const selected = selectDailyIngredients(dailyIngredientCatalog(), previousIds, randomInt);
      // Keep existing rows so ensureEconomyCatalog's one-time defaults cannot
      // reappear; exactly the selected three are enabled on the wire.
      await tx.ingredientMarketItem.updateMany({ data: { enabled: false } });
      for (const ingredient of selected) {
        await tx.ingredientMarketItem.upsert({
          where: { ingredientId: ingredient.id },
          update: { price: ingredient.coinPrice, enabled: true },
          create: { ingredientId: ingredient.id, price: ingredient.coinPrice, enabled: true },
        });
      }
      return tx.dailyIngredientRotation.create({
        data: {
          utcDate,
          ingredientIdsJson: JSON.stringify(selected.map((ingredient) => ingredient.id)),
          pricesJson: JSON.stringify(selected.map((ingredient) => ingredient.coinPrice)),
        },
      });
    });
    console.log(`Daily ingredients rotated for ${utcDate}: ${rotation.ingredientIdsJson}`);
  }

  // Reconcile the market even for an existing daily record. This repairs an
  // incomplete deployment or later manual economy edit without rerolling.
  const ingredients = materialize(rotation.ingredientIdsJson);
  await prisma.$transaction(async (tx) => {
    await tx.ingredientMarketItem.updateMany({ data: { enabled: false } });
    for (const ingredient of ingredients) {
      await tx.ingredientMarketItem.upsert({
        where: { ingredientId: ingredient.id },
        update: { price: ingredient.coinPrice, enabled: true },
        create: { ingredientId: ingredient.id, price: ingredient.coinPrice, enabled: true },
      });
    }
  });

  if (rotation.announcedAt || !webhookUrl) return true;
  try {
    const image = await renderDailyIngredientsImage(ingredients, serverRoot);
    await sendDailyIngredientsDiscord(webhookUrl, ingredients, image);
    await prisma.dailyIngredientRotation.update({
      where: { utcDate },
      data: { announcedAt: new Date(), attemptCount: { increment: 1 }, lastError: '' },
    });
    console.log(`Daily ingredient Discord announcement sent for ${utcDate}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.dailyIngredientRotation.update({
      where: { utcDate },
      data: { attemptCount: { increment: 1 }, lastError: message.slice(0, 1000) },
    });
    throw error;
  }
  return true;
}

export interface DailyIngredientSyncResult {
  readonly utcDate: string;
  readonly created: boolean;
  readonly announced: boolean;
  readonly alreadyComplete: boolean;
  readonly attemptCount: number;
  readonly ingredients: ReadonlyArray<{ id: number; name: string; price: number }>;
}

export async function forceDailyIngredientSync(
  serverRoot: string,
  webhookUrl: string | undefined,
  now = new Date(),
): Promise<DailyIngredientSyncResult> {
  const utcDate = rotationUtcDate(now, true)!;
  const before = await prisma.dailyIngredientRotation.findUnique({ where: { utcDate } });
  await runDailyIngredientRotation(serverRoot, webhookUrl, now, true);
  const after = await prisma.dailyIngredientRotation.findUniqueOrThrow({ where: { utcDate } });
  return {
    utcDate,
    created: !before,
    announced: Boolean(after.announcedAt),
    alreadyComplete: Boolean(before?.announcedAt),
    attemptCount: after.attemptCount,
    ingredients: materialize(after.ingredientIdsJson).map((ingredient) => ({
      id: ingredient.id,
      name: ingredient.name,
      price: ingredient.coinPrice,
    })),
  };
}

export function startDailyIngredientScheduler(serverRoot: string, webhookUrl: string | undefined): SchedulerHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const run = async (): Promise<boolean> => {
    try {
      await runDailyIngredientRotation(serverRoot, webhookUrl);
      return true;
    } catch (error) {
      console.error('Daily ingredient rotation failed:', error);
      return false;
    }
  };
  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(async () => {
      if (stopped) return;
      const succeeded = await run();
      // A pending Discord delivery retries every five minutes; completed or
      // not-yet-due work sleeps until the next exact noon UTC boundary.
      if (!stopped) schedule(succeeded ? millisecondsUntilNextNoonUtc(new Date()) : 5 * 60_000);
    }, delay);
    timer.unref();
  };
  void run().then((succeeded) => {
    if (!stopped) schedule(succeeded ? millisecondsUntilNextNoonUtc(new Date()) : 5 * 60_000);
  });
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}
