import { loadConfig } from './config';
import { createServer } from './http-server';
import { startDailyIngredientScheduler } from './daily-ingredients/scheduler';
import { startModerationScheduler } from './moderation/scheduler';
import { repairLegacyCashIngredientPurchases } from './db/legacy-cash-ingredient-repair';
import { startDiscordNotificationScheduler } from './discord-notifications';
import { repairMisclassifiedRestaurantEntitlements } from './db/special-entitlement-repair';
import { repairLegacyAdminCoinMailRewards } from './db/legacy-coin-mail-repair';
import { configureRpcActivityBuffer } from './activity-buffer';
import { configureAutomaticSnapshotInterval } from './moderation/service';
import { gracefulShutdown } from './graceful-shutdown';
import type { SchedulerHandle } from './job-runner';

async function main(): Promise<void> {
  const config = loadConfig();
  const repair = await repairLegacyCashIngredientPurchases();
  if (repair.transactions > 0 || repair.skippedTransactions > 0) {
    console.log(
      `Legacy PF-cash ingredient repair: ${repair.transactions} transaction(s), ${repair.purchasedUnits} unit(s), `
      + `${repair.profiles} profile(s), ${repair.adjustedRows} inventory row(s), ${repair.skippedTransactions} skipped.`,
    );
  }
  const entitlementRepair = await repairMisclassifiedRestaurantEntitlements();
  if (entitlementRepair.profiles > 0) {
    console.log(
      `Restaurant entitlement repair: ${entitlementRepair.restoredItems} item(s) restored for `
      + `${entitlementRepair.profiles} profile(s), ${entitlementRepair.removedInventoryUnits} invalid inventory unit(s) removed, `
      + `${entitlementRepair.refundedCoins} coin(s) and ${entitlementRepair.refundedCash} PF cash refunded.`,
    );
  }
  const coinMailRepair = await repairLegacyAdminCoinMailRewards();
  if (coinMailRepair.mails > 0) {
    console.log(
      `Legacy coin-mail repair: ${coinMailRepair.credits} coin(s) credited from `
      + `${coinMailRepair.mails} mail(s) across ${coinMailRepair.profiles} profile(s).`,
    );
  }
  const { httpServer, staticFiles, backgroundScheduler } = createServer(config);
  configureRpcActivityBuffer(config.activityFlushIntervalSeconds);
  configureAutomaticSnapshotInterval(config.autoSaveSnapshotIntervalMinutes);
  const schedulers: SchedulerHandle[] = [backgroundScheduler];
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received; stopping new work and draining requests.`);
    try {
      const result = await gracefulShutdown(httpServer, schedulers, config.shutdownTimeoutSeconds * 1000);
      console.log(`Shutdown complete (requestsDrained=${result.drained}, activityFlushed=${result.activityFlushed}).`);
    } catch (error) {
      console.error('Graceful shutdown failed:', error);
      process.exitCode = 1;
    }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  httpServer.listen(config.port, config.host, () => {
    console.log('====================================================================');
    console.log(' Restaurant City Reborn - local server');
    console.log('====================================================================');
    console.log(` Listening      : http://localhost:${config.port}`);
    console.log(` Dashboard      : http://localhost:${config.port}/__dash`);
    console.log(` Static files   : ${staticFiles.size} indexed (self-contained: server/public)`);
    console.log(` game.swf serves: ${staticFiles.servesRebuiltGameSwf() ? 'REBUILT (localhost-wired)' : 'original'}`);
    console.log('');
    console.log(' Launch the client so it loads FROM this server:');
    console.log(`   "C:\\flex\\Player\\flashplayer_32_sa_debug.exe" http://localhost:${config.port}/game.swf`);
    console.log('====================================================================');
    if (!shuttingDown) {
      schedulers.push(
        startDailyIngredientScheduler(config.serverRoot, config.discordDailyIngredientsWebhook),
        startModerationScheduler(config.discordAnomalyWebhook, config.moderationScanIntervalMinutes, config.moderationSnapshotRetentionDays, config.moderationMaxSnapshotsPerPlayer),
        startDiscordNotificationScheduler(),
      );
    }
  });
}

main().catch((error) => {
  console.error('Server startup failed:', error);
  process.exitCode = 1;
});
