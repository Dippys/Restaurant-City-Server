import type { DailyIngredient } from './catalog';

export function dailyIngredientsMessage(ingredients: readonly DailyIngredient[]): string {
  const list = ingredients.map((ingredient) => `- ${ingredient.name} — ${ingredient.coinPrice.toLocaleString('en-US')} coins`).join('\n');
  return `@everyone\n\nHey Chefs!\n\nToday's fresh ingredients are:\n\n${list}\n\nReload your game to see them. Happy cooking!`;
}

export function validateDiscordWebhookUrl(value: string): string {
  const url = new URL(value);
  const allowedHost = url.hostname === 'discord.com' || url.hostname === 'discordapp.com';
  if (url.protocol !== 'https:' || !allowedHost || !/^\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+$/.test(url.pathname)) {
    throw new Error('RC_DISCORD_DAILY_INGREDIENTS_WEBHOOK must be a Discord HTTPS webhook URL.');
  }
  return url.toString();
}

export async function sendDailyIngredientsDiscord(
  webhookUrl: string,
  ingredients: readonly DailyIngredient[],
  image: Buffer,
): Promise<void> {
  const endpoint = new URL(validateDiscordWebhookUrl(webhookUrl));
  endpoint.searchParams.set('wait', 'true');
  const form = new FormData();
  form.set('payload_json', JSON.stringify({
    content: dailyIngredientsMessage(ingredients),
    allowed_mentions: { parse: ['everyone'] },
    attachments: [{ id: 0, filename: 'daily-ingredients.png', description: 'Today\'s three fresh ingredients and coin prices' }],
  }));
  const imageBytes = new ArrayBuffer(image.byteLength);
  new Uint8Array(imageBytes).set(image);
  form.set('files[0]', new Blob([imageBytes], { type: 'image/png' }), 'daily-ingredients.png');
  const response = await fetch(endpoint, { method: 'POST', body: form });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Discord webhook returned ${response.status}: ${detail}`);
  }
}
