import type { Employee, GardenPlot, Mail, UserProfile } from '@prisma/client';
import { prisma } from './db/client';
import { ingredientRarity } from './db/ingredient-catalog';
import { catalogEntry } from './db/item-catalog';

const DISCORD_API = 'https://discord.com/api/v10';
const NOTIFICATION_INTERVAL_MS = 60_000;
const GARDEN_GROW_TIME_SECONDS = 48 * 60 * 60;
const GIFT_COLOR = 0xf2b84b;
const TRADE_COLOR = 0x5865f2;
const MAIL_COLOR = 0x49b675;
const ENERGY_COLOR = 0xe67e22;
const GARDEN_COLOR = 0x57a773;

interface GardenPlotAlert {
  readonly plotId: number;
  readonly ingredientId: number;
}

export type DiscordGameNotification =
  | { readonly kind: 'gift'; readonly senderName: string; readonly itemId: number; readonly note?: string }
  | { readonly kind: 'tradeRequest'; readonly senderName: string; readonly offeredIngredientId: number; readonly requestedIngredientId: number }
  | { readonly kind: 'mail'; readonly senderName: string; readonly mailType: number; readonly itemIds: readonly number[]; readonly note?: string }
  | { readonly kind: 'employeesExhausted'; readonly employeeCount: number }
  | { readonly kind: 'gardenReady'; readonly plots: readonly GardenPlotAlert[] }
  | { readonly kind: 'gardenDry'; readonly plots: readonly GardenPlotAlert[] };

interface DiscordMessage {
  readonly content: string;
  readonly embeds: ReadonlyArray<Record<string, any>>;
  readonly components?: ReadonlyArray<Record<string, any>>;
  readonly allowed_mentions: { readonly parse: readonly string[] };
}

type MailWithSender = Mail & { sender: Pick<UserProfile, 'firstName' | 'fullName' | 'restaurantName'> };

export function startDiscordNotificationScheduler(intervalMs = NOTIFICATION_INTERVAL_MS): void {
  if (!process.env.RC_DISCORD_BOT_TOKEN) return;
  void runDiscordNotificationCycle().catch((error) => console.error('Discord notification cycle failed:', error));
  const timer = setInterval(() => {
    void runDiscordNotificationCycle().catch((error) => console.error('Discord notification cycle failed:', error));
  }, Math.max(10_000, intervalMs));
  timer.unref();
}

/** Process new mail and false→true game-state transitions for every linked account. */
export async function runDiscordNotificationCycle(now = new Date()): Promise<void> {
  if (!process.env.RC_DISCORD_BOT_TOKEN) return;
  const identities = await prisma.discordIdentity.findMany({
    where: { account: { disabled: false } },
    include: { account: { select: { id: true, networkUid: true } } },
  });
  for (const identity of identities) {
    await processLinkedAccount(
      identity.account.id,
      identity.account.networkUid,
      identity.discordUserId,
      identity.dmNotificationsEnabled,
      now,
    ).catch((error) => console.error(`Discord notification failed for account ${identity.account.id}:`, error));
  }
}

/** Establish a no-history baseline immediately when an existing account links. */
export async function initializeDiscordNotificationState(accountId: string, now = new Date()): Promise<void> {
  if (await prisma.discordNotificationState.findUnique({ where: { accountId }, select: { accountId: true } })) return;
  const account = await prisma.account.findUnique({ where: { id: accountId }, select: { networkUid: true } });
  if (!account) return;
  const profile = await prisma.userProfile.findUnique({
    where: { networkUid: account.networkUid },
    include: { employees: true, gardenPlots: true },
  });
  if (!profile) return;
  const latestMail = await prisma.mail.findFirst({ where: { recipientNetworkUid: account.networkUid }, orderBy: { id: 'desc' }, select: { id: true } });
  const garden = gardenAlertState(profile.gardenPlots, now);
  await prisma.discordNotificationState.create({ data: {
    accountId,
    lastMailId: latestMail?.id ?? 0,
    allEmployeesExhausted: allEmployeesExhausted(profile.employees),
    gardenReadyPlotIdsJson: idsJson(garden.ready),
    gardenDryPlotIdsJson: idsJson(garden.dry),
  } }).catch(() => undefined);
}

export function allEmployeesExhausted(employees: readonly Pick<Employee, 'happiness'>[]): boolean {
  return employees.length > 0 && employees.every((employee) => employee.happiness <= 0);
}

