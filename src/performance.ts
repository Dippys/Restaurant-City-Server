import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { backgroundJobs } from './job-runner';
import { rpcActivityBuffer } from './activity-buffer';

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
  }

  snapshot() {
    const memory = process.memoryUsage();
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
      requestLatency: latencySnapshot(this.requestLatency),
      rpcCount: this.rpcCount,
      activeRequests: this.activeRequests,
      activityQueueSize: rpcActivityBuffer.size,
      rpcLatency: Object.fromEntries([...this.rpcLatency.entries()].map(([label, bucket]) => {
        return [label, latencySnapshot(bucket)];
      })),
      jobs: backgroundJobs.snapshot(),
    };
  }

  stop(): void {
    this.eventLoop.disable();
  }
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

export const performanceMetrics = new PerformanceMetrics();
