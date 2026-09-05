import * as path from 'node:path';
import { loadProjectEnv } from './env';

export type RpcCaptureMode = 'metadata' | 'full';

export interface ServerConfig {
  readonly port: number;
  readonly host: string;
  readonly serverRoot: string;
  readonly rcRoot: string;
  readonly assetSwfRoot: string;
  readonly assetDataRoot: string;
  readonly rebuiltSwf: string;
  readonly maxLogEntries: number;
  readonly rpcCaptureMode: RpcCaptureMode;
  readonly requestLogStdout: boolean;
  readonly discordDailyIngredientsWebhook?: string;
  readonly discordAnomalyWebhook?: string;
  readonly moderationScanIntervalMinutes: number;
  readonly moderationSnapshotRetentionDays: number;
  readonly moderationMaxSnapshotsPerPlayer: number;
  readonly leaderboardCacheMs: number;
  readonly activityFlushIntervalSeconds: number;
  readonly autoSaveSnapshotIntervalMinutes: number;
  readonly shutdownTimeoutSeconds: number;
}

export function loadConfig(): ServerConfig {
  const serverRoot = path.resolve(__dirname, '..');
  loadProjectEnv(serverRoot);
  if (process.env.NODE_ENV === 'production' && !process.env.RC_PIN_PEPPER) {
    throw new Error('RC_PIN_PEPPER is required when NODE_ENV=production.');
  }
  const rcRoot = path.resolve(serverRoot, '..');
  const production = process.env.NODE_ENV === 'production';

  return {
    port: Number(process.env.PORT) || 8090,
    host: process.env.HOST || '0.0.0.0',
    serverRoot,
    rcRoot,
    // Self-contained: every served asset lives under server/public/ (ADR-0011).
    assetSwfRoot: path.join(serverRoot, 'public', 'swf'),
    assetDataRoot: path.join(serverRoot, 'public', 'data'),
    // The game.swf we ship is the rebuilt client (crash fixes applied).
    rebuiltSwf: path.join(serverRoot, 'public', 'swf', 'game.swf'),
    maxLogEntries: positiveInt(process.env.MAX_LOG_ENTRIES, production ? 50 : 500),
    rpcCaptureMode: captureMode(process.env.RC_RPC_CAPTURE_MODE, production ? 'metadata' : 'full'),
    requestLogStdout: envBoolean(process.env.RC_REQUEST_LOG_STDOUT, !production),
    discordDailyIngredientsWebhook: process.env.RC_DISCORD_DAILY_INGREDIENTS_WEBHOOK || undefined,
    discordAnomalyWebhook: process.env.RC_DISCORD_ANOMALY_WEBHOOK || undefined,
    moderationScanIntervalMinutes: positiveInt(process.env.RC_MODERATION_SCAN_INTERVAL_MINUTES, 60),
    moderationSnapshotRetentionDays: positiveInt(process.env.RC_MODERATION_SNAPSHOT_RETENTION_DAYS, 90),
    moderationMaxSnapshotsPerPlayer: positiveInt(process.env.RC_MODERATION_MAX_SNAPSHOTS_PER_PLAYER, 250),
    leaderboardCacheMs: positiveInt(process.env.RC_LEADERBOARD_CACHE_MS, 60_000),
    activityFlushIntervalSeconds: positiveInt(process.env.RC_ACTIVITY_FLUSH_INTERVAL_SECONDS, 60),
    autoSaveSnapshotIntervalMinutes: positiveInt(process.env.RC_AUTO_SAVE_SNAPSHOT_INTERVAL_MINUTES, 60),
    shutdownTimeoutSeconds: positiveInt(process.env.RC_SHUTDOWN_TIMEOUT_SECONDS, 15),
  };
}

function captureMode(value: string | undefined, fallback: RpcCaptureMode): RpcCaptureMode {
  return value === 'metadata' || value === 'full' ? value : fallback;
}

function envBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.trim().toLowerCase() === 'true';
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

