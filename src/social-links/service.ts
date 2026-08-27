import { createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db/client';
import { catalogEntry, catalogLabel, fullCatalog, isCatalogItemId, isEmployeeSnackItem, isFoodKingEligibleItem, itemAttributes } from '../db/item-catalog';
import type { ActiveAccount } from '../session';
import { enqueueLiveMail } from '../live-events';

export const SOCIAL_KINDS = [
  'foodKingReward', 'promotion', 'specialDay', 'employeeSnack', 'directGift',
  'ingredientRequest', 'ingredientTrade', 'friendInvite', 'referral',
  'restaurantVisit', 'gardenHelp', 'restaurantRating', 'playerProfile',
  'screenshot', 'achievement', 'leaderboard', 'announcement',
] as const;
export type SocialKind = typeof SOCIAL_KINDS[number];
export type SocialActionErrorCode = 'LOGIN_REQUIRED' | 'NOT_STARTED' | 'EXPIRED' | 'PAUSED' | 'REVOKED' | 'EXHAUSTED' | 'ALREADY_DONE' | 'SELF_CLAIM' | 'NOT_ELIGIBLE' | 'ALREADY_OWNED' | 'MISSING_ITEM' | 'INSUFFICIENT_INVENTORY' | 'INVALID_ACTION';
export type SocialActionResult =
  | { ok: true; outcome: 'claimed' | 'accepted' | 'fulfilled' | 'joined' | 'viewed'; message: string; playUrl?: string }
  | { ok: false; code: SocialActionErrorCode; message: string };

type Tx = Prisma.TransactionClient;
type Json = Record<string, unknown>;
type LinkWithRelations = Prisma.SocialLinkGetPayload<{ include: { creator: true; actions: true; escrows: true } }>;

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000; // FoodKingPopUp.as: expiry = 2 * 24 * 60 * 60.
const APPROVED_IMAGES = new Set(['/assets/chef.png', '/assets/building.png', '/assets/food-pizza.png', '/assets/food-butter.png']);
const PLAYER_KINDS = new Set<SocialKind>(SOCIAL_KINDS.filter((kind) => !['promotion', 'specialDay', 'announcement'].includes(kind)));
const VIEW_KINDS = new Set<SocialKind>(['restaurantVisit', 'gardenHelp', 'restaurantRating', 'playerProfile', 'screenshot', 'achievement', 'leaderboard', 'announcement']);
const SUCCESS_OUTCOMES = new Set(['claimed', 'accepted', 'fulfilled', 'joined', 'viewed']);

function ingredientImagePath(itemId: number): string | null {
  return catalogEntry(itemId)?.category === 'ingredient' ? `/assets/ingredients/${itemId}.png` : null;
}

function isApprovedPublicImage(imagePath: string): boolean {
  if (APPROVED_IMAGES.has(imagePath)) return true;
  const match = imagePath.match(/^\/assets\/ingredients\/(\d+)\.png$/);
  return Boolean(match && ingredientImagePath(Number(match[1])) === imagePath);
}

function resolvedPublicImage(link: { kind: string; imagePath: string; payloadJson: string; slug: string }): string {
  const kind = asKind(link.kind);
  if (kind === 'screenshot') return `/s/${link.slug}/image.png`;
  const data = payload(link);
  const ingredientId = Number(
    kind === 'ingredientRequest' ? data.ingredientId
      : kind === 'ingredientTrade' ? data.wantItemId
        : kind === 'foodKingReward' || kind === 'directGift' ? data.itemId
          : 0,
  );
  return ingredientImagePath(ingredientId)
    ?? (isApprovedPublicImage(link.imagePath) ? link.imagePath : '/assets/chef.png');
}

export interface PublicSocialLink {
  readonly slug: string;
  readonly kind: SocialKind;
  readonly title: string;
  readonly description: string;
  readonly imagePath: string;
  readonly creatorName?: string;
  readonly availability: 'upcoming' | 'available' | 'paused' | 'expired' | 'exhausted' | 'revoked' | 'completed';
  readonly action: string;
  readonly actionLabel: string;
  readonly loggedIn: boolean;
  readonly completedForViewer: boolean;
  readonly playUrl?: string;
}

function requireAccountId(account: ActiveAccount): string {
  if (!account.id) throw new Error('Authentication required.');
  return account.id;
}

function profileKey(networkUid: string): string { return `facebook:${networkUid}`; }
function opaqueSlug(): string { return randomBytes(24).toString('base64url'); }
function asKind(value: unknown): SocialKind {
  const kind = String(value ?? '') as SocialKind;
  if (!SOCIAL_KINDS.includes(kind)) throw new Error('Unknown social-link kind.');
  return kind;
}
function plainText(value: unknown, max: number, fallback = ''): string {
  const text = String(value ?? fallback).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length > max) throw new Error(`Text must be ${max} characters or fewer.`);
  return text;
}
function positiveInt(value: unknown, fallback = 1): number {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number < 1 || number > 1_000_000_000) throw new Error('Expected a positive integer.');
  return number;
}
function dateOrNull(value: unknown): Date | null {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid date.');
  return date;
}
function payload(link: { payloadJson: string }): Json {
  const parsed = JSON.parse(link.payloadJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid stored social-link payload.');
  return parsed as Json;
}
function disabled(kind: SocialKind): boolean {
  return new Set(String(process.env.RC_SOCIAL_DISABLED_KINDS ?? '').split(',').map((v) => v.trim()).filter(Boolean)).has(kind);
}

export function safeNextPath(value: unknown, fallback = '/game'): string {
  const path = String(value ?? '');
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || /[\u0000-\u001f]/.test(path)) return fallback;
  try {
    const parsed = new URL(path, 'https://rc-reborn.invalid');
    return parsed.origin === 'https://rc-reborn.invalid' ? `${parsed.pathname}${parsed.search}${parsed.hash}` : fallback;
  } catch { return fallback; }
}

