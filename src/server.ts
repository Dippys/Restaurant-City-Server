import { loadConfig } from './config';
import { createServer } from './http-server';
import { startDailyIngredientScheduler } from './daily-ingredients/scheduler';
import { startModerationScheduler } from './moderation/scheduler';
import { startDiscordNotificationScheduler } from './discord-notifications';
import { configureRpcActivityBuffer } from './activity-buffer';
import { configureAutomaticSnapshotInterval } from './moderation/service';
import { gracefulShutdown } from './graceful-shutdown';
import type { SchedulerHandle } from './job-runner';
import { databaseProvider } from './db/client';

async function main(): Promise<void> {
  const config = loadConfig();
  const { httpServer, staticFiles, backgroundScheduler } = createServer(config);
  configureRpcActivityBuffer(config.activityFlushIntervalSeconds, config.activityFlushConcurrency);
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
    console.log(` Database       : ${databaseProvider}`);
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
