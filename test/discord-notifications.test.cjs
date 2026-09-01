const test = require('node:test');
const assert = require('node:assert/strict');

const { buildDiscordMessage } = require('../dist/discord-notifications.js');

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
