import * as path from 'node:path';
import sharp = require('sharp');
import type { DailyIngredient } from './catalog';

const WIDTH = 900;
const HEIGHT = 500;

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character]!);
}

export async function renderDailyIngredientsImage(
  ingredients: readonly DailyIngredient[],
  serverRoot: string,
): Promise<Buffer> {
  if (ingredients.length !== 3) throw new Error('Daily ingredient image requires exactly three ingredients.');
  const cardXs = [80, 360, 640];
  const labels = ingredients.map((ingredient, index) => {
    const center = cardXs[index]! + 90;
    return `
      <text x="${center}" y="180" class="name">${escapeXml(ingredient.name)}</text>
      <rect x="${cardXs[index]}" y="195" width="180" height="190" rx="24" fill="#f7f4e9" stroke="#4a4a4a" stroke-width="10"/>
      <ellipse cx="${center}" cy="365" rx="77" ry="13" fill="#d7c996" opacity=".45"/>
      <text x="${center}" y="430" class="price">${ingredient.coinPrice}</text>`;
  }).join('');
  const stripes = Array.from({ length: 9 }, (_, index) =>
    `<path d="M${index * 100} 55h100l14 82q-50 34-100 0z" fill="${index % 2 === 0 ? '#168bd2' : '#f8fbf7'}"/>`,
  ).join('');
  const svg = Buffer.from(`
    <svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <rect width="900" height="500" fill="#e4bc67"/>
      <rect x="8" y="8" width="884" height="484" rx="18" fill="none" stroke="#9d7331" stroke-width="8" opacity=".45"/>
      <path d="M0 55h900v85H0z" fill="#137fc1"/>${stripes}
      <text x="450" y="120" class="title">Today's fresh ingredients!</text>
      ${labels}
      <rect x="20" y="452" width="860" height="32" rx="16" fill="#198b50" opacity=".9"/>
      <style>
        .title,.name,.price{font-family:'Arial Rounded MT Bold','Trebuchet MS',sans-serif;text-anchor:middle;paint-order:stroke;stroke:#202020;stroke-linejoin:round}
        .title{font-size:32px;font-weight:900;fill:white;stroke-width:7px}
        .name{font-size:25px;font-weight:900;fill:white;stroke-width:6px}
        .price{font-size:36px;font-weight:900;fill:white;stroke-width:8px}
      </style>
    </svg>`);

  const composites: sharp.OverlayOptions[] = [{ input: svg, top: 0, left: 0 }];
  for (let index = 0; index < ingredients.length; index += 1) {
    const iconPath = path.join(serverRoot, 'public', 'assets', 'ingredients', `${ingredients[index]!.id}.png`);
    composites.push({
      input: await sharp(iconPath).resize(130, 130, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      }).png().toBuffer(),
      top: 225,
      left: cardXs[index]! + 25,
    });
  }

  return sharp({ create: { width: WIDTH, height: HEIGHT, channels: 4, background: '#e4bc67' } })
    .composite(composites)
    .png()
    .toBuffer();
}
