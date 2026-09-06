const test = require('node:test');
const assert = require('node:assert/strict');

process.env.RC_RPC_P95_ALERT_MS = '1000';
process.env.RC_RPC_P99_ALERT_MS = '3000';
const { prisma } = require('../dist/db/client.js');
const { buildPerformanceAlerts, performanceMetrics } = require('../dist/performance.js');

test.after(async () => {
  performanceMetrics.stop();
  await prisma.$disconnect();
});

test('RPC percentile thresholds produce admin health alerts after enough samples', () => {
  for (let i = 0; i < 20; i += 1) performanceMetrics.recordRpc('slowCall', 1500);
  let alerts = performanceMetrics.snapshot().alerts;
  assert.equal(alerts.some((alert) => alert.code === 'rpc-p95-slowCall' && alert.level === 'warning'), true);

  performanceMetrics.recordRpc('slowCall', 4000);
  alerts = performanceMetrics.snapshot().alerts;
  assert.equal(alerts.some((alert) => alert.code === 'rpc-p99-slowCall' && alert.level === 'critical'), true);
});

test('pool waiting and sustained saturation produce health alerts', () => {
  const alerts = buildPerformanceAlerts({
    provider: 'PostgreSQL', max: 20, total: 20, idle: 0, waiting: 3,
    errors: 1, lastError: 'test', waitingHighWater: 3, saturatedSamples: 8,
    lastSaturatedAt: new Date().toISOString(), consecutiveSaturatedSamples: 8,
  }, {});
  assert.equal(alerts.some((alert) => alert.code === 'db-pool-waiting'), true);
  assert.equal(alerts.some((alert) => alert.code === 'db-pool-saturated' && alert.level === 'critical'), true);
  assert.equal(alerts.some((alert) => alert.code === 'db-pool-errors'), true);
});
