import { createHash, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import type { PublicOffer } from '../shared/contracts.js';
import { installationPattern, outletSlugPattern, outletWrite, publicationLease } from './database.js';

export interface HostedRecoveryRequest {
  requestId: string;
  sourceHash: string;
  installation: string;
  newInstallation: string;
  menuVersion: number;
  offerVersion: number;
  retireOffers: string[];
}

export interface HostedRecoveryCheckpoint {
  requestId: string;
  sourceHash: string;
  installation: string;
  newInstallation: string;
  menuVersionNext: number;
  offerVersionNext: number;
  retiredOffers: string[];
  createdAt: number;
}

const failure = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const uuid = new RegExp(installationPattern);
const offerCode = /^[A-Z0-9][A-Z0-9-]{2,23}$/;
const fields = ['requestId', 'sourceHash', 'installation', 'newInstallation', 'menuVersion', 'offerVersion', 'retireOffers'];

function canonicalRequest(input: HostedRecoveryRequest): HostedRecoveryRequest {
  if (!input || Object.keys(input).length !== fields.length || fields.some(field => !Object.hasOwn(input, field))
    || ![input.requestId, input.installation, input.newInstallation].every(value => typeof value === 'string' && uuid.test(value))
    || input.installation === input.newInstallation || typeof input.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.sourceHash)
    || ![input.menuVersion, input.offerVersion].every(value => Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER)
    || !Array.isArray(input.retireOffers) || input.retireOffers.length > 2000
    || input.retireOffers.some(code => typeof code !== 'string' || !offerCode.test(code))
    || new Set(input.retireOffers).size !== input.retireOffers.length) {
    throw failure(400, 'Invalid hosted recovery request.');
  }
  return { requestId: input.requestId, sourceHash: input.sourceHash, installation: input.installation,
    newInstallation: input.newInstallation, menuVersion: input.menuVersion, offerVersion: input.offerVersion,
    retireOffers: [...input.retireOffers].sort() };
}

function nextVersion(hosted: string | undefined | null, local: number) {
  const prior = hosted === undefined || hosted === null ? 0 : Number(hosted);
  if (!Number.isSafeInteger(prior) || prior < 0 || Math.max(prior, local) >= Number.MAX_SAFE_INTEGER) {
    throw failure(409, 'Publication versions require assisted recovery.');
  }
  return Math.max(prior, local) + 1;
}

// Storage operation only: deliberately not exposed by an HTTP route until the local
// durable journal and startup gate can safely complete or resume the same recovery.
export async function coordinateHostedRecovery(pool: Pool, slug: string, authorization: string | undefined,
  input: HostedRecoveryRequest): Promise<HostedRecoveryCheckpoint> {
  const request = canonicalRequest(input);
  if (!new RegExp(outletSlugPattern).test(slug)) throw failure(400, 'Invalid outlet.');
  const credential = publicationLease(authorization, undefined).tokenHash;
  if (!credential) throw failure(401, 'Outlet authentication required.');
  const payloadHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');

  // Recovery authenticates under the same lock as publication and guest claims.
  // It cannot use the old publishing lease: a lost-response retry arrives after the binding has changed.
  return outletWrite(pool, slug, async client => {
    const { rows: outlets } = await client.query<{ token_hash: Buffer; publication_installation: string | null; version: string | null }>(
      'SELECT token_hash, publication_installation, version FROM hosted_outlets WHERE slug = $1', [slug]);
    const outlet = outlets[0];
    if (!outlet || !timingSafeEqual(credential, outlet.token_hash)) throw failure(401, 'Outlet authentication required.');
    const { rows: retries } = await client.query<{ payload_hash: string; checkpoint: HostedRecoveryCheckpoint }>(
      'SELECT payload_hash, checkpoint FROM outlet_recoveries WHERE outlet = $1 AND request_id = $2', [slug, request.requestId]);
    const retry = retries[0];
    if (retry) {
      if (retry.payload_hash !== payloadHash || outlet.publication_installation !== retry.checkpoint.newInstallation) {
        throw failure(409, 'The recovery request changed or has been superseded.');
      }
      return retry.checkpoint;
    }
    const { rows: snapshots } = await client.query<{ installation: string; version: string; offers: PublicOffer[] }>(
      'SELECT installation, version, offers FROM outlet_offer_snapshots WHERE outlet = $1', [slug]);
    const snapshot = snapshots[0];
    const installation = outlet.publication_installation ?? snapshot?.installation;
    if (installation !== request.installation || (snapshot && snapshot.installation !== request.installation)) {
      throw failure(409, 'The authoritative outlet installation does not match.');
    }
    const reused = await client.query(`SELECT 1 FROM outlet_recoveries WHERE outlet = $1
      AND (old_installation = $2 OR new_installation = $2) LIMIT 1`, [slug, request.newInstallation]);
    if (reused.rowCount) throw failure(409, 'Recovery requires a new installation identity.');
    const menuVersionNext = nextVersion(outlet.version, request.menuVersion);
    const offerVersionNext = nextVersion(snapshot?.version, request.offerVersion);
    const { rows: claims } = await client.query<{ offer_id: string }>(
      'SELECT DISTINCT offer_id FROM outlet_offer_claims WHERE outlet = $1 AND invalidated_at IS NULL', [slug]);
    const retiredOffers = [...new Set([...request.retireOffers, ...(snapshot?.offers.map(offer => offer.id) ?? []),
      ...claims.map(claim => claim.offer_id)])].sort();
    if (retiredOffers.length > 5000) throw failure(409, 'This offer history requires assisted recovery.');
    const checkpoint: HostedRecoveryCheckpoint = { requestId: request.requestId, sourceHash: request.sourceHash,
      installation: request.installation, newInstallation: request.newInstallation,
      menuVersionNext, offerVersionNext, retiredOffers, createdAt: Date.now() };
    await client.query(`INSERT INTO outlet_retired_offers(outlet, offer_id)
      SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`, [slug, retiredOffers]);
    await client.query('UPDATE outlet_offer_claims SET invalidated_at = clock_timestamp() WHERE outlet = $1 AND invalidated_at IS NULL', [slug]);
    await client.query('DELETE FROM online_pickup_quotes WHERE outlet=$1', [slug]);
    await client.query("UPDATE online_pickup_requests SET status='expired' WHERE outlet=$1 AND status='pending_acceptance'", [slug]);
    await client.query('UPDATE online_pickup_channels SET enabled=false,heartbeat_at=NULL,installation=$2 WHERE outlet=$1', [slug, request.newInstallation]);
    // Retain the last menu and its truthful published timestamp until the restored counter republishes.
    await client.query('UPDATE hosted_outlets SET publication_installation = $2, version = $3 WHERE slug = $1',
      [slug, request.newInstallation, menuVersionNext - 1]);
    await client.query(`INSERT INTO outlet_offer_snapshots(outlet, installation, version, offers) VALUES($1,$2,$3,'[]')
      ON CONFLICT(outlet) DO UPDATE SET installation=excluded.installation, version=excluded.version, offers=excluded.offers`,
    [slug, request.newInstallation, offerVersionNext - 1]);
    await client.query(`INSERT INTO outlet_recoveries(outlet, request_id, payload_hash, old_installation, new_installation, checkpoint)
      VALUES($1,$2,$3,$4,$5,$6)`, [slug, request.requestId, payloadHash, request.installation, request.newInstallation, JSON.stringify(checkpoint)]);
    return checkpoint;
  });
}
