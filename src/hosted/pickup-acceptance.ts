import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { BillingProfile } from '../shared/contracts.js';
import type { PickupDecision, PickupPriceReview } from '../shared/online-ordering.js';
import { billAmounts, billingProfileIssue, normalizeBillingProfile } from '../shared/billing.js';
import { installationPattern, outletWrite, type PublicationLease } from './database.js';
import { availableChannel, cleanText, OnlineOrderingError, requestView, type RequestRow } from './online-ordering.js';

const uuid = new RegExp(installationPattern);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (status: number, message: string) => new OnlineOrderingError(status, message);
function requireConnector(lease: PublicationLease) {
  if (!lease.installation || !uuid.test(lease.installation) || !lease.tokenHash) throw fail(401, 'An authenticated outlet connector is required.');
}

export async function syncPickupPricing(pool: Pool, slug: string, input: BillingProfile, lease: PublicationLease) {
  requireConnector(lease);
  const profile = normalizeBillingProfile(input);
  const issue = billingProfileIssue(profile);
  if (issue || !Number.isSafeInteger(profile.revision) || profile.revision < 1) throw fail(400, issue ?? 'Publish a saved billing profile.');
  return outletWrite(pool, slug, async client => {
    const result = await client.query(`UPDATE online_pickup_channels SET pricing=$3 WHERE outlet=$1 AND installation=$2
      AND (pricing IS NULL OR (pricing->>'revision')::bigint<$4 OR pricing=$3::jsonb) RETURNING revision`,
    [slug, lease.installation, JSON.stringify(profile), profile.revision]);
    if (!result.rowCount) throw fail(409, 'The online billing profile changed or the channel is not configured.');
  }, lease);
}

export async function pickupInbox(pool: Pool, slug: string, lease: PublicationLease, after?: string) {
  requireConnector(lease);
  if (after && !uuid.test(after)) throw fail(400, 'Invalid inbox position.');
  return outletWrite(pool, slug, async client => {
    const heartbeat = await client.query(`UPDATE online_pickup_channels SET heartbeat_at=clock_timestamp()
      WHERE outlet=$1 AND installation=$2 RETURNING revision`, [slug, lease.installation]);
    if (!heartbeat.rowCount) throw fail(409, 'Configure the online pickup channel before polling.');
    const { rows } = await client.query<RequestRow>(`SELECT *,expires_at<=clock_timestamp() AS expired FROM online_pickup_requests
      WHERE outlet=$1 AND ($2::uuid IS NULL OR id>$2) AND
        ((installation=$3 AND status IN ('pending_acceptance','awaiting_payment') AND expires_at>clock_timestamp()) OR status='recovery_required')
      ORDER BY id LIMIT 100`, [slug, after ?? null, lease.installation]);
    return { requests: rows.map(requestView), nextAfter: rows.length === 100 ? rows.at(-1)!.id : null };
  }, lease);
}

async function orderFor(client: PoolClient, slug: string, id: string) {
  const { rows } = await client.query<RequestRow>('SELECT *,expires_at<=clock_timestamp() AS expired FROM online_pickup_requests WHERE outlet=$1 AND id=$2', [slug, id]);
  if (!rows[0]) throw fail(404, 'Order request not found.');
  return rows[0];
}

export async function connectorPickup(pool: Pool, slug: string, id: string, lease: PublicationLease) {
  requireConnector(lease);
  return outletWrite(pool, slug, async client => requestView(await orderFor(client, slug, id)), lease);
}

export async function reconcilePickup(pool: Pool, slug: string, ids: string[], lease: PublicationLease) {
  requireConnector(lease);
  return outletWrite(pool, slug, async client => {
    const { rows } = await client.query<RequestRow>('SELECT *,expires_at<=clock_timestamp() AS expired FROM online_pickup_requests WHERE outlet=$1 AND id=ANY($2::uuid[])', [slug,ids]);
    const found=new Set(rows.map(row=>row.id));
    return {requests:rows.map(requestView),missing:ids.filter(id=>!found.has(id))};
  }, lease);
}

function requirePending(row: RequestRow, revision: number, installation?: string) {
  if (row.installation !== installation || row.status !== 'pending_acceptance' || row.expired || Number(row.revision) !== revision) {
    throw fail(409, 'This request changed or expired. Refresh the inbox before deciding.');
  }
}

async function priceReview(client: PoolClient, slug: string, row: RequestRow): Promise<PickupPriceReview> {
  const channel = await availableChannel(client, slug);
  const { rows } = await client.query<{ pricing: BillingProfile | null }>('SELECT pricing FROM online_pickup_channels WHERE outlet=$1', [slug]);
  const profile = rows[0]?.pricing;
  if (!profile?.enabled || billingProfileIssue(profile)) throw fail(409, 'Publish a valid enabled billing profile before accepting online orders.');
  const lines = row.snapshot.lines.map(line => {
    const current = channel.items.find(item => item.id === line.menuId);
    if (!current?.available) throw fail(409, 'An ordered item is unavailable. Reject the request or resolve availability first.');
    return { ...line, name: current.name, unitPaise: current.pricePaise };
  });
  const subtotalPaise = lines.reduce((sum, line) => sum + line.quantity * line.unitPaise, 0);
  const amounts = billAmounts(subtotalPaise, 0, profile, profile.stateCode);
  if (!Number.isSafeInteger(subtotalPaise) || subtotalPaise < 0 || amounts.totalPaise > 99_999_999_999) throw fail(400, 'This order exceeds the supported amount.');
  const { legalName, address, stateCode, gstin, taxMode, rateBasisPoints, pricesIncludeTax, classification, revision, testMode } = profile;
  const review = { orderId:row.id, currency: 'INR' as const, revision: Number(row.revision), lines, subtotalPaise, discountPaise: 0, feesPaise: 0, amounts,
    seller: { legalName, address, stateCode, gstin, taxMode, rateBasisPoints, pricesIncludeTax, classification, revision, testMode } };
  return { ...review, hash: hash({ orderId: row.id, installation: row.installation, menuVersion: channel.version, profile, review }) };
}