export function expectedAction(kind: SocialKind): { action: string; label: string } {
  if (['foodKingReward', 'promotion', 'specialDay', 'employeeSnack', 'directGift'].includes(kind)) return { action: 'claim', label: 'Claim' };
  if (kind === 'ingredientRequest') return { action: 'fulfill', label: 'Send ingredient' };
  if (kind === 'ingredientTrade' || kind === 'friendInvite') return { action: 'accept', label: 'Accept' };
  if (kind === 'referral') return { action: 'join', label: 'Join' };
  return { action: 'view', label: kind === 'announcement' ? 'Continue' : 'View in game' };
}

function defaultPresentation(kind: SocialKind, data: Json): { title: string; description: string; imagePath: string } {
  const itemId = Number(data.itemId ?? data.ingredientId ?? data.wantItemId ?? data.offerItemId ?? 0);
  const item = itemId ? catalogLabel(itemId) : '';
  const itemImage = ingredientImagePath(itemId);
  const presentations: Record<SocialKind, [string, string, string]> = {
    foodKingReward: ['A Food King reward awaits', item ? `Claim ${item}.` : 'Claim an eligible Food King reward.', itemImage ?? '/assets/food-pizza.png'],
    promotion: ['Restaurant City promotion', 'Claim this RC Reborn campaign reward.', '/assets/food-pizza.png'],
    specialDay: ['A special-day present', 'Celebrate with a Restaurant City reward.', '/assets/food-butter.png'],
    employeeSnack: ['A free employee snack', item ? `Claim ${item} for your restaurant.` : 'Claim an eligible employee perk.', '/assets/food-butter.png'],
    directGift: ['A gift from another chef', item ? `Claim ${item}.` : 'Claim an escrowed gift.', itemImage ?? '/assets/food-pizza.png'],
    ingredientRequest: ['A chef needs an ingredient', item ? `Send one ${item}.` : 'Help fulfill this ingredient request.', itemImage ?? '/assets/chef.png'],
    ingredientTrade: ['Ingredient trade', 'Review and accept this escrow-backed trade.', itemImage ?? '/assets/chef.png'],
    friendInvite: ['Restaurant City friend invitation', 'Accept this invitation to become local friends.', '/assets/chef.png'],
    referral: ['Join Restaurant City Reborn', 'Open your restaurant through this referral.', '/assets/chef.png'],
    restaurantVisit: ['Visit this restaurant', 'Open this chef’s restaurant in Restaurant City Reborn.', '/assets/building.png'],
    gardenHelp: ['A garden needs help', 'Visit this restaurant garden; watering remains an in-game action.', '/assets/building.png'],
    restaurantRating: ['Rate this restaurant', 'Visit the restaurant and use the in-game rating controls.', '/assets/building.png'],
    playerProfile: ['Restaurant City chef', 'View this chef’s public restaurant profile.', '/assets/chef.png'],
    screenshot: ['Restaurant screenshot', 'View a screenshot shared from Restaurant City Reborn.', '/assets/building.png'],
    achievement: ['Restaurant City achievement', 'A chef shared an authoritative achievement.', '/assets/food-pizza.png'],
    leaderboard: ['Restaurant City leaderboard', 'View the current leaderboard.', '/assets/chef.png'],
    announcement: ['Restaurant City announcement', 'News from the Restaurant City Reborn team.', '/assets/chef.png'],
  };
  const [title, description, imagePath] = presentations[kind];
  return { title, description, imagePath };
}

function eligibleFoodKingIds(): number[] { return fullCatalog().filter((entry) => isFoodKingEligibleItem(entry.id)).map((entry) => entry.id); }
function categoryForItem(itemId: number): 'ingredient' | 'recipe' | 'inventory' {
  const category = catalogEntry(itemId)?.category;
  if (category === 'ingredient') return 'ingredient';
  if (category === 'recipe') return 'recipe';
  return 'inventory';
}

function decryptLegacyValue(hex: string): string {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 32 !== 0) throw new Error('Invalid Food King legacy value.');
  const decipher = createDecipheriv('aes-128-ecb', Buffer.from('d4ae3749fdd284924b4567bdbc7e3744', 'hex'), null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(Buffer.from(hex, 'hex')), decipher.final()]).toString('utf8');
}

export function decodeFoodKingLegacyUrl(value: string): { itemId: number; creatorUid: string; expiresAt: Date } {
  const url = new URL(value, 'https://legacy.invalid');
  const itemId = Number(decryptLegacyValue(url.searchParams.get('pf_i_id') ?? ''));
  const creatorUid = decryptLegacyValue(url.searchParams.get('pf_uid') ?? '');
  const expirySeconds = Number(decryptLegacyValue(url.searchParams.get('pf_ex') ?? ''));
  if (!Number.isSafeInteger(itemId) || !/^\d+$/.test(creatorUid) || !Number.isSafeInteger(expirySeconds)) throw new Error('Invalid Food King legacy link.');
  return { itemId, creatorUid, expiresAt: new Date(expirySeconds * 1000) };
}

