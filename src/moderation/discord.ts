import { prisma } from '../db/client';

export function validateModerationWebhookUrl(value: string): string {
  const url = new URL(value);
  const allowedHost = url.hostname === 'discord.com' || url.hostname === 'discordapp.com';
  if (url.protocol !== 'https:' || !allowedHost || !/^\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+$/.test(url.pathname)) {
    throw new Error('RC_DISCORD_ANOMALY_WEBHOOK must be a Discord HTTPS webhook URL.');
  }
  return url.toString();
}

export async function sendPendingAnomalyDigest(webhookUrl: string): Promise<{ sent: number }> {
  const findings = await prisma.anomalyFinding.findMany({
    where: { status: { in: ['OPEN', 'REVIEWED', 'CONFIRMED'] } },
    orderBy: [{ score: 'desc' }, { lastSeenAt: 'desc' }],
  });
  const pending = findings.filter((finding) => finding.notifiedVersion < finding.evidenceVersion);
  if (!pending.length) return { sent: 0 };
  const accounts = await prisma.account.findMany({ where: { networkUid: { in: [...new Set(pending.map((item) => item.networkUid))] } }, select: { networkUid: true, username: true } });
  const usernames = new Map(accounts.map((account) => [account.networkUid, account.username]));
  const header = `@here 🚨 **Restaurant City anomaly digest** — ${pending.length} new or changed finding${pending.length === 1 ? '' : 's'}`;
  const lines: string[] = [];
  for (const finding of pending) {
    const line = `• **${finding.severity}** ${safeDiscordText(usernames.get(finding.networkUid) ?? finding.networkUid)} (${finding.networkUid}) — ${safeDiscordText(finding.title)}`;
    const remainder = pending.length - lines.length - 1;
    const candidateFooter = remainder > 0 ? `\n• …and ${remainder} more finding revisions. Open the Anomalies dashboard for the complete queue.` : '';
    if (`${header}\n\n${[...lines, line].join('\n')}${candidateFooter}`.length > 2000) break;
    lines.push(line);
  }
  const hidden = pending.length - lines.length;
  const footer = hidden > 0 ? `\n• …and ${hidden} more finding revisions. Open the Anomalies dashboard for the complete queue.` : '';
  const endpoint = new URL(validateModerationWebhookUrl(webhookUrl));
  endpoint.searchParams.set('wait', 'true');
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    username: 'RC Reborn Moderation',
    content: `${header}\n\n${lines.join('\n')}${footer}`,
    allowed_mentions: { parse: ['everyone'] },
  }) });
  if (!response.ok) throw new Error(`Discord moderation webhook returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
  await prisma.$transaction(pending.map((finding) => prisma.anomalyFinding.update({ where: { id: finding.id }, data: { notifiedVersion: finding.evidenceVersion } })));
  return { sent: pending.length };
}

function safeDiscordText(value: string): string {
  return String(value).replace(/@/g, '@\u200b').replace(/[\r\n]+/g, ' ').slice(0, 180);
}
