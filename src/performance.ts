import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { backgroundJobs } from './job-runner';
import { rpcActivityBuffer } from './activity-buffer';
import { databasePoolSnapshot } from './db/client';
import { sessionCacheSnapshot } from './session-cache';
import { profileSaveWork } from './database-work';
import { referenceCacheSnapshot } from './reference-cache';
import type { DatabasePoolSnapshot } from './db/client';

interface RpcLatencyBucket {
  count: number;
  totalMs: number;
  maxMs: number;
  samples: number[];
  cursor: number;
}

export class PerformanceMetrics {
  private requestCount = 0;
  private rpcCount = 0;
  private activeRequests = 0;
  private readonly rpcLatency = new Map<string, RpcLatencyBucket>();
  private readonly slowRpcLastAlert = new Map<string, number>();
  private readonly requestLatency: RpcLatencyBucket = { count: 0, totalMs: 0, maxMs: 0, samples: [], cursor: 0 };
  private readonly eventLoop = monitorEventLoopDelay({ resolution: 20 });

  constructor() {
    this.eventLoop.enable();
  }

  requestStarted(): number {
    this.requestCount += 1;
    this.activeRequests += 1;
    return performance.now();
  }

  requestFinished(durationMs: number): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    recordLatency(this.requestLatency, durationMs);
  }

  recordRpc(call: string, durationMs: number): void {
    this.rpcCount += 1;
    const label = safeRpcLabel(call);
    let bucket = this.rpcLatency.get(label);
    if (!bucket) {
      bucket = { count: 0, totalMs: 0, maxMs: 0, samples: [], cursor: 0 };
      this.rpcLatency.set(label, bucket);
    }
    recordLatency(bucket, durationMs);
    const now = Date.now();
    if (durationMs >= positiveInt(process.env.RC_RPC_P99_ALERT_MS, 3000)
      && now - (this.slowRpcLastAlert.get(label) ?? 0) >= 60_000) {
      this.slowRpcLastAlert.set(label, now);
      console.warn(`Slow RPC ${label}: ${Math.round(durationMs)}ms.`);
    }
  }

  snapshot() {
    const memory = process.memoryUsage();
    const requestLatency = latencySnapshot(this.requestLatency);
    const databasePool = databasePoolSnapshot();
    const rpcLatency = Object.fromEntries([...this.rpcLatency.entries()].map(([label, bucket]) => {
      return [label, latencySnapshot(bucket)];
    }));
    return {
      uptimeSeconds: Math.floor(process.uptime()),
      memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal },
      eventLoopDelayMs: {
        p50: nanosecondsToMs(this.eventLoop.percentile(50)),
        p95: nanosecondsToMs(this.eventLoop.percentile(95)),
        p99: nanosecondsToMs(this.eventLoop.percentile(99)),
        max: nanosecondsToMs(this.eventLoop.max),
      },
      requestCount: this.requestCount,
      requestLatency,
      rpcCount: this.rpcCount,
      activeRequests: this.activeRequests,
      activityQueueSize: rpcActivityBuffer.size,
      databasePool,
      sessionCache: sessionCacheSnapshot(),
      referenceCache: referenceCacheSnapshot(),
      profileSaves: profileSaveWork.snapshot(),
      alerts: buildPerformanceAlerts(databasePool, rpcLatency),
      rpcLatency,
      jobs: backgroundJobs.snapshot(),
    };
  }

  stop(): void {
    this.eventLoop.disable();
  }
}

interface LatencySnapshot {
  readonly count: number;
  readonly averageMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
}

export function buildPerformanceAlerts(databasePool: DatabasePoolSnapshot, rpcLatency: Readonly<Record<string, LatencySnapshot>>) {
  const alerts: Array<{ level: 'warning' | 'critical'; code: string; message: string }> = [];
  if (databasePool.waiting > 0) alerts.push({ level: 'warning', code: 'db-pool-waiting', message: `${databasePool.waiting} request(s) are waiting for a database connection.` });
  if (databasePool.consecutiveSaturatedSamples >= 5) alerts.push({ level: 'critical', code: 'db-pool-saturated', message: `The PostgreSQL pool has been saturated for ${databasePool.consecutiveSaturatedSamples} consecutive samples.` });
  if (databasePool.errors > 0) alerts.push({ level: 'warning', code: 'db-pool-errors', message: `${databasePool.errors} idle PostgreSQL client error(s) occurred since startup.` });

  const p95Limit = positiveInt(process.env.RC_RPC_P95_ALERT_MS, 1000);
  const p99Limit = positiveInt(process.env.RC_RPC_P99_ALERT_MS, 3000);
  for (const [label, latency] of Object.entries(rpcLatency)) {
    if (latency.count < 20) continue;
    if (latency.p99Ms >= p99Limit) alerts.push({ level: 'critical', code: `rpc-p99-${label}`, message: `${label} RPC p99 is ${latency.p99Ms}ms (limit ${p99Limit}ms).` });
    else if (latency.p95Ms >= p95Limit) alerts.push({ level: 'warning', code: `rpc-p95-${label}`, message: `${label} RPC p95 is ${latency.p95Ms}ms (limit ${p95Limit}ms).` });
  }
  return alerts;
}

function recordLatency(bucket: RpcLatencyBucket, durationMs: number): void {
  const duration = Math.max(0, durationMs);
  bucket.count += 1;
  bucket.totalMs += duration;
  bucket.maxMs = Math.max(bucket.maxMs, duration);
  if (bucket.samples.length < 256) bucket.samples.push(duration);
  else {
    bucket.samples[bucket.cursor] = duration;
    bucket.cursor = (bucket.cursor + 1) % bucket.samples.length;
  }
}

function latencySnapshot(bucket: RpcLatencyBucket) {
  const sorted = [...bucket.samples].sort((a, b) => a - b);
  return {
    count: bucket.count,
    averageMs: bucket.count ? round(bucket.totalMs / bucket.count) : 0,
    p50Ms: round(percentile(sorted, 0.50)),
    p95Ms: round(percentile(sorted, 0.95)),
    p99Ms: round(percentile(sorted, 0.99)),
    maxMs: round(bucket.maxMs),
  };
}

function safeRpcLabel(call: string): string {
  return /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(call) ? call : 'unknown';
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function nanosecondsToMs(value: number): number {
  return Number.isFinite(value) ? round(value / 1_000_000) : 0;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const performanceMetrics = new PerformanceMetrics();