async function createFoodKingPayload(account: ActiveAccount, input: Json, now: Date): Promise<{ data: Json; expiresAt: Date }> {
  let selectedItemId = Number(input.itemId ?? 0);
  let requestedExpiry = new Date(now.getTime() + TWO_DAYS_MS);
  if (input.legacyUrl) {
    const decoded = decodeFoodKingLegacyUrl(String(input.legacyUrl));
    if (decoded.creatorUid !== account.networkUid) throw new Error('Food King creator mismatch.');
    selectedItemId = decoded.itemId;
    requestedExpiry = decoded.expiresAt;
  }
  if (!isFoodKingEligibleItem(selectedItemId)) throw new Error('The selected item is not eligible for Food King sharing.');
  // Preserve the shipped two-day duration and refuse forged/later expiries.
  const expiresAt = new Date(Math.min(requestedExpiry.getTime(), now.getTime() + TWO_DAYS_MS));
  const pools = {
    recipe: eligibleFoodKingIds().filter((id) => catalogEntry(id)?.category === 'recipe'),
    ingredient: eligibleFoodKingIds().filter((id) => catalogEntry(id)?.category === 'ingredient'),
    inventory: eligibleFoodKingIds().filter((id) => !['recipe', 'ingredient'].includes(catalogEntry(id)?.category ?? '')),
  };
  const selectedCategory = categoryForItem(selectedItemId);
  const pick = (ids: number[]) => ids[randomBytes(4).readUInt32BE() % Math.max(1, ids.length)] ?? selectedItemId;
  const offers = [pick(pools.recipe), pick(pools.ingredient), pick(pools.inventory)];
  offers[['recipe', 'ingredient', 'inventory'].indexOf(selectedCategory)] = selectedItemId;
  const encounterId = randomUUID();
  await prisma.foodKingEncounter.create({ data: { id: encounterId, creatorAccountId: requireAccountId(account), offersJson: JSON.stringify(offers), selectedItemId, expiresAt } });
  return { data: { encounterId, itemId: selectedItemId, category: selectedCategory }, expiresAt };
}

async function validatePlayerPayload(account: ActiveAccount, kind: SocialKind, input: Json, now: Date): Promise<{ data: Json; expiresAt?: Date }> {
  if (disabled(kind)) throw new Error(`${kind} links are disabled.`);
  if (!PLAYER_KINDS.has(kind)) throw new Error('Players cannot create this link kind.');
  if (kind === 'foodKingReward') return createFoodKingPayload(account, input, now);
  if (kind === 'employeeSnack') {
    const itemId = positiveInt(input.itemId);
    if (!isEmployeeSnackItem(itemId)) throw new Error('Unknown employee snack.');
    const unlockLevel = Number(itemAttributes(itemId)?.unlockLevel ?? 0);
    const profile = await prisma.userProfile.findUnique({ where: { id: profileKey(account.networkUid) }, select: { userLevel: true } });
    if (!profile || profile.userLevel < unlockLevel) throw new Error('This employee snack is not unlocked.');
    return { data: { itemId, category: 'inventory' } };
  }
  if (kind === 'ingredientRequest') {
    const ingredientId = positiveInt(input.ingredientId ?? input.itemId);
    if (catalogEntry(ingredientId)?.category !== 'ingredient') throw new Error('Unknown ingredient.');
    return { data: { ingredientId, message: plainText(input.message, 180) } };
  }
  if (kind === 'directGift') {
    const itemId = positiveInt(input.itemId);
    if (!isCatalogItemId(itemId)) throw new Error('Unknown item.');
    const category = catalogEntry(itemId)?.category === 'ingredient' ? 'ingredient' : 'inventory';
    return { data: { itemId, category, quantity: positiveInt(input.quantity) }, expiresAt: dateOrNull(input.expiresAt) ?? new Date(now.getTime() + 7 * 86400000) };
  }
  if (kind === 'ingredientTrade') {
    const offerItemId = positiveInt(input.offerItemId);
    const wantItemId = positiveInt(input.wantItemId);
    if (catalogEntry(offerItemId)?.category !== 'ingredient' || catalogEntry(wantItemId)?.category !== 'ingredient') throw new Error('Trades only support shipped ingredients.');
    return { data: { offerItemId, offerQuantity: positiveInt(input.offerQuantity), wantItemId, wantQuantity: positiveInt(input.wantQuantity) }, expiresAt: dateOrNull(input.expiresAt) ?? new Date(now.getTime() + 7 * 86400000) };
  }
  if (kind === 'screenshot') return { data: { imageType: Math.max(0, Math.min(255, Number(input.imageType ?? 0) || 0)) } };
  if (kind === 'achievement') return { data: { source: plainText(input.source, 40, 'achievement') } };
  return { data: {} };
}

async function deduct(tx: Tx, networkUid: string, category: string, itemId: number, quantity: number): Promise<boolean> {
  const where = { userProfileId_globalItemId: { userProfileId: profileKey(networkUid), globalItemId: itemId } };
  if (category === 'ingredient') {
    const row = await tx.ingredientInventory.findUnique({ where });
    if (!row || row.number < quantity) return false;
    await tx.ingredientInventory.update({ where, data: { number: { decrement: quantity } } });
  } else {
    const row = await tx.inventoryItem.findUnique({ where });
    if (!row || row.number < quantity) return false;
    await tx.inventoryItem.update({ where, data: { number: { decrement: quantity } } });
  }
  return true;
}

