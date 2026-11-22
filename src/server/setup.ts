import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { roles, serviceModes, type ServiceMode } from '../shared/contracts.js';
import { createStaff, openStore } from './store.js';

const args = process.argv.slice(2);
const demo = args.includes('--demo');
const mode = (args.find(arg => arg.startsWith('--mode='))?.slice(7) ?? 'table') as ServiceMode;
if ((!demo && !args.includes('--outlet')) || (demo && args.includes('--outlet')) ||
  !serviceModes.includes(mode) || args.some(arg => arg !== '--demo' && arg !== '--outlet' && !arg.startsWith('--mode='))) {
  throw new Error('Use --demo or --outlet with an optional --mode=table, --mode=counter, or --mode=both.');
}
const path = resolve(process.env.RESTAURANT_DB ?? 'data/outlet.sqlite');
mkdirSync(dirname(path), { recursive: true });
const db = openStore(path);
try {
  db.exec('BEGIN IMMEDIATE');
  if (db.prepare('SELECT id FROM staff LIMIT 1').get()) throw new Error('This outlet already has staff accounts.');
  const usernames = mode === 'counter' ? roles.filter(role => role !== 'waiter') : [...roles, 'waiter-two' as const];
  const accounts = usernames.map(username => {
    const password = randomBytes(18).toString('base64url');
    createStaff(db, username, username === 'waiter-two' ? 'Second waiter' : demo ? `Sample ${username}` : username,
      username === 'waiter-two' ? 'waiter' : username, password);
    return { username, password };
  });
  db.prepare('UPDATE outlet_settings SET mode=? WHERE id=1').run(mode);
  if (demo && mode !== 'counter') db.exec("INSERT INTO dining_tables (label) VALUES ('Table 1'), ('Table 4'), ('Table 7'), ('Table 9');");
  if (demo) db.exec(`
    INSERT INTO menu (name, price_paise, category) VALUES
      ('Masala chai', 6000, 'Drinks'), ('Paneer tikka', 24000, 'Starters'),
      ('Veg biryani', 22000, 'Mains'), ('Gulab jamun', 9000, 'Desserts');
  `);
  db.exec('COMMIT;');
  console.log(`${demo ? 'Sample' : 'New'} outlet created in ${mode} mode. Save these generated credentials privately. They are displayed once.`);
  for (const account of accounts) console.log(`${account.username.padEnd(12)} ${account.password}`);
} finally {
  db.close();
}
