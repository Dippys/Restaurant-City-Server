import { prisma } from '../db/client';
import { sendPendingAnomalyDigest } from './discord';
import { scanAllProfiles } from './service';
import { pruneSnapshots } from './snapshots';

export async function runModerationCycle(webhookUrl: string | undefined, retentionDays = 90, maxSnapshotsPerPlayer = 250) {
  const summary = await scanAllProfiles();
  let discordSent = 0;
  let discordError = '';
  if (webhookUrl) {
    try {
      discordSent = (await sendPendingAnomalyDigest(webhookUrl)).sent;
    } catch (error) {
      discordError = error instanceof Error ? error.message : String(error);
    }
  }
  const snapshotsPruned = await pruneSnapshots(retentionDays, maxSnapshotsPerPlayer);
  const latestScan = await prisma.moderationScan.findFirst({ orderBy: { startedAt: 'desc' } });
  if (latestScan) await prisma.moderationScan.update({ where: { id: latestScan.id }, data: { discordAttempted: Boolean(webhookUrl), discordSent: discordSent > 0, discordError: discordError.slice(0, 1000) } });
  if (discordError) throw new Error(discordError);
  return { ...summary, discordSent, snapshotsPruned };
}

export function startModerationScheduler(webhookUrl: string | undefined, intervalMinutes = 60, retentionDays = 90, maxSnapshotsPerPlayer = 250): void {
  const intervalMs = Math.max(5, intervalMinutes) * 60_000;
  const run = () => runModerationCycle(webhookUrl, retentionDays, maxSnapshotsPerPlayer).catch((error) => console.error('Moderation cycle failed:', error));
  void run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
}