async function grant(tx: Tx, networkUid: string, category: string, itemId: number, quantity: number): Promise<void> {
  const userProfileId = profileKey(networkUid);
  if (category === 'ingredient') {
    // Received ingredients start locked so they cannot be traded away until the
    // owner unlocks them.
    await tx.ingredientInventory.upsert({
      where: { userProfileId_globalItemId: { userProfileId, globalItemId: itemId } },
      update: { number: { increment: quantity }, isLocked: true },
      create: { id: `${userProfileId}:ingredient:${itemId}`, userProfileId, globalItemId: itemId, number: quantity, isLocked: true },
    });
  } else {
    await tx.inventoryItem.upsert({
      where: { userProfileId_globalItemId: { userProfileId, globalItemId: itemId } },
      update: { number: { increment: quantity } },
      create: { id: `${userProfileId}:inventory:${itemId}`, userProfileId, globalItemId: itemId, number: quantity },
    });
  }
}

async function holdEscrow(tx: Tx, linkId: string, account: ActiveAccount, data: Json): Promise<void> {
  const kindData = data;
  const category = kindData.offerItemId ? 'ingredient' : String(kindData.category);
  const itemId = Number(kindData.offerItemId ?? kindData.itemId);
  const quantity = Number(kindData.offerQuantity ?? kindData.quantity);
  if (!(await deduct(tx, account.networkUid, category, itemId, quantity))) throw new Error('Insufficient inventory for escrow.');
  await tx.socialLinkEscrow.create({ data: { id: randomUUID(), socialLinkId: linkId, ownerAccountId: requireAccountId(account), category, globalItemId: itemId, quantity } });
}

export async function createPlayerLink(account: ActiveAccount, input: Json, now = new Date()): Promise<{ id: string; slug: string; url: string }> {
  const kind = asKind(input.kind ?? input.template);
  const validated = await validatePlayerPayload(account, kind, input, now);
  const presentation = defaultPresentation(kind, validated.data);
  const id = randomUUID();
  const slug = opaqueSlug();
  await prisma.$transaction(async (tx) => {
    await tx.socialLink.create({ data: {
      id, slug, kind, status: 'ACTIVE', creatorAccountId: requireAccountId(account), payloadJson: JSON.stringify(validated.data),
      title: presentation.title, description: presentation.description, imagePath: presentation.imagePath,
      expiresAt: validated.expiresAt, perAccountLimit: 1, totalActionLimit: ['directGift', 'ingredientRequest', 'ingredientTrade'].includes(kind) ? 1 : null,
      activatedAt: now,
    } });
    if (kind === 'directGift' || kind === 'ingredientTrade') await holdEscrow(tx, id, account, validated.data);
  });
  return { id, slug, url: `/s/${slug}` };
}

function availability(link: LinkWithRelations, account: ActiveAccount | null, now: Date): PublicSocialLink['availability'] {
  if (link.status === 'REVOKED') return 'revoked';
  if (link.status === 'PAUSED' || link.status === 'DRAFT') return 'paused';
  if (link.notBefore && link.notBefore > now) return 'upcoming';
  if (link.expiresAt && link.expiresAt <= now) return 'expired';
  if (link.totalActionLimit !== null && link.successfulActionCount >= link.totalActionLimit) return 'exhausted';
  if (account?.id && link.actions.some((item) => item.actorAccountId === account.id && SUCCESS_OUTCOMES.has(item.outcome))) return 'completed';
  return 'available';
}

export async function publicLink(slug: string, account: ActiveAccount | null, now = new Date()): Promise<PublicSocialLink | null> {
  if (!/^[A-Za-z0-9_-]{32}$/.test(slug)) return null;
  const link = await prisma.socialLink.findUnique({ where: { slug }, include: { creator: true, actions: true, escrows: true } });
  if (!link) return null;
  const kind = asKind(link.kind);
  const state = availability(link, account, now);
  const action = expectedAction(kind);
  return {
    slug, kind, title: link.title, description: link.description, imagePath: resolvedPublicImage(link),
    creatorName: link.creator?.firstName, availability: state, action: action.action, actionLabel: action.label,
    loggedIn: Boolean(account), completedForViewer: state === 'completed', playUrl: VIEW_KINDS.has(kind) ? deepLink(kind, link.slug) : '/game',
  };
}

export async function socialImageTarget(slug: string): Promise<{ networkUid: string; imageType: number } | null> {
  const link = await prisma.socialLink.findUnique({ where: { slug }, include: { creator: { select: { networkUid: true } } } });
  if (!link?.creator || link.kind !== 'screenshot' || link.status === 'REVOKED') return null;
  return { networkUid: link.creator.networkUid, imageType: Math.max(0, Math.min(255, Number(payload(link).imageType ?? 0))) };
}

function deepLink(kind: SocialKind, slug: string): string {
  if (['announcement', 'achievement', 'leaderboard'].includes(kind)) return '/game';
  return `/game?socialLink=${encodeURIComponent(slug)}`;
}

function reject(code: SocialActionErrorCode, message: string): SocialActionResult { return { ok: false, code, message }; }

async function recordAction(tx: Tx, linkId: string, accountId: string, action: string, outcome: string, summary: string, key: string): Promise<void> {
  await tx.socialLinkAction.create({ data: { id: randomUUID(), socialLinkId: linkId, actorAccountId: accountId, action, outcome, resultSummary: plainText(summary, 240), idempotencyKey: key } });
}

