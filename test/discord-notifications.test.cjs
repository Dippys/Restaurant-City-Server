const test = require('node:test');
const assert = require('node:assert/strict');

const { allEmployeesExhausted, buildDiscordMessage, gardenAlertState } = require('../dist/discord-notifications.js');

test('gift Discord notification is a branded embed with item, sender, note, art, and game link', () => {
  process.env.RC_PUBLIC_ORIGIN = 'https://rc-reborn.uk/';
  const message = buildDiscordMessage({
    kind: 'gift', senderName: 'Dippytest', itemId: 3040001,
    note: 'This chair would look great by the window!',
  }, new Date('2026-09-01T12:00:00.000Z'));
  assert.equal(message.content, '');
  assert.deepEqual(message.allowed_mentions, { parse: [] });
  assert.equal(message.embeds[0].title, 'A surprise just arrived! 🎉');
  assert.match(message.embeds[0].description, /Dippytest/);
  assert.match(message.embeds[0].fields[0].value, /Classic Chair/);
  assert.match(message.embeds[0].fields[2].value, /look great by the window/);
  assert.equal(message.embeds[0].thumbnail.url, 'https://rc-reborn.uk/assets/chef.png');
  assert.equal(message.components[0].components[0].url, 'https://rc-reborn.uk/game');
});

test('trade Discord notification names both ingredients with rarity and neutralizes mentions', () => {
  process.env.RC_PUBLIC_ORIGIN = 'https://rc-reborn.uk';
  const message = buildDiscordMessage({
    kind: 'tradeRequest', senderName: '@everyone Dippytest',
    offeredIngredientId: 4000002, requestedIngredientId: 4000004,
  }, new Date('2026-09-01T12:00:00.000Z'));
  const embed = message.embeds[0];
  assert.equal(embed.title, 'A chef wants to trade! 🔄');
  assert.match(embed.description, /@​everyone Dippytest/);
  assert.match(embed.fields[0].value, /Banana/);
  assert.match(embed.fields[0].value, /★★★☆☆/);
  assert.match(embed.fields[1].value, /Beans/);
  assert.match(embed.fields[1].value, /★☆☆☆☆/);
  assert.equal(embed.thumbnail.url, 'https://rc-reborn.uk/assets/ingredients/4000002.png');
  assert.deepEqual(message.allowed_mentions, { parse: [] });
});

test('generic mail and employee alerts retain branded, actionable details', () => {
  process.env.RC_PUBLIC_ORIGIN = 'https://rc-reborn.uk';
  const mail = buildDiscordMessage({ kind: 'mail', senderName: 'Mia Stone', mailType: 1, itemIds: [], note: 'Come visit my restaurant!' });
  assert.equal(mail.embeds[0].title, 'A chef sent you a message! 💌');
  assert.match(mail.embeds[0].fields[0].value, /Mia Stone/);
  assert.match(mail.embeds[0].fields[1].value, /Come visit/);
  const energy = buildDiscordMessage({ kind: 'employeesExhausted', employeeCount: 4 });
  assert.equal(energy.embeds[0].title, 'Your staff need a break! 😴');
  assert.match(energy.embeds[0].description, /All 4/);
  assert.equal(allEmployeesExhausted([{ happiness: 0 }, { happiness: 0 }]), true);
  assert.equal(allEmployeesExhausted([{ happiness: 0 }, { happiness: 1 }]), false);
  assert.equal(allEmployeesExhausted([]), false);
});

test('garden state distinguishes dry growing crops from fully grown crops', () => {
  const now = new Date('2026-09-01T12:00:00.000Z');
  const dry = gardenAlertState([{ plotId: 0, ingredientId: 4000040, plantWetTime: 0, timeToDry: 3600, createdAt: new Date(now.getTime() - 7200_000), updatedAt: new Date(now.getTime() - 7200_000) }], now);
  assert.deepEqual(dry.ready, []);
  assert.deepEqual(dry.dry, [{ plotId: 0, ingredientId: 4000040 }]);
  const ready = gardenAlertState([{ plotId: 1, ingredientId: 4000034, plantWetTime: 0, timeToDry: 3600, createdAt: new Date(now.getTime() - 49 * 3600_000), updatedAt: now }], now);
  assert.deepEqual(ready.ready, [{ plotId: 1, ingredientId: 4000034 }]);
  assert.deepEqual(ready.dry, []);
  const embed = buildDiscordMessage({ kind: 'gardenReady', plots: ready.ready }, now);
  assert.equal(embed.embeds[0].title, 'Your garden is ready to harvest! 🌾');
  assert.match(embed.embeds[0].fields[0].value, /Plot 2 — Salad/);
});
