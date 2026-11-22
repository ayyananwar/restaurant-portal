import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import sharp from 'sharp';
import { maxMenuPhotoBytes, type GuestMenuItem } from '../shared/contracts.js';
import { acceptMenu, authenticateOutlet, hasPhoto, outletFeedback, outletSlugPattern, photoKeyPattern, publicationLease, publicMenu, publicPhoto, stageFeedbackCodes, stagePhoto } from './database.js';
import { addGuestAccountRoutes } from './guest-account.js';
import type { GuestAccountOptions } from './phone-verify.js';
import { syncOutletOffers, type OfferSync } from './offers.js';
import { OnlineOrderingError, syncPickupChannel } from './online-ordering.js';
import { connectorPickup, decidePickup, pickupInbox, reconcilePickup, reviewPickup, syncPickupPricing } from './pickup-acceptance.js';
import { billingProfileSchema } from '../shared/billing.js';
import type { BillingProfile } from '../shared/contracts.js';
import type { PickupDecision } from '../shared/online-ordering.js';

const clientDir = new URL('../client/', import.meta.url);
const guestFile = 'guest-menu.html';
const positiveInteger = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const slug = { type: 'string', pattern: outletSlugPattern };
const key = { type: 'string', pattern: photoKeyPattern };
const nullable = (value: object) => ({ anyOf: [value, { type: 'null' }] });
const text = (minLength: number, maxLength: number) => ({ type: 'string', minLength, maxLength, pattern: '^[^\\u0000]*$' });
const dishFields = {
  id: positiveInteger, name: text(1, 100), category: text(1, 60), description: text(0, 600),
  pricePaise: { type: 'integer', minimum: 0, maximum: 99_999_999_999 }, available: { type: 'boolean' },
  availableAfter: nullable({ ...positiveInteger, maximum: 8_640_000_000_000_000 }), photoKey: nullable(key)
};
const params = (properties: Record<string, object>) => ({ type: 'object', properties, required: Object.keys(properties) });
const outletParams = params({ slug });
const photoParams = params({ slug, key });
type Outlet = { slug: string };
type Photo = Outlet & { key: string };
type Snapshot = { version: number; items: GuestMenuItem[] };

async function guestAssets() {
  type Entry = { file: string; imports?: string[]; css?: string[]; assets?: string[] };
  const manifest: Record<string, Entry> = JSON.parse(await readFile(new URL('.vite/manifest.json', clientDir), 'utf8'));
  const visited = new Set<string>();
  const assets = new Map<string, string>();
  function visit(id: string) {
    if (visited.has(id)) return;
    visited.add(id);
    const entry = manifest[id];
    if (!entry) throw new Error('Guest build assets are missing. Run the production build first.');
    for (const file of [entry.file, ...entry.css ?? [], ...entry.assets ?? []]) {
      if (/^assets\/[a-zA-Z0-9_-]+\.js$/.test(file)) assets.set(file, 'text/javascript; charset=utf-8');
      if (/^assets\/[a-zA-Z0-9_-]+\.css$/.test(file)) assets.set(file, 'text/css; charset=utf-8');
      if (/^assets\/[a-zA-Z0-9_-]+\.webp$/.test(file)) assets.set(file, 'image/webp');
    }
    for (const dependency of entry.imports ?? []) visit(dependency);
  }
  visit(guestFile);
  return assets;
}

