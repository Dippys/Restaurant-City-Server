import { prisma } from './db/client';

const DISCORD_API = 'https://discord.com/api/v10';

/** Best-effort bot DM. Game writes never fail because Discord is unavailable. */
export function queueDiscordNotification(networkUid: string, message: string): void {
  if (!process.env.RC_DISCORD_BOT_TOKEN) return;
  void sendDiscordNotification(networkUid, message).catch((error) => console.error('Discord DM failed:', error));
}

async function sendDiscordNotification(networkUid: string, message: string): Promise<void> {
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
    method: 'POST', headers, body: JSON.stringify({ content: message.slice(0, 2000), allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(10_000),
  });
  if (!messageResponse.ok) throw new Error(`send DM returned ${messageResponse.status}`);
}