export function gardenAlertState(
  plots: readonly Pick<GardenPlot, 'plotId' | 'ingredientId' | 'plantWetTime' | 'timeToDry' | 'createdAt' | 'updatedAt'>[],
  now = new Date(),
): { ready: GardenPlotAlert[]; dry: GardenPlotAlert[] } {
  const ready: GardenPlotAlert[] = [];
  const dry: GardenPlotAlert[] = [];
  for (const plot of plots) {
    if (plot.ingredientId <= 0) continue;
    const growth = Math.min(GARDEN_GROW_TIME_SECONDS, bounded(plot.plantWetTime, GARDEN_GROW_TIME_SECONDS) + elapsedSeconds(plot.createdAt, now));
    const wetness = Math.max(0, bounded(plot.timeToDry, 9 * 60 * 60) - elapsedSeconds(plot.updatedAt, now));
    const alert = { plotId: plot.plotId, ingredientId: plot.ingredientId };
    if (growth >= GARDEN_GROW_TIME_SECONDS) ready.push(alert);
    else if (wetness <= 0) dry.push(alert);
  }
  return { ready, dry };
}

export function buildDiscordMessage(notification: DiscordGameNotification, now = new Date()): DiscordMessage {
  const sender = 'senderName' in notification ? safeDiscordText(notification.senderName, 100) || 'A fellow chef' : '';
  const components = gameComponents();

  if (notification.kind === 'gift') {
    const item = itemDetails(notification.itemId);
    const fields: Array<{ name: string; value: string; inline?: boolean }> = [
      { name: '🎁 Your gift', value: `${item.name}\nItem #${notification.itemId}`, inline: true },
      { name: '👨‍🍳 Sent by', value: sender, inline: true },
    ];
    const note = safeDiscordText(notification.note || '', 900);
    if (note) fields.push({ name: '💌 Chef’s note', value: note });
    return message({
      title: 'A surprise just arrived! 🎉',
      description: `${sender} left something special in your Restaurant City mailbox.`,
      color: GIFT_COLOR, fields, imageUrl: item.imageUrl,
      footer: 'Restaurant City Reborn • Your gift is waiting!', now, components,
    });
  }

  if (notification.kind === 'tradeRequest') {
    const offered = ingredientDetails(notification.offeredIngredientId);
    const requested = ingredientDetails(notification.requestedIngredientId);
    return message({
      title: 'A chef wants to trade! 🔄',
      description: `${sender} has proposed an ingredient swap. Take a look before another order burns!`,
      color: TRADE_COLOR,
      fields: [
        { name: '📦 They offer', value: offered.label, inline: true },
        { name: '🧺 They want', value: requested.label, inline: true },
        { name: '👨‍🍳 Trading chef', value: sender },
      ],
      imageUrl: offered.imageUrl,
      footer: 'Restaurant City Reborn • Open your mailbox to accept or decline', now, components,
    });
  }

  if (notification.kind === 'employeesExhausted') {
    return message({
      title: 'Your staff need a break! 😴',
      description: `All ${notification.employeeCount} of your employees have run out of energy. Your restaurant needs its head chef!`,
      color: ENERGY_COLOR,
      fields: [{ name: '🍎 What to do', value: 'Open Restaurant City and feed your employees so they can get back to work.' }],
      imageUrl: absoluteAsset('/assets/food-pizza.png'),
      footer: 'Restaurant City Reborn • A well-fed team is a happy team', now, components,
    });
  }

  if (notification.kind === 'gardenReady' || notification.kind === 'gardenDry') {
    const ready = notification.kind === 'gardenReady';
    const first = notification.plots[0];
    return message({
      title: ready ? 'Your garden is ready to harvest! 🌾' : 'Your garden is thirsty! 💧',
      description: ready
        ? `${plural(notification.plots.length, 'crop is', 'crops are')} fully grown and waiting to be harvested.`
        : `${plural(notification.plots.length, 'garden plot has', 'garden plots have')} run out of water. Give them a drink before checking back later!`,
      color: GARDEN_COLOR,
      fields: [{
        name: ready ? '🧺 Ready now' : '🪴 Needs water',
        value: notification.plots.map((plot) => `Plot ${plot.plotId + 1} — ${itemName(plot.ingredientId)}`).join('\n').slice(0, 1024),
      }],
      imageUrl: first ? absoluteAsset(`/assets/ingredients/${first.ingredientId}.png`) : '',
      footer: ready ? 'Restaurant City Reborn • Fresh ingredients await' : 'Restaurant City Reborn • Don’t leave your plants parched',
      now, components,
    });
  }

  const itemIds = notification.itemIds.filter((id) => Number.isInteger(id) && id > 0).slice(0, 10);
  if (notification.mailType === 4 && itemIds[0]) {
    return buildDiscordMessage({ kind: 'gift', senderName: sender, itemId: itemIds[0], note: notification.note }, now);
  }
  if (notification.mailType === 6 && itemIds.length >= 2) {
    return buildDiscordMessage({ kind: 'tradeRequest', senderName: sender, offeredIngredientId: itemIds[0], requestedIngredientId: itemIds[1] }, now);
  }
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [{ name: '👨‍🍳 From', value: sender }];
  if (itemIds.length) fields.push({ name: '📦 Included', value: itemIds.map(mailItemLabel).join('\n').slice(0, 1024) });
  const note = safeDiscordText(notification.note || '', 900);
  if (note) fields.push({ name: '💌 Message', value: note });
  const presentation = mailPresentation(notification.mailType);
  return message({
    ...presentation, fields,
    imageUrl: itemIds[0] ? itemDetails(itemIds[0]).imageUrl : absoluteAsset('/assets/chef.png'),
    footer: 'Restaurant City Reborn • New mail is waiting in your mailbox', now, components,
  });
}

