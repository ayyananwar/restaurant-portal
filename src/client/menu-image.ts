import type { MenuItem } from '../shared/contracts.js';
import { formatPublicationTime, groupMenu } from './menu-display.js';
import { formatPaise } from './money.js';

const width = 1080;
const height = 1350;
const inset = 72;
const contentWidth = width - inset * 2;
const font = '"Segoe UI", system-ui, sans-serif';
const titleFont = '58px Georgia, serif';
const categoryFont = '40px Georgia, serif';
const itemFont = `600 34px ${font}`;
const priceFont = `700 32px ${font}`;
const segmenter = new Intl.Segmenter('en-IN', { granularity: 'grapheme' });

type Dish = Pick<MenuItem, 'id' | 'name' | 'category' | 'pricePaise' | 'available'>;
type Row = { dish: Dish; lines: string[]; price: string; top: number; heading: string[] };
export type MenuImage = { title: string; titleLines: string[]; date: string; pages: Row[][] };

function context(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Image canvas unavailable.');
  return ctx;
}

function wrap(ctx: CanvasRenderingContext2D, value: string, maxWidth: number) {
  const lines: string[] = [];
  let line = '';
  for (const word of value.trim().split(/\s+/u)) {
    const joined = line ? `${line} ${word}` : word;
    if (ctx.measureText(joined).width <= maxWidth) {
      line = joined;
      continue;
    }
    if (line) lines.push(line);
    line = '';
    if (ctx.measureText(word).width <= maxWidth) {
      line = word;
      continue;
    }
    for (const { segment } of segmenter.segment(word)) {
      if (line && ctx.measureText(line + segment).width > maxWidth) {
        lines.push(line);
        line = '';
      }
      line += segment;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function prepareMenuImage(title: string, menu: readonly Dish[], timestamp = Date.now()): MenuImage {
  const ctx = context(document.createElement('canvas'));
  ctx.font = titleFont;
  const titleLines = wrap(ctx, title, contentWidth);
  const bodyTop = inset + titleLines.length * 70 + 42;
  const pages: Row[][] = [];
  let rows: Row[] = [];
  let top = bodyTop;
  for (const [category, dishes] of groupMenu(menu)) {
    ctx.font = categoryFont;
    const headingLines = wrap(ctx, category, contentWidth);
    let newCategory = true;
    for (const dish of dishes) {
      const price = formatPaise(dish.pricePaise);
      ctx.font = priceFont;
      const priceWidth = ctx.measureText(price).width;
      ctx.font = itemFont;
      const lines = wrap(ctx, dish.name, contentWidth - priceWidth - 30);
      const rowHeight = Math.max(lines.length, 1) * 44 + (dish.available ? 0 : 40) + 26;
      const headingHeight = headingLines.length * 48 + 16;
      if (rows.length && top + (newCategory ? headingHeight : 0) + rowHeight > height - 132) {
        pages.push(rows);
        rows = [];
        top = bodyTop;
        newCategory = true;
      }
      const heading = newCategory ? headingLines : [];
      rows.push({ dish, lines, price, top, heading });
      top += (newCategory ? headingHeight : 0) + rowHeight;
      newCategory = false;
    }
  }
  if (rows.length) pages.push(rows);
  return { title, titleLines, date: formatPublicationTime(timestamp), pages };
}

export function drawMenuImage(canvas: HTMLCanvasElement, image: MenuImage, index: number) {
  canvas.width = width;
  canvas.height = height;
  const ctx = context(canvas);
  ctx.fillStyle = '#faf6ee';
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#7c3828';
  ctx.font = titleFont;
  image.titleLines.forEach((line, i) => ctx.fillText(line, inset, inset + i * 70));
  ctx.fillRect(inset, inset + image.titleLines.length * 70 + 14, contentWidth, 3);

  for (const row of image.pages[index] ?? []) {
    let y = row.top;
    if (row.heading.length) {
      ctx.font = categoryFont;
      ctx.fillStyle = '#7c3828';
      row.heading.forEach((line, i) => ctx.fillText(line, inset, y + i * 48));
      y += row.heading.length * 48 + 16;
    }
    ctx.fillStyle = '#2b271f';
    ctx.font = itemFont;
    row.lines.forEach((line, i) => ctx.fillText(line, inset, y + i * 44));
    ctx.font = priceFont;
    ctx.textAlign = 'right';
    ctx.fillText(row.price, width - inset, y + 2);
    ctx.textAlign = 'left';
    y += Math.max(row.lines.length, 1) * 44;
    if (!row.dish.available) {
      ctx.fillStyle = '#793a2d';
      ctx.font = `650 27px ${font}`;
      ctx.fillText('Sold out', inset, y);
      y += 40;
    }
    ctx.fillStyle = '#d8cabb';
    ctx.fillRect(inset, y + 8, contentWidth, 2);
  }

  ctx.fillStyle = '#5f5545';
  ctx.font = `26px ${font}`;
  ctx.fillText(`Menu as of ${image.date} IST`, inset, height - 82);
  ctx.textAlign = 'right';
  ctx.fillText(`${index + 1} / ${image.pages.length}`, width - inset, height - 82);
}

export function menuImageBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => {
    if (blob) resolve(blob);
    else reject(new Error('Image download unavailable.'));
  }, 'image/png'));
}
