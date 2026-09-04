/**
 * Keep application-generated `IN (...)` lists and Prisma relation fan-out
 * queries well below SQLite's host-parameter ceiling.
 */
export const SQLITE_QUERY_BATCH_SIZE = 200;

export function queryBatches<T>(values: readonly T[], batchSize = SQLITE_QUERY_BATCH_SIZE): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += batchSize) {
    batches.push(values.slice(index, index + batchSize));
  }
  return batches;
}