async function executeKind(tx: Tx, link: LinkWithRelations, actor: ActiveAccount, action: string, now: Date): Promise<SocialActionResult> {
  const kind = asKind(link.kind);
  const data = payload(link);
  const expected = expectedAction(kind).action;
  if (action !== expected) return reject('INVALID_ACTION', 'This action is not permitted for the link.');
  if (VIEW_KINDS.has(kind)) return { ok: true, outcome: 'viewed', message: 'Ready to open Restaurant City.', playUrl: deepLink(kind, link.slug) };
  if (kind === 'foodKingReward') {
    const encounter = await tx.foodKingEncounter.findUnique({ where: { id: String(data.encounterId) } });
    const itemId = Number(data.itemId);
    if (!encounter || encounter.expiresAt <= now || !JSON.parse(encounter.offersJson).includes(itemId) || encounter.selectedItemId !== itemId || !isFoodKingEligibleItem(itemId)) return reject('NOT_ELIGIBLE', 'This Food King offer is not valid.');
    const category = categoryForItem(itemId);
    if (category === 'recipe') {
      const owned = await tx.inventoryItem.findUnique({ where: { userProfileId_globalItemId: { userProfileId: profileKey(actor.networkUid), globalItemId: itemId } } });
      if (owned && owned.number > 0) return reject('ALREADY_OWNED', 'You already own this recipe.');
    }
    await grant(tx, actor.networkUid, category === 'recipe' ? 'inventory' : category, itemId, 1);
    await createRewardMail(tx, link, actor, 10, itemId, 'Food King reward claimed through RC Reborn.');
    return { ok: true, outcome: 'claimed', message: `${catalogLabel(itemId)} was added to your restaurant.`, playUrl: '/game?refresh=social-link' };
  }
  if (kind === 'promotion' || kind === 'specialDay') {
    const reward = data.reward as Json;
    await applyAdminReward(tx, actor, reward);
    const itemId = Number(reward?.itemId ?? 0);
    if (itemId) await createRewardMail(tx, link, actor, kind === 'specialDay' ? 13 : 11, itemId, `${kind} reward claimed through RC Reborn.`);
    return { ok: true, outcome: 'claimed', message: 'Your campaign reward was applied.', playUrl: '/game?refresh=social-link' };
  }
  if (kind === 'employeeSnack') {
    const itemId = Number(data.itemId);
    if (!isEmployeeSnackItem(itemId)) return reject('NOT_ELIGIBLE', 'This employee snack is unavailable.');
    await grant(tx, actor.networkUid, 'inventory', itemId, 1);
    await createRewardMail(tx, link, actor, 9, itemId, 'Employee snack delivered by RC Reborn.');
    return { ok: true, outcome: 'claimed', message: 'The employee snack was delivered.', playUrl: '/game?refresh=social-link' };
  }
  if (kind === 'directGift') {
    const escrow = link.escrows.find((row) => row.state === 'HELD');
    if (!escrow) return reject('EXHAUSTED', 'This gift is no longer available.');
    await grant(tx, actor.networkUid, escrow.category, escrow.globalItemId, escrow.quantity);
    await tx.socialLinkEscrow.update({ where: { id: escrow.id }, data: { state: 'TRANSFERRED', transferredAt: now } });
    await createRewardMail(tx, link, actor, 4, escrow.globalItemId, 'Gift transferred through RC Reborn.');
    return { ok: true, outcome: 'claimed', message: 'The gift was transferred to you.', playUrl: '/game?refresh=social-link' };
  }
  if (kind === 'ingredientRequest') {
    const ingredientId = Number(data.ingredientId);
    if (!(await deduct(tx, actor.networkUid, 'ingredient', ingredientId, 1))) return reject('INSUFFICIENT_INVENTORY', 'You do not own the requested ingredient.');
    if (!link.creator) return reject('NOT_ELIGIBLE', 'The requester is unavailable.');
    await grant(tx, link.creator.networkUid, 'ingredient', ingredientId, 1);
    return { ok: true, outcome: 'fulfilled', message: 'One ingredient was sent to the requester.', playUrl: '/game' };
  }
  if (kind === 'ingredientTrade') {
    const escrow = link.escrows.find((row) => row.state === 'HELD');
    if (!escrow || !link.creator) return reject('EXHAUSTED', 'This trade is no longer available.');
    const wantId = Number(data.wantItemId); const wantQuantity = Number(data.wantQuantity);
    if (!(await deduct(tx, actor.networkUid, 'ingredient', wantId, wantQuantity))) return reject('INSUFFICIENT_INVENTORY', 'You do not own the requested trade ingredients.');
    await grant(tx, link.creator.networkUid, 'ingredient', wantId, wantQuantity);
    await grant(tx, actor.networkUid, 'ingredient', escrow.globalItemId, escrow.quantity);
    await tx.socialLinkEscrow.update({ where: { id: escrow.id }, data: { state: 'TRANSFERRED', transferredAt: now } });
    return { ok: true, outcome: 'accepted', message: 'The ingredient trade completed.', playUrl: '/game?refresh=social-link' };
  }
  if (kind === 'friendInvite') {
    if (!link.creator) return reject('NOT_ELIGIBLE', 'The inviting player is unavailable.');
    const [a, b] = [link.creator.id, requireAccountId(actor)].sort();
    await tx.friendRequest.upsert({ where: { senderAccountId_recipientAccountId: { senderAccountId: link.creator.id, recipientAccountId: requireAccountId(actor) } }, update: { status: 'ACCEPTED' }, create: { id: randomUUID(), senderAccountId: link.creator.id, recipientAccountId: requireAccountId(actor), status: 'ACCEPTED' } });
    await tx.friendship.upsert({ where: { accountAId_accountBId: { accountAId: a, accountBId: b } }, update: {}, create: { id: randomUUID(), accountAId: a, accountBId: b } });
    return { ok: true, outcome: 'accepted', message: 'You are now Restaurant City friends.', playUrl: '/game?refresh=social-link' };
  }
  if (kind === 'referral') return { ok: true, outcome: 'joined', message: 'Referral recorded. Friendship and rewards remain separate actions.', playUrl: '/game' };
  return reject('INVALID_ACTION', 'Unsupported social action.');
}

