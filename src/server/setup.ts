import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { roles } from '../shared/contracts.js';
import { createStaff, openStore } from './store.js';

if (process.argv[2] !== '--demo') throw new Error('Use --demo to create a sample outlet.');
const path = resolve(process.env.RESTAURANT_DB ?? 'data/outlet.sqlite');
mkdirSync(dirname(path), { recursive: true });
const db = openStore(path);
try {
  db.exec('BEGIN IMMEDIATE');
  if (db.prepare('SELECT id FROM staff LIMIT 1').get()) throw new Error('This outlet already has staff accounts.');
  const accounts = [...roles, 'waiter-two' as const].map(username => {
    const password = randomBytes(18).toString('base64url');
    createStaff(db, username, username === 'waiter-two' ? 'Second waiter' : `Sample ${username}`,
      username === 'waiter-two' ? 'waiter' : username, password);
    return { username, password };
  });
  db.exec(`
    INSERT INTO dining_tables (label) VALUES ('Table 1'), ('Table 4'), ('Table 7'), ('Table 9');
    INSERT INTO menu (name, price_paise, category) VALUES
      ('Masala chai', 6000, 'Drinks'), ('Paneer tikka', 24000, 'Starters'),
      ('Veg biryani', 22000, 'Mains'), ('Gulab jamun', 9000, 'Desserts');
    COMMIT;
  `);
  console.log('Sample outlet created. Save these demo credentials locally. They are displayed once.');
  for (const account of accounts) console.log(`${account.username.padEnd(12)} ${account.password}`);
} finally {
  db.close();
}