export async function reviewPickup(pool: Pool, slug: string, id: string, revision: number, lease: PublicationLease) {
  requireConnector(lease);
  return outletWrite(pool, slug, async client => {
    const row = await orderFor(client, slug, id);
    requirePending(row, revision, lease.installation);
    return priceReview(client, slug, row);
  }, lease);
}

export async function decidePickup(pool: Pool, slug: string, id: string, input: PickupDecision, lease: PublicationLease) {
  requireConnector(lease);
  if (!uuid.test(input.requestId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
    || !input.actor || !Number.isSafeInteger(input.actor.id) || input.actor.id < 1 || !cleanText(input.actor.name, 100) || !input.actor.name.trim()
    || !cleanText(input.reason, 500, true)) throw fail(400, 'Invalid restaurant decision.');
  if (!['admin','billing'].includes(input.actor.role)) throw fail(403, 'Only owner and billing staff can decide online requests.');
  if (input.decision === 'reject') {
    if (!input.reason.trim() || input.readyAt !== null || input.reviewHash !== null) throw fail(400, 'Give a rejection reason without payment or pickup details.');
  } else if (input.decision !== 'accept' || input.reason !== '' || !Number.isSafeInteger(input.readyAt)
    || typeof input.reviewHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.reviewHash)) throw fail(400, 'Review the total and pickup time before accepting.');
  const payloadHash = hash({ id, requestId: input.requestId, expectedRevision: input.expectedRevision,
    actor: { id: input.actor.id, name: input.actor.name, role: input.actor.role },
    decision: input.decision, reason: input.reason, readyAt: input.readyAt, reviewHash: input.reviewHash });
  return outletWrite(pool, slug, async client => {
    const row = await orderFor(client, slug, id);
    const { rows: retries } = await client.query<{ payload_hash: string; order_id: string }>(
      'SELECT payload_hash,order_id FROM online_pickup_decisions WHERE outlet=$1 AND request_id=$2', [slug, input.requestId]);
    if (retries[0]) {
      if (retries[0].payload_hash !== payloadHash || retries[0].order_id !== id) throw fail(409, 'This decision identity was already used with different details.');
      return requestView(row);
    }
    requirePending(row, input.expectedRevision, lease.installation);
    let decision: NonNullable<RequestRow['decision']>;
    const { rows: times } = await client.query<{ now_ms: string }>('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now_ms');
    const now = Number(times[0]!.now_ms);
    let deadline = row.expires_at.getTime();
    if (input.decision === 'accept') {
      const review = await priceReview(client, slug, row);
      if (review.hash !== input.reviewHash) throw fail(409, 'The total changed. Review it again before accepting.');
      if (input.readyAt! < now + 120_000 || input.readyAt! > now + 86_400_000) throw fail(400, 'Choose pickup between two minutes and 24 hours from now.');
      deadline = Math.min(now + 600_000, input.readyAt! - 60_000);
      decision = { acceptance: { review, readyAt: input.readyAt!, acceptedAt: now, paymentExpiresAt: deadline } };
    } else decision = { rejection: { reason: input.reason.trim(), at: now } };
    const result = await client.query<RequestRow>(`UPDATE online_pickup_requests SET status=$3,revision=revision+1,decision=$4,expires_at=to_timestamp($5/1000.0)
      WHERE outlet=$1 AND id=$2 AND revision=$6 AND status='pending_acceptance' AND expires_at>clock_timestamp()
        AND (NOT $7::boolean OR EXISTS(SELECT 1 FROM online_pickup_channels WHERE outlet=$1 AND enabled
          AND heartbeat_at>clock_timestamp()-interval '45 seconds' AND installation=$8))
      RETURNING *,expires_at<=clock_timestamp() AS expired`,
    [slug, id, input.decision === 'accept' ? 'awaiting_payment' : 'rejected', JSON.stringify(decision), deadline,
      input.expectedRevision, input.decision === 'accept', lease.installation]);
    if (!result.rowCount) throw fail(409, 'The request expired or ordering became unavailable. Refresh the inbox.');
    await client.query(`INSERT INTO online_pickup_decisions(outlet,request_id,order_id,payload_hash,actor,decision)
      VALUES($1,$2,$3,$4,$5,$6)`, [slug, input.requestId, id, payloadHash, JSON.stringify(input.actor), JSON.stringify(decision)]);
    return requestView(result.rows[0]!);
  }, lease);
}