async function applyAdminReward(tx: Tx, actor: ActiveAccount, reward: Json): Promise<void> {
  const category = String(reward?.category ?? '');
  const amount = positiveInt(reward?.amount ?? 1);
  if (category === 'coins') await tx.userProfile.update({ where: { id: profileKey(actor.networkUid) }, data: { credits: { increment: amount } } });
  else if (category === 'gourmetPoints') await tx.userProfile.update({ where: { id: profileKey(actor.networkUid) }, data: { gourmetPoint: { increment: amount } } });
  else if (category === 'playfishCash') await tx.userProfile.update({ where: { id: profileKey(actor.networkUid) }, data: { cashBalance: { increment: amount } } });
  else {
    const itemId = positiveInt(reward?.itemId);
    if (!isCatalogItemId(itemId)) throw new Error('Unknown reward item.');
    await grant(tx, actor.networkUid, category === 'ingredient' ? 'ingredient' : 'inventory', itemId, amount);
  }
}

async function createRewardMail(tx: Tx, link: LinkWithRelations, actor: ActiveAccount, type: number, itemId: number, message: string): Promise<void> {
  const sender = link.creator ?? await tx.account.findFirst({ where: { role: 'ADMIN', disabled: false } });
  if (!sender) return;
  await tx.mail.create({ data: {
    senderProfileId: profileKey(sender.networkUid), recipientProfileId: profileKey(actor.networkUid), senderNetworkUid: sender.networkUid,
    senderPlayfishUid: sender.playfishUid, recipientNetworkUid: actor.networkUid, recipientPlayfishUid: actor.playfishUid,
    globalItemIdsJson: JSON.stringify([itemId]), itemId, message, sendDate: Math.floor(Date.now() / 1000), type,
  } });
}

export async function actOnLink(slug: string, actor: ActiveAccount, action: string, idempotencyKey: string, now = new Date()): Promise<SocialActionResult> {
  const accountId = requireAccountId(actor);
  const key = plainText(idempotencyKey, 80);
  if (!/^[A-Za-z0-9_.:-]{8,80}$/.test(key)) return reject('INVALID_ACTION', 'A valid idempotency key is required.');
  let liveMailType = 0;
  const result = await prisma.$transaction(async (tx) => {
    const link = await tx.socialLink.findUnique({ where: { slug }, include: { creator: true, actions: true, escrows: true } });
    if (!link) return reject('INVALID_ACTION', 'Social link not found.');
    const prior = link.actions.find((row) => row.actorAccountId === accountId && row.idempotencyKey === key);
    if (prior) return SUCCESS_OUTCOMES.has(prior.outcome)
      ? { ok: true, outcome: prior.outcome as SocialActionResult & never, message: prior.resultSummary, playUrl: '/game?refresh=social-link' } as SocialActionResult
      : reject(prior.outcome as SocialActionErrorCode, prior.resultSummary);
    let result: SocialActionResult;
    const state = availability(link, actor, now);
    if (disabled(asKind(link.kind))) result = reject('PAUSED', 'This kind is temporarily disabled.');
    else if (state === 'upcoming') result = reject('NOT_STARTED', 'This link is not active yet.');
    else if (state === 'expired') result = reject('EXPIRED', 'This link has expired.');
    else if (state === 'paused') result = reject('PAUSED', 'This link is paused.');
    else if (state === 'revoked') result = reject('REVOKED', 'This link was revoked.');
    else if (state === 'exhausted') result = reject('EXHAUSTED', 'This link has reached its limit.');
    else if (state === 'completed') result = reject('ALREADY_DONE', 'You already completed this action.');
    else if (!link.allowSelfAction && link.creatorAccountId === accountId) result = reject('SELF_CLAIM', 'You cannot use your own link.');
    else {
      const successes = link.actions.filter((row) => row.actorAccountId === accountId && SUCCESS_OUTCOMES.has(row.outcome)).length;
      const eligibility = await eligibilityFailure(tx, actor, payload(link), now);
      result = successes >= link.perAccountLimit ? reject('ALREADY_DONE', 'You already completed this action.') : eligibility ?? await executeKind(tx, link, actor, action, now);
      if (result.ok) liveMailType = socialRewardMailType(link);
    }
    const outcome = result.ok ? result.outcome : result.code;
    await recordAction(tx, link.id, accountId, action, outcome, result.message, key);
    if (result.ok) await tx.socialLink.update({ where: { id: link.id }, data: { successfulActionCount: { increment: 1 } } });
    return result;
  });
  if (result.ok && liveMailType > 0) enqueueLiveMail(actor.networkUid, liveMailType);
  return result;
}

function socialRewardMailType(link: LinkWithRelations): number {
  const kind = asKind(link.kind);
  if (kind === 'foodKingReward') return 10;
  if (kind === 'employeeSnack') return 9;
  if (kind === 'directGift') return 4;
  if ((kind === 'promotion' || kind === 'specialDay') && Number((payload(link).reward as Json | undefined)?.itemId ?? 0) > 0) {
    return kind === 'specialDay' ? 13 : 11;
  }
  return 0;
}

async function returnEscrow(tx: Tx, link: LinkWithRelations, now: Date): Promise<void> {
  for (const escrow of link.escrows.filter((row) => row.state === 'HELD')) {
    const owner = await tx.account.findUnique({ where: { id: escrow.ownerAccountId } });
    if (owner) await grant(tx, owner.networkUid, escrow.category, escrow.globalItemId, escrow.quantity);
    await tx.socialLinkEscrow.update({ where: { id: escrow.id }, data: { state: 'RETURNED', returnedAt: now } });
  }
}