export async function buildHostedApp(pool: Pool, tls?: { key: Buffer; cert: Buffer }, accounts?: GuestAccountOptions) {
  const [html, assets] = await Promise.all([readFile(new URL(guestFile, clientDir)), guestAssets()]);
  const app = Fastify({
    ...(tls ? { https: tls } : {}), requestTimeout: 15_000, bodyLimit: 6 * 1024 * 1024,
    ...(accounts?.trustLoopbackProxy ? { trustProxy: ['127.0.0.1', '::1'] } : {}),
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, unicodeRegExp: true } }
  });
  app.addContentTypeParser('image/webp', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('Content-Security-Policy', "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; object-src 'none'");
  });
  app.setErrorHandler((error, _request, reply) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500 && !(error instanceof OnlineOrderingError)) console.error('Hosted menu request failed.');
    return reply.code(status).send({ error: error instanceof OnlineOrderingError ? error.message
      : status >= 500 ? 'The menu service is temporarily unavailable.' : 'The request could not be accepted.' });
  });
  addGuestAccountRoutes(app, pool, accounts);

  const publish = (contentType?: string) => async (request: FastifyRequest<{ Params: Outlet }>, reply: FastifyReply) => {
    if (!(await authenticateOutlet(pool, request.params.slug, request.headers.authorization, request.headers['x-outlet-installation']))) {
      return reply.code(401).send();
    }
    if (contentType && request.headers['content-type']?.split(';')[0] !== contentType) return reply.code(415).send();
  };

  const uuid = { type: 'string', pattern: '^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$' };
  const requestParams = params({ slug, id: uuid });
  const connectorLease = (request: FastifyRequest) => publicationLease(request.headers.authorization, request.headers['x-outlet-installation']);
  app.put<{ Params: Outlet; Body: { revision: number; enabled: boolean } }>('/api/publish/:slug/pickup-channel', {
    onRequest: publish('application/json'), bodyLimit: 512, schema: { params: outletParams, body: {
      type:'object',additionalProperties:false,required:['revision','enabled'],properties:{revision:positiveInteger,enabled:{type:'boolean'}}
    } }
  }, async (request, reply) => {
    if (!accounts) return reply.code(503).send();
    await syncPickupChannel(pool, request.params.slug, request.body.revision, request.body.enabled, connectorLease(request));
    return reply.code(204).send();
  });
  app.put<{ Params: Outlet; Body: BillingProfile }>('/api/publish/:slug/pickup-pricing', {
    onRequest: publish('application/json'), bodyLimit: 8192, schema: { params: outletParams, body: billingProfileSchema }
  }, async (request, reply) => {
    if (!accounts) return reply.code(503).send();
    await syncPickupPricing(pool, request.params.slug, request.body, connectorLease(request));
    return reply.code(204).send();
  });
  app.get<{ Params: Outlet; Querystring: { after?: string } }>('/api/publish/:slug/pickup-requests', {
    onRequest: publish(), schema: { params: outletParams, querystring: { type: 'object', additionalProperties: false, properties: { after: uuid } } }
  }, async (request, reply) => {
    if (!accounts) return reply.code(503).send();
    return pickupInbox(pool, request.params.slug, connectorLease(request), request.query.after);
  });
  app.post<{Params:Outlet;Body:{ids:string[]}}>('/api/publish/:slug/pickup-requests/reconcile',{
    onRequest:publish('application/json'),bodyLimit:8192,schema:{params:outletParams,body:{type:'object',additionalProperties:false,
      required:['ids'],properties:{ids:{type:'array',minItems:1,maxItems:100,uniqueItems:true,items:uuid}}}}
  },async(request,reply)=>{
    if(!accounts)return reply.code(503).send();
    return reconcilePickup(pool,request.params.slug,request.body.ids,connectorLease(request));
  });
  app.post<{ Params: Outlet & { id: string }; Body: { revision: number } }>('/api/publish/:slug/pickup-requests/:id/review', {
    onRequest: publish('application/json'), bodyLimit: 512, schema: { params: requestParams, body: {
      type: 'object', additionalProperties: false, required: ['revision'], properties: { revision: positiveInteger }
    } }
  }, async (request, reply) => {
    if (!accounts) return reply.code(503).send();
    return reviewPickup(pool, request.params.slug, request.params.id, request.body.revision, connectorLease(request));
  });
  app.get<{ Params: Outlet & { id: string } }>('/api/publish/:slug/pickup-requests/:id', {
    onRequest: publish(), schema: { params: requestParams }
  }, async (request, reply) => {
    if (!accounts) return reply.code(503).send();
    return connectorPickup(pool, request.params.slug, request.params.id, connectorLease(request));
  });
  app.post<{ Params: Outlet & { id: string }; Body: PickupDecision }>('/api/publish/:slug/pickup-requests/:id/decision', {
    onRequest: publish('application/json'), bodyLimit: 8192, schema: { params: requestParams, body: {
      type: 'object', additionalProperties: false,
      required: ['requestId','expectedRevision','actor','decision','reason','readyAt','reviewHash'], properties: {
        requestId: uuid, expectedRevision: positiveInteger, decision: { enum: ['accept','reject'] }, reason: text(0,500),
        readyAt: nullable({ ...positiveInteger, maximum: 8_640_000_000_000_000 }), reviewHash: nullable(key),
        actor: { type: 'object', additionalProperties: false, required: ['id','name','role'], properties: {
          id: positiveInteger, name: text(1,100), role: { enum: ['admin','billing','waiter','kitchen'] }
        } }
      }
    } }
  }, async (request, reply) => {
    if (!accounts) return reply.code(503).send();
    return decidePickup(pool, request.params.slug, request.params.id, request.body, connectorLease(request));
  });

  const offerFields = {
    id: { type: 'string', pattern: '^[A-Z0-9][A-Z0-9-]{2,23}$' }, title: text(1, 100),
    discountPaise: { type: 'integer', minimum: 1, maximum: 99_999_999_999 },
    minimumPaise: { type: 'integer', minimum: 0, maximum: 99_999_999_999 },
    expiresAt: nullable({ ...positiveInteger, maximum: 8_640_000_000_000_000 }), enabled: { type: 'boolean' }
  };
  const claimCodes = { type: 'array', maxItems: 100, items: { type: 'string', pattern: '^CL-[A-F0-9]{16}$' } };
  app.post<{ Params: Outlet; Body: OfferSync }>('/api/publish/:slug/offer-sync', {
    onRequest: publish('application/json'), bodyLimit: 512 * 1024,
    schema: { params: outletParams, body: {
      type: 'object', additionalProperties: false, required: ['installation', 'version', 'offers', 'ready', 'redeemed'], properties: {
        installation: { type: 'string', pattern: '^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$' },
        version: positiveInteger, ready: claimCodes, redeemed: claimCodes,
        offers: { type: 'array', maxItems: 1000, items: {
          type: 'object', additionalProperties: false, required: Object.keys(offerFields), properties: offerFields
        } }
      }
    } }
  }, async ({ params, body, headers }, reply) => {
    if (!accounts) return reply.code(503).send();
    if (new Set(body.offers.map(offer => offer.id)).size !== body.offers.length || body.offers.some(offer =>
      !offer.title.trim() || /[\uD800-\uDFFF]/u.test(offer.title))) return reply.code(400).send();
    const result = await syncOutletOffers(pool, params.slug, body, publicationLease(headers.authorization, headers['x-outlet-installation']));
    return result ? reply.send(result) : reply.code(409).send();
  });

  app.put<{ Params: Outlet; Body: { codes: { digest: string; expiresAt: number }[] } }>('/api/publish/:slug/feedback-codes', {
    onRequest: publish('application/json'), bodyLimit: 24_576, schema: { params: outletParams, body: {
      type: 'object', additionalProperties: false, required: ['codes'], properties: {
        codes: { type: 'array', minItems: 1, maxItems: 100, items: {
          type: 'object', additionalProperties: false, required: ['digest', 'expiresAt'],
          properties: { digest: key, expiresAt: { ...positiveInteger, maximum: 8_640_000_000_000_000 } }
        } }
      }
    } }
  }, async ({ params, body, headers }, reply) => {
    if (!accounts) return reply.code(503).send();
    if (body.codes.some(code => code.expiresAt > Date.now() + 15 * 86_400_000)) return reply.code(400).send();
    await stageFeedbackCodes(pool, params.slug, body.codes, publicationLease(headers.authorization, headers['x-outlet-installation']));
    return reply.code(204).send();
  });

  app.get<{ Params: Outlet }>('/api/publish/:slug/feedback', { onRequest: publish(), schema: { params: outletParams } },
    async ({ params }) => ({ feedback: await outletFeedback(pool, params.slug) }));

  app.head<{ Params: Photo }>('/api/publish/:slug/photos/:key', {
    onRequest: publish(), schema: { params: photoParams }
  }, async ({ params }, reply) => reply.code(await hasPhoto(pool, params.slug, params.key) ? 204 : 404).send());

  let decoding = 0;
  app.put<{ Params: Photo; Body: Buffer }>('/api/publish/:slug/photos/:key', {
    onRequest: publish('image/webp'), bodyLimit: maxMenuPhotoBytes, schema: { params: photoParams }
  }, async ({ params, body, headers }, reply) => {
    if (!Buffer.isBuffer(body) || createHash('sha256').update(body).digest('hex') !== params.key) return reply.code(400).send();
    if (await hasPhoto(pool, params.slug, params.key)) return reply.code(204).send();
    if (decoding >= 2) return reply.code(503).send();
    decoding++;
    try {
      const image = sharp(body, { limitInputPixels: 1200 * 900, failOn: 'error' });
      const metadata = await image.metadata();
      if (metadata.format !== 'webp' || metadata.width > 1200 || metadata.height > 900
        || (metadata.pages ?? 1) > 1 || metadata.exif || metadata.xmp || metadata.icc) return reply.code(400).send();
      await image.stats();
    } catch {
      return reply.code(400).send();
    } finally {
      decoding--;
    }
    return reply.code(await stagePhoto(pool, params.slug, params.key, body, publicationLease(headers.authorization, headers['x-outlet-installation'])) ? 204 : 413).send();
  });

  app.put<{ Params: Outlet; Body: Snapshot }>('/api/publish/:slug/menu', {
    onRequest: publish('application/json'), schema: {
      params: outletParams,
      body: { type: 'object', additionalProperties: false, required: ['version', 'items'], properties: {
        version: positiveInteger,
        items: { type: 'array', maxItems: 2000, items: {
          type: 'object', additionalProperties: false, required: Object.keys(dishFields), properties: dishFields
        } }
      } }
    }
  }, async ({ params, body, headers }, reply) => {
    if (new Set(body.items.map(item => item.id)).size !== body.items.length || body.items.some(item =>
      !item.name.trim() || !item.category.trim() || (item.available && item.availableAfter !== null)
      || [item.name, item.category, item.description].some(value => /[\uD800-\uDFFF]/u.test(value)))) return reply.code(400).send();
    return reply.code(await acceptMenu(pool, params.slug, body.version, body.items, publicationLease(headers.authorization, headers['x-outlet-installation']))).send();
  });

  app.get<{ Params: Outlet }>('/api/public-menu/:slug', { schema: { params: outletParams } }, async ({ params }, reply) => {
    const menu = await publicMenu(pool, params.slug);
    return menu ? reply.send(menu) : reply.code(404).send();
  });

  app.get<{ Params: Photo & { id: string } }>('/media/menu/:slug/:id/:key', {
    schema: { params: params({ slug, key, id: { type: 'string', pattern: '^[1-9][0-9]{0,14}$' } }) }
  }, async ({ params }, reply) => {
    const image = await publicPhoto(pool, params.slug, Number(params.id), params.key);
    return image ? reply.type('image/webp').send(image) : reply.code(404).send();
  });

  app.get('/r/:slug', { schema: { params: outletParams } }, (_request, reply) => reply.type('text/html; charset=utf-8').send(html));
  app.get<{ Params: { file: string } }>('/assets/:file', async ({ params }, reply) => {
    const file = `assets/${params.file}`;
    const type = assets.get(file);
    if (!type) return reply.code(404).send();
    return reply.header('Cache-Control', 'public, max-age=31536000, immutable').type(type).send(await readFile(new URL(file, clientDir)));
  });
  return app;
}
