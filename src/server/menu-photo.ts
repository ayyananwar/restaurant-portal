import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { maxMenuPhotoBytes } from '../shared/contracts.js';
import { WorkflowError } from './store.js';

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function normalizePhoto(encoded: string) {
  const input = Buffer.from(encoded, 'base64');
  if (!input.length || input.length > maxMenuPhotoBytes || input.toString('base64') !== encoded) {
    throw new WorkflowError(400, 'Choose a JPEG, PNG, or WebP photo under 4 MB.');
  }
  const supported = input.subarray(0, 8).equals(pngSignature)
    || (input[0] === 255 && input[1] === 216 && input[2] === 255)
    || (input.toString('ascii', 0, 4) === 'RIFF' && input.toString('ascii', 8, 12) === 'WEBP');
  if (!supported) throw new WorkflowError(400, 'Choose a JPEG, PNG, or WebP photo.');
  try {
    const image = sharp(input, { limitInputPixels: 16_000_000, failOn: 'error' });
    const metadata = await image.metadata();
    if ((metadata.pages ?? 1) > 1) throw new Error('Animated photo');
    return await image.rotate().resize(1200, 900, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  } catch {
    throw new WorkflowError(400, 'This photo could not be opened. Use a still image up to 16 megapixels.');
  }
}

export async function updateMenuPhoto(db: DatabaseSync, id: number, revision: number, encoded: string | null) {
  const image = encoded === null ? null : await normalizePhoto(encoded);
  const key = image ? createHash('sha256').update(image).digest('hex') : null;
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = db.prepare(`
      SELECT m.revision, p.photo_key FROM menu m LEFT JOIN menu_photos p ON p.menu_id = m.id WHERE m.id = ?
    `).get(id);
    if (!current) throw new WorkflowError(404, 'Dish not found.');
    if (current.photo_key !== key) {
      if (current.revision !== revision) throw new WorkflowError(409, 'This dish changed. Review the current photo before saving.');
      if (image && key) {
        db.prepare(`
          INSERT INTO menu_photos (menu_id, photo_key, image) VALUES (?, ?, ?)
          ON CONFLICT(menu_id) DO UPDATE SET photo_key = excluded.photo_key, image = excluded.image
        `).run(id, key, image);
      } else {
        db.prepare('DELETE FROM menu_photos WHERE menu_id = ?').run(id);
      }
      db.prepare('UPDATE menu SET revision = revision + 1 WHERE id = ?').run(id);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function readMenuPhoto(db: DatabaseSync, id: number, key: string) {
  const row = db.prepare('SELECT image FROM menu_photos WHERE menu_id = ? AND photo_key = ?').get(id, key);
  return row?.image instanceof Uint8Array ? Buffer.from(row.image) : null;
}
