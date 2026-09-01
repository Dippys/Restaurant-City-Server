import { prisma } from './db/client';
import { ingredientRarity } from './db/ingredient-catalog';
import { catalogEntry } from './db/item-catalog';

const DISCORD_API = 'https://discord.com/api/v10';
const GIFT_COLOR = 0xf2b84b;
const TRADE_COLOR = 0x5865f2;

export type DiscordGameNotification =
  | { readonly kind: 'gift'; readonly senderName: string; readonly itemId: number; readonly note?: string }
  | { readonly kind: 'tradeRequest'; readonly senderName: string; readonly offeredIngredientId: number; readonly requestedIngredientId: number };

interface DiscordMessage {
  readonly content: string;
  readonly embeds: ReadonlyArray<Record<string, any>>;
  readonly components?: ReadonlyArray<Record<string, any>>;
  readonly allowed_mentions: { readonly parse: readonly string[] };
}

/** Best-effort bot DM. Game writes never fail because Discord is unavailable. */
export function queueDiscordNotification(networkUid: string, notification: DiscordGameNotification): void {
  if (!process.env.RC_DISCORD_BOT_TOKEN) return;
  void sendDiscordNotification(networkUid, notification).catch((error) => console.error('Discord DM failed:', error));
}

export function buildDiscordMessage(notification: DiscordGameNotification, now = new Date()): DiscordMessage {
  const origin = publicOrigin();
  const sender = safeDiscordText(notification.senderName, 100) || 'A fellow chef';
  const gameUrl = origin ? `${origin}/game` : '';
  const components = gameUrl ? [{
    type: 1,
    components: [{ type: 2, style: 5, label: 'Open Restaurant City', emoji: { name: '🍽️' }, url: gameUrl }],
  }] : undefined;

  if (notification.kind === 'gift') {
    const item = itemDetails(notification.itemId);
    const fields: Array<{ name: string; value: string; inline?: boolean }> = [
      { name: '🎁 Your gift', value: `${item.name}\nItem #${notification.itemId}`, inline: true },
      { name: '👨‍🍳 Sent by', value: sender, inline: true },
    ];
    const note = safeDiscordText(notification.note || '', 900);
    if (note) fields.push({ name: '💌 Chef’s note', value: note });
    return {
      content: '',
      embeds: [{
        title: 'A surprise just arrived! 🎉',
        description: `${sender} left something special in your Restaurant City mailbox.`,
        color: GIFT_COLOR,
        fields,
        ...(item.imageUrl ? { thumbnail: { url: item.imageUrl } } : {}),
        footer: { text: 'Restaurant City Reborn • Your gift is waiting!' },
        timestamp: now.toISOString(),
      }],
      ...(components ? { components } : {}),
      allowed_mentions: { parse: [] },
    };
  }

  const offered = ingredientDetails(notification.offeredIngredientId);
  const requested = ingredientDetails(notification.requestedIngredientId);
  return {
    content: '',
    embeds: [{
      title: 'A chef wants to trade! 🔄',
      description: `${sender} has proposed an ingredient swap. Take a look before another order burns!`,
      color: TRADE_COLOR,
      fields: [
        { name: '📦 They offer', value: offered.label, inline: true },
        { name: '🧺 They want', value: requested.label, inline: true },
        { name: '👨‍🍳 Trading chef', value: sender },
      ],
      ...(offered.imageUrl ? { thumbnail: { url: offered.imageUrl } } : {}),
      footer: { text: 'Restaurant City Reborn • Open your mailbox to accept or decline' },
      timestamp: now.toISOString(),
    }],
    ...(components ? { components } : {}),
    allowed_mentions: { parse: [] },
  };
}

async function sendDiscordNotification(networkUid: string, notification: DiscordGameNotification): Promise<void> {
  const identity = await prisma.discordIdentity.findFirst({
    where: { account: { networkUid, disabled: false }, dmNotificationsEnabled: true },
    select: { discordUserId: true },
  });
  if (!identity) return;
  const headers = { Authorization: `Bot ${process.env.RC_DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' };
  const channelResponse = await fetch(`${DISCORD_API}/users/@me/channels`, {
    method: 'POST', headers, body: JSON.stringify({ recipient_id: identity.discordUserId }), signal: AbortSignal.timeout(10_000),
  });
  if (!channelResponse.ok) throw new Error(`create DM returned ${channelResponse.status}`);
  const channel = await channelResponse.json() as { id?: string };
  if (!channel.id) throw new Error('create DM returned no channel id');
  const messageResponse = await fetch(`${DISCORD_API}/channels/${channel.id}/messages`, {
    method: 'POST', headers, body: JSON.stringify(buildDiscordMessage(notification)), signal: AbortSignal.timeout(10_000),
  });
  if (!messageResponse.ok) throw new Error(`send DM returned ${messageResponse.status}`);
}

function ingredientDetails(id: number): { label: string; imageUrl: string } {
  const entry = catalogEntry(id);
  const name = safeDiscordText(entry?.label || `Unknown ingredient #${id}`, 100);
  const rarity = ingredientRarity(id);
  const stars = rarity ? `${'★'.repeat(rarity)}${'☆'.repeat(Math.max(0, 5 - rarity))}` : 'Unknown rarity';
  return {
    label: `**${name}**\n${stars} • Ingredient #${id}`,
    imageUrl: absoluteAsset(`/assets/ingredients/${id}.png`),
  };
}

function itemDetails(id: number): { name: string; imageUrl: string } {
  const entry = catalogEntry(id);
  return {
    name: safeDiscordText(entry?.label || `Unknown item #${id}`, 100),
    imageUrl: entry?.category === 'ingredient'
      ? absoluteAsset(`/assets/ingredients/${id}.png`)
      : absoluteAsset('/assets/chef.png'),
  };
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

function safeDiscordText(value: string, maximum: number): string {
  return Array.from(String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/@/g, '@\u200b')
    .replace(/\s+/g, ' ')
    .trim())
    .slice(0, maximum)
    .join('');
}
