import { prisma } from './db/client';
import type { ActiveAccount } from './session';

export interface ActivityBatch {
  readonly accountId: string;
  readonly networkUid: string;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly requestCount: number;
  readonly rpcCount: number;
  readonly activeSecondsBetween: number;
}

export type ActivityPersist = (batch: ActivityBatch) => Promise<void>;

interface PendingActivity extends ActivityBatch {
  lastFlushAt: number;
  lastTouchedAt: number;
}

export class ActivityBuffer {
  private readonly pending = new Map<string, PendingActivity>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private timer?: NodeJS.Timeout;

  constructor(
    private flushIntervalMs: number,
    private readonly persist: ActivityPersist = persistActivity,
    private readonly now: () => number = Date.now,
    private readonly idleTtlMs = Math.max(flushIntervalMs * 5, 5 * 60_000),
  ) {}

  get size(): number {
    let queued = 0;
    for (const state of this.pending.values()) if (state.rpcCount > 0) queued += 1;
    return queued;
  }

  get trackedAccounts(): number {
    return this.pending.size;
  }

  start(flushIntervalMs = this.flushIntervalMs): void {
    this.stop();
    this.flushIntervalMs = Math.max(1, flushIntervalMs);
    this.timer = setInterval(() => {
      void this.flushDue().catch((error) => console.error('Activity flush failed:', error));
    }, this.flushIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  enqueueRpc(account: ActiveAccount, at = this.now()): void {
    if (!account.id) return;
    const prior = this.pending.get(account.id);
    if (!prior) {
      const timestamp = new Date(at);
      this.pending.set(account.id, {
        accountId: account.id, networkUid: account.networkUid,
        firstSeenAt: timestamp, lastSeenAt: timestamp,
        requestCount: 1, rpcCount: 1, activeSecondsBetween: 0,
        lastFlushAt: at, lastTouchedAt: at,
      });
      return;
    }
    const gapSeconds = Math.max(0, Math.floor((at - prior.lastSeenAt.getTime()) / 1000));
    this.pending.set(account.id, {
      ...prior,
      networkUid: account.networkUid,
      lastSeenAt: new Date(at),
      requestCount: prior.requestCount + 1,
      rpcCount: prior.rpcCount + 1,
      activeSecondsBetween: prior.activeSecondsBetween + Math.min(gapSeconds, 120),
      lastTouchedAt: at,
    });
  }

  async flushDue(force = false): Promise<void> {
    const now = this.now();
    const accountIds = [...this.pending.entries()]
      .filter(([, state]) => state.rpcCount > 0 && (force || now - state.lastFlushAt >= this.flushIntervalMs))
      .map(([accountId]) => accountId);
    await Promise.all(accountIds.map((accountId) => this.flushAccount(accountId)));
    this.cleanupIdle(now);
  }

  async flushAccount(accountId: string): Promise<void> {
    if (this.inFlight.has(accountId)) return;
    const state = this.pending.get(accountId);
    if (!state || state.rpcCount === 0) return;
    const batch: ActivityBatch = {
      accountId: state.accountId, networkUid: state.networkUid,
      firstSeenAt: state.firstSeenAt, lastSeenAt: state.lastSeenAt,
      requestCount: state.requestCount, rpcCount: state.rpcCount,
      activeSecondsBetween: state.activeSecondsBetween,
    };
    this.pending.set(accountId, {
      ...state, firstSeenAt: state.lastSeenAt,
      requestCount: 0, rpcCount: 0, activeSecondsBetween: 0,
      lastFlushAt: this.now(),
    });
    const persist = this.persist(batch);
    this.inFlight.set(accountId, persist);
    try {
      await persist;
    } catch (error) {
      const newer = this.pending.get(accountId);
      this.pending.set(accountId, newer ? mergeActivity(batch, newer) : {
        ...batch, lastFlushAt: this.now(), lastTouchedAt: this.now(),
      });
      throw error;
    } finally {
      this.inFlight.delete(accountId);
    }
  }

  cleanupIdle(now = this.now()): void {
    for (const [accountId, state] of this.pending) {
      if (state.rpcCount === 0 && !this.inFlight.has(accountId) && now - state.lastTouchedAt >= this.idleTtlMs) {
        this.pending.delete(accountId);
      }
    }
  }

  async shutdown(timeoutMs: number): Promise<boolean> {
    this.stop();
    let timeout: NodeJS.Timeout | undefined;
    const flush = async (): Promise<boolean> => {
      // An interval flush may already own an account. Let it settle, then force
      // a retry for any failed batch that was merged back into pending state.
      if (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight.values()]);
      try {
        await this.flushDue(true);
        return this.size === 0 && this.inFlight.size === 0;
      } catch (error) {
        console.error('Final activity flush failed:', error);
        return false;
      }
    };
    try {
      return await Promise.race([
        flush(),
        new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), Math.max(1, timeoutMs)); }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

function mergeActivity(older: ActivityBatch, newer: PendingActivity): PendingActivity {
  const bridgeSeconds = newer.rpcCount > 0
    ? Math.min(120, Math.max(0, Math.floor((newer.firstSeenAt.getTime() - older.lastSeenAt.getTime()) / 1000)))
    : 0;
  return {
    ...newer,
    networkUid: newer.networkUid || older.networkUid,
    firstSeenAt: older.firstSeenAt,
    lastSeenAt: newer.rpcCount > 0 ? newer.lastSeenAt : older.lastSeenAt,
    requestCount: older.requestCount + newer.requestCount,
    rpcCount: older.rpcCount + newer.rpcCount,
    activeSecondsBetween: older.activeSecondsBetween + bridgeSeconds + newer.activeSecondsBetween,
  };
}

async function persistActivity(batch: ActivityBatch): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.playerActivity.findUnique({ where: { accountId: batch.accountId } });
    if (!existing) {
      await tx.playerActivity.create({ data: {
        accountId: batch.accountId, networkUid: batch.networkUid,
        firstSeenAt: batch.firstSeenAt, lastSeenAt: batch.lastSeenAt, lastLoginAt: batch.firstSeenAt,
        totalActiveSeconds: batch.activeSecondsBetween,
        requestCount: batch.requestCount, rpcCount: batch.rpcCount,
      } });
      return;
    }
    const leadingGapSeconds = Math.min(120, Math.max(0, Math.floor((batch.firstSeenAt.getTime() - existing.lastSeenAt.getTime()) / 1000)));
    await tx.playerActivity.update({ where: { accountId: batch.accountId }, data: {
      networkUid: batch.networkUid,
      lastSeenAt: batch.lastSeenAt,
      totalActiveSeconds: { increment: leadingGapSeconds + batch.activeSecondsBetween },
      requestCount: { increment: batch.requestCount },
      rpcCount: { increment: batch.rpcCount },
    } });
  });
}

export const rpcActivityBuffer = new ActivityBuffer(60_000);

export function configureRpcActivityBuffer(intervalSeconds: number): void {
  rpcActivityBuffer.start(Math.max(1, intervalSeconds) * 1000);
}

export function recordRpcActivity(account: ActiveAccount): void {
  rpcActivityBuffer.enqueueRpc(account);
}
