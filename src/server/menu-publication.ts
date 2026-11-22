import type { DatabaseSync } from 'node:sqlite';
import type { GuestMenuItem, MenuPublicationStatus } from '../shared/contracts.js';
import { readMenuPhoto } from './menu-photo.js';
import { readMenu } from './store.js';
import { publishFeedbackCodes } from './receipt-feedback.js';
import { syncOffers } from './offer-sync.js';
import { publicationHeaders } from './publication-headers.js';

type Publication = { version: number; destination: string | null; publishedVersion: number | null; publishedAt: number | null };
type Target = { endpoint: string; guestUrl: string; token: string };

export function readGuestMenu(db: DatabaseSync): GuestMenuItem[] {
  return readMenu(db).map(({ id, name, category, pricePaise, description, available, availableAfter, photoKey }) =>
    ({ id, name, category, pricePaise, description, available, availableAfter, photoKey }));
}

export function publicationTarget(env: NodeJS.ProcessEnv): Target | undefined {
  const origin = env.RESTAURANT_PUBLISH_ORIGIN;
  const outlet = env.RESTAURANT_PUBLISH_OUTLET;
  const token = env.RESTAURANT_PUBLISH_TOKEN;
  if (!origin && !outlet && !token) return;
  const url = URL.parse(origin ?? '');
  if (!url || url.protocol !== 'https:' || url.pathname !== '/' || url.username || url.password || url.search || url.hash
    || !outlet || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(outlet) || !token || !/^[a-f0-9]{64}$/.test(token)) {
    throw new Error('Menu publication requires an HTTPS origin, outlet slug, and installation token.');
  }
  return { endpoint: `${url.origin}/api/publish/${outlet}`, guestUrl: `${url.origin}/r/${outlet}`, token };
}

function readPublication(db: DatabaseSync): Publication {
  return db.prepare(`
    SELECT version, destination, published_version AS publishedVersion, published_at AS publishedAt
    FROM menu_publication WHERE id = 1
  `).get() as Publication;
}

export function publicationStatus(db: DatabaseSync, target?: Target): MenuPublicationStatus {
  const current = readPublication(db);
  const publishedAt = target && current.destination === target.endpoint ? current.publishedAt : null;
  return {
    configured: Boolean(target),
    pending: Boolean(target && (publishedAt === null || current.publishedVersion !== current.version)),
    publishedAt
  };
}

function pendingSnapshot(db: DatabaseSync, target: Target) {
  db.exec('BEGIN');
  try {
    const current = readPublication(db);
    const pending = current.destination !== target.endpoint || current.version !== current.publishedVersion;
    const snapshot = pending ? { version: current.version, items: readGuestMenu(db) } : undefined;
    db.exec('COMMIT');
    return snapshot;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export async function publishMenu(db: DatabaseSync, target: Target, signal: AbortSignal, send = fetch) {
  const snapshot = pendingSnapshot(db, target);
  if (!snapshot) return;

  async function request(path: string, method: string, contentType?: string, body?: BodyInit) {
    const headers = new Headers(publicationHeaders(db, target.token));
    if (contentType) headers.set('Content-Type', contentType);
    const response = await send(target.endpoint + path, {
      method, headers, body, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    });
    await response.body?.cancel();
    return response.status;
  }

  for (const item of snapshot.items) {
    if (!item.photoKey) continue;
    const path = `/photos/${item.photoKey}`;
    const status = await request(path, 'HEAD');
    if (status === 204) continue;
    if (status !== 404) throw new Error('The hosted service could not check a photo.');
    const image = readMenuPhoto(db, item.id, item.photoKey);
    if (!image) throw new Error('A photo changed during publication.');
    if (await request(path, 'PUT', 'image/webp', new Uint8Array(image)) !== 204) {
      throw new Error('The hosted service could not accept a photo.');
    }
  }
  if (await request('/menu', 'PUT', 'application/json', JSON.stringify(snapshot)) !== 204) {
    throw new Error('The hosted service did not acknowledge the menu.');
  }
  db.prepare(`
    UPDATE menu_publication SET destination = ?, published_version = ?, published_at = ?
    WHERE id = 1 AND (destination IS NOT ? OR published_version < ?)
  `).run(target.endpoint, snapshot.version, Date.now(), target.endpoint, snapshot.version);
}

function startPublisher(task: (signal: AbortSignal) => Promise<void>) {
  const controller = new AbortController();
  let active: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = 15_000;
  function run() {
    active = task(controller.signal)
      .then(() => { delay = 15_000; })
      .catch(() => { delay = Math.min(delay * 2, 120_000); })
      .finally(() => {
        if (!controller.signal.aborted) timer = setTimeout(run, delay).unref();
      });
  }
  run();
  return async () => {
    controller.abort();
    clearTimeout(timer);
    await active;
  };
}

export function startMenuPublisher(db: DatabaseSync, target: Target) {
  const guarded=(task:(signal:AbortSignal)=>Promise<void>)=>(signal:AbortSignal)=>
    db.prepare('SELECT 1 FROM recovery_state WHERE id=1 AND reviewed_at IS NULL').get()?Promise.resolve():task(signal);
  const stopMenu = startPublisher(guarded(signal => publishMenu(db, target, signal)));
  const stopFeedback = startPublisher(guarded(signal => publishFeedbackCodes(db, target, signal)));
  const stopOffers = startPublisher(guarded(signal => syncOffers(db, target, signal)));
  return () => Promise.all([stopMenu(), stopFeedback(), stopOffers()]);
}
