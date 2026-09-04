import type { Server } from 'node:http';
import type { SchedulerHandle } from './job-runner';
import { rpcActivityBuffer } from './activity-buffer';
import { performanceMetrics } from './performance';
import { prisma } from './db/client';

export async function gracefulShutdown(
  server: Server,
  schedulers: readonly SchedulerHandle[],
  timeoutMs: number,
): Promise<{ drained: boolean; activityFlushed: boolean }> {
  for (const scheduler of schedulers) scheduler.stop();
  const drained = await drainServer(server, timeoutMs);
  const activityFlushed = await rpcActivityBuffer.shutdown(timeoutMs);
  performanceMetrics.stop();
  await prisma.$disconnect();
  return { drained, activityFlushed };
}

async function drainServer(server: Server, timeoutMs: number): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  const idleSweep = setInterval(() => server.closeIdleConnections?.(), 25);
  idleSweep.unref();
  const closed = new Promise<boolean>((resolve) => {
    server.close((error) => resolve(!error || (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING'));
  });
  try {
    return await Promise.race([
      closed,
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => {
          server.closeAllConnections?.();
          resolve(false);
        }, Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    clearInterval(idleSweep);
    if (timeout) clearTimeout(timeout);
  }
}