async function processLinkedAccount(accountId: string, networkUid: string, discordUserId: string, deliver: boolean, now: Date): Promise<void> {
  const profile = await prisma.userProfile.findUnique({
    where: { networkUid },
    include: { employees: true, gardenPlots: true },
  });
  if (!profile) return;
  const employeeState = allEmployeesExhausted(profile.employees);
  const gardenState = gardenAlertState(profile.gardenPlots, now);
  let state = await prisma.discordNotificationState.findUnique({ where: { accountId } });
  if (!state) {
    await initializeDiscordNotificationState(accountId, now);
    return;
  }

  const newMails = await prisma.mail.findMany({
    where: { recipientNetworkUid: networkUid, id: { gt: state.lastMailId }, deleted: false },
    include: { sender: { select: { firstName: true, fullName: true, restaurantName: true } } },
    orderBy: { id: 'asc' }, take: 100,
  });
  for (const mail of newMails) {
    if (deliver) await sendDiscordNotificationToUser(discordUserId, notificationForMail(mail));
    await prisma.discordNotificationState.update({ where: { accountId }, data: { lastMailId: mail.id } });
    state = { ...state, lastMailId: mail.id };
  }

  if (employeeState !== state.allEmployeesExhausted) {
    if (deliver && employeeState) await sendDiscordNotificationToUser(discordUserId, { kind: 'employeesExhausted', employeeCount: profile.employees.length });
    await prisma.discordNotificationState.update({ where: { accountId }, data: { allEmployeesExhausted: employeeState } });
  }
  await updateGardenEdge(accountId, discordUserId, deliver, 'gardenReadyPlotIdsJson', gardenState.ready, state.gardenReadyPlotIdsJson, 'gardenReady');
  await updateGardenEdge(accountId, discordUserId, deliver, 'gardenDryPlotIdsJson', gardenState.dry, state.gardenDryPlotIdsJson, 'gardenDry');
}

async function updateGardenEdge(
  accountId: string,
  discordUserId: string,
  deliver: boolean,
  field: 'gardenReadyPlotIdsJson' | 'gardenDryPlotIdsJson',
  current: readonly GardenPlotAlert[],
  previousJson: string,
  kind: 'gardenReady' | 'gardenDry',
): Promise<void> {
  const previous = new Set(readIds(previousJson));
  const newlyTrue = current.filter((plot) => !previous.has(plot.plotId));
  if (deliver && newlyTrue.length) await sendDiscordNotificationToUser(discordUserId, { kind, plots: newlyTrue });
  const next = idsJson(current);
  if (next !== normalizedIdsJson(previousJson)) {
    await prisma.discordNotificationState.update({ where: { accountId }, data: { [field]: next } });
  }
}

function notificationForMail(mail: MailWithSender): DiscordGameNotification {
  return {
    kind: 'mail',
    senderName: mail.sender.fullName || mail.sender.firstName || mail.sender.restaurantName || 'Restaurant City',
    mailType: mail.type,
    itemIds: readNumberArray(mail.globalItemIdsJson),
    note: mail.message,
  };
}

