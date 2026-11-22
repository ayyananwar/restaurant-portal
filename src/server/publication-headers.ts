import type { DatabaseSync } from 'node:sqlite';

// Menu, offers and receipt feedback must identify the same outlet installation.
export function publicationHeaders(db: DatabaseSync, token: string): Record<string, string> {
  const state = db.prepare('SELECT installation FROM offer_publication WHERE id = 1').get();
  if (typeof state?.installation !== 'string') throw new Error('The outlet installation is missing.');
  return { Authorization: `Bearer ${token}`, 'X-Outlet-Installation': state.installation };
}