export async function cancelPlayerLink(slug: string, account: ActiveAccount, now = new Date()): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const link = await tx.socialLink.findUnique({ where: { slug }, include: { creator: true, actions: true, escrows: true } });
    if (!link || link.creatorAccountId !== requireAccountId(account)) throw new Error('Social link not found.');
    if (link.status === 'REVOKED') throw new Error('This social link is already cancelled.');
    if (link.successfulActionCount > 0) throw new Error('A completed link cannot be cancelled.');
    await returnEscrow(tx, link, now);
    await tx.socialLink.update({ where: { id: link.id }, data: { status: 'REVOKED', revokedAt: now } });
  });
}

function validateAdminReward(input: Json): Json {
  const category = String(input.category ?? '');
  if (!['ingredient', 'inventory', 'recipe', 'coins', 'gourmetPoints', 'playfishCash'].includes(category)) throw new Error('Unsupported reward category.');
  const amount = positiveInt(input.amount);
  const itemId = ['coins', 'gourmetPoints', 'playfishCash'].includes(category) ? undefined : positiveInt(input.itemId);
  if (itemId && !isCatalogItemId(itemId)) throw new Error('Unknown reward item.');
  return { category, amount, ...(itemId ? { itemId } : {}) };
}

function optionalPositiveInt(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 1_000_000_000) throw new Error(`${label} must be a positive integer.`);
  return number;
}

function validateAdminEligibility(input: unknown): Json {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Eligibility must be an object.');
  const source = input as Json;
  const minLevel = optionalPositiveInt(source.minLevel, 'Minimum level');
  const maxLevel = optionalPositiveInt(source.maxLevel, 'Maximum level');
  if (minLevel && maxLevel && minLevel > maxLevel) throw new Error('Minimum level cannot exceed maximum level.');
  const minAccountAgeDays = optionalPositiveInt(source.minAccountAgeDays, 'Minimum account age');
  const requireOwnedItemId = optionalPositiveInt(source.requireOwnedItemId, 'Required owned item');
  const excludeOwnedItemId = optionalPositiveInt(source.excludeOwnedItemId, 'Excluded owned item');
  if (requireOwnedItemId && !isCatalogItemId(requireOwnedItemId)) throw new Error('Unknown required owned item.');
  if (excludeOwnedItemId && !isCatalogItemId(excludeOwnedItemId)) throw new Error('Unknown excluded owned item.');
  if (requireOwnedItemId && requireOwnedItemId === excludeOwnedItemId) throw new Error('An item cannot be both required and excluded.');
  const rawAllowlist = source.allowlistUsernames ?? [];
  if (!Array.isArray(rawAllowlist) || rawAllowlist.length > 1_000) throw new Error('Allowlist must contain at most 1,000 usernames.');
  const allowlistUsernames = [...new Set(rawAllowlist.map((value) => plainText(value, 24).toLowerCase()).filter(Boolean))];
  return {
    ...(minLevel ? { minLevel } : {}), ...(maxLevel ? { maxLevel } : {}), ...(minAccountAgeDays ? { minAccountAgeDays } : {}),
    ...(requireOwnedItemId ? { requireOwnedItemId } : {}), ...(excludeOwnedItemId ? { excludeOwnedItemId } : {}),
    ...(allowlistUsernames.length ? { allowlistUsernames } : {}),
  };
}

async function eligibilityFailure(tx: Tx, actor: ActiveAccount, data: Json, now: Date): Promise<SocialActionResult | null> {
  const eligibility = (data.eligibility ?? {}) as Json;
  if (!eligibility || typeof eligibility !== 'object' || Array.isArray(eligibility)) return reject('NOT_ELIGIBLE', 'This campaign has invalid eligibility rules.');
  const accountId = requireAccountId(actor);
  const [account, profile] = await Promise.all([
    tx.account.findUnique({ where: { id: accountId }, select: { usernameKey: true, createdAt: true, disabled: true } }),
    tx.userProfile.findUnique({ where: { id: profileKey(actor.networkUid) }, select: { userLevel: true } }),
  ]);
  if (!account || account.disabled || !profile) return reject('NOT_ELIGIBLE', 'This account is not eligible for the campaign.');
  const minLevel = Number(eligibility.minLevel ?? 0);
  const maxLevel = Number(eligibility.maxLevel ?? Number.MAX_SAFE_INTEGER);
  if (profile.userLevel < minLevel || profile.userLevel > maxLevel) return reject('NOT_ELIGIBLE', 'Your restaurant level is not eligible for this campaign.');
  const minAgeDays = Number(eligibility.minAccountAgeDays ?? 0);
  if (minAgeDays > 0 && account.createdAt.getTime() > now.getTime() - minAgeDays * 86_400_000) return reject('NOT_ELIGIBLE', 'Your account is not old enough for this campaign.');
  const allowlist = Array.isArray(eligibility.allowlistUsernames) ? eligibility.allowlistUsernames.map(String) : [];
  if (allowlist.length && !allowlist.includes(account.usernameKey)) return reject('NOT_ELIGIBLE', 'This campaign is limited to an allowlist.');
  for (const [field, mustOwn] of [['requireOwnedItemId', true], ['excludeOwnedItemId', false]] as const) {
    const itemId = Number(eligibility[field] ?? 0);
    if (!itemId) continue;
    const category = catalogEntry(itemId)?.category;
    const row = category === 'ingredient'
      ? await tx.ingredientInventory.findUnique({ where: { userProfileId_globalItemId: { userProfileId: profileKey(actor.networkUid), globalItemId: itemId } }, select: { number: true } })
      : await tx.inventoryItem.findUnique({ where: { userProfileId_globalItemId: { userProfileId: profileKey(actor.networkUid), globalItemId: itemId } }, select: { number: true } });
    const owns = Boolean(row && row.number > 0);
    if (owns !== mustOwn) return reject('NOT_ELIGIBLE', mustOwn ? 'You do not own a required campaign item.' : 'You already own an item excluded by this campaign.');
  }
  return null;
}