async function sendDiscordNotificationToUser(discordUserId: string, notification: DiscordGameNotification): Promise<void> {
  const headers = { Authorization: `Bot ${process.env.RC_DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' };
  const channelResponse = await fetch(`${DISCORD_API}/users/@me/channels`, {
    method: 'POST', headers, body: JSON.stringify({ recipient_id: discordUserId }), signal: AbortSignal.timeout(10_000),
  });
  if (!channelResponse.ok) throw new Error(`create DM returned ${channelResponse.status}`);
  const channel = await channelResponse.json() as { id?: string };
  if (!channel.id) throw new Error('create DM returned no channel id');
  const response = await fetch(`${DISCORD_API}/channels/${channel.id}/messages`, {
    method: 'POST', headers, body: JSON.stringify(buildDiscordMessage(notification)), signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`send DM returned ${response.status}`);
}

function message(input: {
  title: string; description: string; color: number;
  fields: ReadonlyArray<{ name: string; value: string; inline?: boolean }>;
  imageUrl: string; footer: string; now: Date;
  components?: ReadonlyArray<Record<string, any>>;
}): DiscordMessage {
  return {
    content: '',
    embeds: [{
      title: input.title, description: input.description, color: input.color, fields: input.fields,
      ...(input.imageUrl ? { thumbnail: { url: input.imageUrl } } : {}),
      footer: { text: input.footer }, timestamp: input.now.toISOString(),
    }],
    ...(input.components ? { components: input.components } : {}),
    allowed_mentions: { parse: [] },
  };
}

function mailPresentation(type: number): { title: string; description: string; color: number } {
  const presentations: Record<number, [string, string]> = {
    1: ['A chef sent you a message! 💌', 'There’s a new note waiting in your Restaurant City mailbox.'],
    2: ['Your food quiz is ready! 🧠', 'Restaurant City has a fresh food quiz waiting for you.'],
    3: ['Restaurant City has news! 📣', 'A new system message has arrived.'],
    5: ['Your daily ingredients arrived! 🧺', 'Today’s ingredient bonus is waiting in your mailbox.'],
    7: ['A delivery just landed! 🪙', 'A currency delivery has arrived for your restaurant.'],
    8: ['Your trade was accepted! ✅', 'A chef accepted your ingredient trade. Check the result in your mailbox.'],
    9: ['A tasty staff gift arrived! 🍰', 'Your employees have a new treat waiting for them.'],
    10: ['A Food King reward arrived! 👑', 'Your Food King reward is ready to claim.'],
    11: ['A fan reward arrived! 🌟', 'A new fan-page reward is waiting for you.'],
    13: ['A special present arrived! 🎊', 'Restaurant City sent something special to your mailbox.'],
  };
  const [title, description] = presentations[type] ?? ['You’ve got Restaurant City mail! 📬', 'Something new is waiting in your mailbox.'];
  return { title, description, color: type === 8 ? TRADE_COLOR : MAIL_COLOR };
}

function ingredientDetails(id: number): { label: string; imageUrl: string } {
  const name = itemName(id);
  const rarity = ingredientRarity(id);
  const stars = rarity ? `${'★'.repeat(rarity)}${'☆'.repeat(Math.max(0, 5 - rarity))}` : 'Unknown rarity';
  return { label: `**${name}**\n${stars} • Ingredient #${id}`, imageUrl: absoluteAsset(`/assets/ingredients/${id}.png`) };
}

function itemDetails(id: number): { name: string; imageUrl: string } {
  const entry = catalogEntry(id);
  return {
    name: itemName(id),
    imageUrl: entry?.category === 'ingredient' ? absoluteAsset(`/assets/ingredients/${id}.png`) : absoluteAsset('/assets/chef.png'),
  };
}

function itemName(id: number): string {
  return safeDiscordText(catalogEntry(id)?.label || `Unknown item #${id}`, 100);
}

function mailItemLabel(id: number): string {
  return ingredientRarity(id) ? ingredientDetails(id).label : `**${itemName(id)}** • Item #${id}`;
}

function gameComponents(): ReadonlyArray<Record<string, any>> | undefined {
  const origin = publicOrigin();
  return origin ? [{ type: 1, components: [{ type: 2, style: 5, label: 'Open Restaurant City', emoji: { name: '🍽️' }, url: `${origin}/game` }] }] : undefined;
}

function absoluteAsset(path: string): string {
  const origin = publicOrigin();
  return origin ? `${origin}${path}` : '';
}

function publicOrigin(): string {
  const raw = String(process.env.RC_PUBLIC_ORIGIN || '').trim().replace(/\/$/, '');
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.origin : '';
  } catch { return ''; }
}

function idsJson(plots: readonly GardenPlotAlert[]): string {
  return JSON.stringify([...new Set(plots.map((plot) => plot.plotId))].sort((a, b) => a - b));
}

function normalizedIdsJson(value: string): string {
  return JSON.stringify(readIds(value));
}

function readIds(value: string): number[] {
  return readNumberArray(value).filter((id) => id >= 0).sort((a, b) => a - b);
}

function readNumberArray(value: string): number[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isInteger) : [];
  } catch { return []; }
}

function elapsedSeconds(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 1000));
}

function bounded(value: number, maximum: number): number {
  return Number.isInteger(value) ? Math.max(0, Math.min(maximum, value)) : 0;
}

function plural(count: number, singular: string, multiple: string): string {
  return `${count} ${count === 1 ? singular : multiple}`;
}

function safeDiscordText(value: string, maximum: number): string {
  return Array.from(String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/@/g, '@\u200b').replace(/\s+/g, ' ').trim()).slice(0, maximum).join('');
}
