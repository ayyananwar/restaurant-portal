import { hostedPool, prepareHostedStore, provisionOutlet } from './database.js';

const connectionString = process.env.HOSTED_DATABASE_URL;
const token = process.env.HOSTED_INSTALLATION_TOKEN;
const [slug, name, theme = 'classic'] = process.argv.slice(2);
const schemaOnly = slug === '--schema-only' && process.argv.length === 3;
if (!connectionString || (!schemaOnly && (!token || !slug || !name || (theme !== 'classic' && theme !== 'photo-led')))) {
  throw new Error('Set HOSTED_DATABASE_URL. Use --schema-only or supply an installation token, outlet slug, display name, and theme.');
}
const pool = hostedPool(connectionString);
try {
  await prepareHostedStore(pool);
  if (schemaOnly) console.log('Hosted database schema is ready.');
  else if (slug && name && token && (theme === 'classic' || theme === 'photo-led')) {
    await provisionOutlet(pool, slug, name, theme, token);
    console.log(`Outlet ${slug} is ready to receive menu updates.`);
  }
} catch {
  console.error('Outlet setup failed. Check the database, outlet details, and whether the slug is already in use.');
  process.exitCode = 1;
} finally {
  await pool.end();
}