export async function createAdminLink(account: ActiveAccount, input: Json): Promise<{ id: string; slug: string; url: string }> {
  if (account.role !== 'ADMIN') throw new Error('Administrator access required.');
  const kind = asKind(input.kind);
  if (!['promotion', 'specialDay', 'announcement', 'leaderboard', 'referral'].includes(kind)) throw new Error('This kind is not an administrator campaign.');
  const reward = kind === 'promotion' || kind === 'specialDay' ? validateAdminReward((input.reward ?? {}) as Json) : undefined;
  const eligibility = validateAdminEligibility(input.eligibility);
  const fallback = defaultPresentation(kind, {});
  const imagePath = String(input.imagePath ?? fallback.imagePath);
  if (!APPROVED_IMAGES.has(imagePath)) throw new Error('Image is not approved.');
  const id = randomUUID(); const slug = opaqueSlug();
  await prisma.socialLink.create({ data: {
    id, slug, kind, status: 'DRAFT', adminAccountId: requireAccountId(account), payloadJson: JSON.stringify({ ...(reward ? { reward } : {}), eligibility }),
    title: plainText(input.title, 100, fallback.title), description: plainText(input.description, 240, fallback.description), imagePath,
    shareText: plainText(input.shareText, 180), notBefore: dateOrNull(input.notBefore), expiresAt: dateOrNull(input.expiresAt),
    totalActionLimit: input.totalActionLimit == null ? null : positiveInt(input.totalActionLimit), perAccountLimit: positiveInt(input.perAccountLimit), allowSelfAction: true,
  } });
  return { id, slug, url: `/s/${slug}` };
}

export async function listAdminLinks(): Promise<unknown[]> {
  return prisma.socialLink.findMany({ include: { _count: { select: { actions: true, escrows: true } } }, orderBy: { createdAt: 'desc' } });
}

export async function adminLinkDetail(id: string): Promise<unknown> {
  return prisma.socialLink.findUnique({ where: { id }, include: { actions: { orderBy: { createdAt: 'desc' } }, escrows: true } });
}

export async function adminLifecycle(account: ActiveAccount, id: string, operation: string, input: Json = {}, now = new Date()): Promise<unknown> {
  if (account.role !== 'ADMIN') throw new Error('Administrator access required.');
  if (operation === 'duplicate') {
    const source = await prisma.socialLink.findUnique({ where: { id } });
    if (!source) throw new Error('Social link not found.');
    const cloneId = randomUUID(); const slug = opaqueSlug();
    return prisma.socialLink.create({ data: { ...source, id: cloneId, slug, status: 'DRAFT', successfulActionCount: 0, activatedAt: null, revokedAt: null, createdAt: now, updatedAt: now, adminAccountId: requireAccountId(account) } });
  }
  return prisma.$transaction(async (tx) => {
    const link = await tx.socialLink.findUnique({ where: { id }, include: { creator: true, actions: true, escrows: true } });
    if (!link) throw new Error('Social link not found.');
    if (operation === 'activate' && link.status !== 'DRAFT') throw new Error('Only drafts can be activated.');
    if (operation === 'pause' && link.status !== 'ACTIVE') throw new Error('Only active links can be paused.');
    if (operation === 'resume' && link.status !== 'PAUSED') throw new Error('Only paused links can be resumed.');
    if (operation === 'revoke' || operation === 'expire') await returnEscrow(tx, link, now);
    const status = operation === 'patch' ? link.status : operation === 'activate' || operation === 'resume' ? 'ACTIVE' : operation === 'pause' ? 'PAUSED' : 'REVOKED';
    return tx.socialLink.update({ where: { id }, data: { status, activatedAt: operation === 'activate' ? now : link.activatedAt, revokedAt: status === 'REVOKED' ? now : null, expiresAt: operation === 'expire' ? now : link.expiresAt, ...(operation === 'patch' && link.status === 'DRAFT' ? {
      title: plainText(input.title, 100, link.title), description: plainText(input.description, 240, link.description), notBefore: dateOrNull(input.notBefore), expiresAt: dateOrNull(input.expiresAt),
    } : {}) } });
  });
}

/** Scheduled maintenance path. Public GET/HEAD never calls this. */
export async function sweepExpiredEscrow(now = new Date()): Promise<number> {
  const expired = await prisma.socialLink.findMany({
    where: { status: { in: ['ACTIVE', 'PAUSED'] }, expiresAt: { lte: now }, escrows: { some: { state: 'HELD' } } },
    include: { creator: true, actions: true, escrows: true },
  });
  let returned = 0;
  for (const link of expired) {
    await prisma.$transaction(async (tx) => {
      const current = await tx.socialLink.findUnique({ where: { id: link.id }, include: { creator: true, actions: true, escrows: true } });
      if (!current || !current.expiresAt || current.expiresAt > now) return;
      returned += current.escrows.filter((row) => row.state === 'HELD').length;
      await returnEscrow(tx, current, now);
    });
  }
  return returned;
}
