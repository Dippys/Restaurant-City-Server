const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  coinPriceForPfCash,
  dailyIngredientCatalog,
  selectDailyIngredients,
} = require('../dist/daily-ingredients/catalog.js');
const { dailyIngredientsMessage, validateDiscordWebhookUrl } = require('../dist/daily-ingredients/discord.js');
const { renderDailyIngredientsImage } = require('../dist/daily-ingredients/image.js');
const { dueUtcDate, millisecondsUntilNextNoonUtc, rotationUtcDate } = require('../dist/daily-ingredients/scheduler.js');

test('PF cash maps proportionally to daily coin prices', () => {
  assert.equal(coinPriceForPfCash(4), 1000);
  assert.equal(coinPriceForPfCash(6), 1500);
  assert.equal(coinPriceForPfCash(8), 2000);
  assert.equal(coinPriceForPfCash(5), null);
  assert.ok(dailyIngredientCatalog().every((item) => item.coinPrice === item.pfCash * 250));
});

test('selection is distinct and avoids the previous day when enough alternatives exist', () => {
  const catalog = dailyIngredientCatalog();
  const previous = new Set(catalog.slice(0, 3).map((item) => item.id));
  const selected = selectDailyIngredients(catalog, previous, () => 0);
  assert.equal(selected.length, 3);
  assert.equal(new Set(selected.map((item) => item.id)).size, 3);
  assert.ok(selected.every((item) => !previous.has(item.id)));
});

test('UTC due date and next-noon delay use 12:00 UTC', () => {
  assert.equal(dueUtcDate(new Date('2026-08-27T11:59:59.000Z')), null);
  assert.equal(dueUtcDate(new Date('2026-08-27T12:00:00.000Z')), '2026-08-27');
  assert.equal(millisecondsUntilNextNoonUtc(new Date('2026-08-27T11:00:00.000Z')), 60 * 60 * 1000);
  assert.equal(millisecondsUntilNextNoonUtc(new Date('2026-08-27T12:00:00.000Z')), 24 * 60 * 60 * 1000);
  assert.equal(rotationUtcDate(new Date('2026-08-27T11:00:00.000Z'), false), null);
  assert.equal(rotationUtcDate(new Date('2026-08-27T11:00:00.000Z'), true), '2026-08-27');
});

test('Discord copy pings everyone, includes all items, and only accepts Discord webhook hosts', () => {
  const selected = dailyIngredientCatalog().slice(0, 3);
  const message = dailyIngredientsMessage(selected);
  assert.match(message, /^@everyone/);
  for (const ingredient of selected) assert.match(message, new RegExp(ingredient.name));
  assert.match(validateDiscordWebhookUrl('https://discord.com/api/webhooks/123/token_ABC-xyz'), /^https:\/\/discord\.com/);
  assert.throws(() => validateDiscordWebhookUrl('https://example.com/api/webhooks/123/token'));
});

test('announcement renderer creates a PNG with the three original ingredient icons', async () => {
  const image = await renderDailyIngredientsImage(dailyIngredientCatalog().slice(0, 3), path.resolve(__dirname, '..'));
  assert.equal(image.readUInt32BE(0), 0x89504e47);
  assert.ok(image.length > 10_000);
});
