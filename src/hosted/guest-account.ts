import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { GuestAccountOptions } from './phone-verify.js';
import { outletSlugPattern } from './database.js';
import { claimOffer, readGuestOffers } from './offers.js';

const cookie = '__Host-guest_session';
const cookieFlags = 'Path=/; Secure; HttpOnly; SameSite=Lax';
const sessionSeconds = 30 * 24 * 60 * 60;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const opaqueToken = () => randomBytes(32).toString('hex');
const tokenPattern = '^[a-f0-9]{64}$';
const body = (properties: Record<string, object>) => ({
  type: 'object', additionalProperties: false, required: Object.keys(properties), properties
});

function sessionHash(request: FastifyRequest) {
  const token = request.headers.cookie?.match(/(?:^|;\s*)__Host-guest_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  return token ? sha(token) : '';
}

async function permitStart(pool: Pool, phoneKey: string, ipKey: string) {
  const limits = [
    { key: `cooldown:${phoneKey}`, maximum: 1, seconds: 45 },
    { key: `phone:${phoneKey}`, maximum: 3, seconds: 900 },
    { key: `ip:${ipKey}`, maximum: 12, seconds: 900 },
    { key: 'global', maximum: 120, seconds: 3600 }
  ];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const { key, maximum, seconds } of limits) {
      if (!(await useLimit(client, key, maximum, seconds))) {
        await client.query('ROLLBACK');
        return false;
      }
    }
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function useLimit(db: Pick<Pool, 'query'>, key: string, maximum: number, seconds: number) {
  const result = await db.query(`
    INSERT INTO guest_phone_limits (key, count, expires_at) VALUES ($1, 1, now() + make_interval(secs => $3))
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN guest_phone_limits.expires_at <= now() THEN 1 ELSE guest_phone_limits.count + 1 END,
      expires_at = CASE WHEN guest_phone_limits.expires_at <= now() THEN excluded.expires_at ELSE guest_phone_limits.expires_at END
    WHERE guest_phone_limits.expires_at <= now() OR guest_phone_limits.count < $2
    RETURNING key
  `, [key, maximum, seconds]);
  return Boolean(result.rowCount);
}

export function addGuestAccountRoutes(app: FastifyInstance, pool: Pool, options?: GuestAccountOptions) {
  if (!options) {
    app.get('/api/guest-account', () => ({ available: false, account: null }));
    return;
  }
  const { origin, phoneKey: secret, verifier } = options;
  const host = new URL(origin).host;
  const privateKey = (value: string) => createHmac('sha256', secret).update(value).digest('hex');
  function fail(reply: FastifyReply, status: number, error: string) {
    return reply.code(status).send({ error });
  }
  async function allowWrite(request: FastifyRequest, reply: FastifyReply) {
    if (request.headers.host !== host || request.headers.origin !== origin || request.headers['sec-fetch-site'] === 'cross-site') {
      return fail(reply, 403, 'Open the guest menu and try again.');
    }
    if (request.headers['content-type']?.split(';')[0] !== 'application/json') return fail(reply, 415, 'Use a JSON request.');
  }

  async function accountId(token: string) {
    if (!token) return;
    const { rows } = await pool.query<{ account_id: string }>(
      'SELECT account_id FROM guest_sessions WHERE token_hash = $1 AND expires_at > now()', [token]);
    return rows[0]?.account_id;
  }

  const outletParams = body({ slug: { type: 'string', pattern: outletSlugPattern } });
  app.get<{ Params: { slug: string } }>('/api/guest-offers/:slug', { schema: { params: outletParams } }, (request, reply) => {
    if (request.headers.host !== host) return fail(reply, 403, 'Open the guest menu and try again.');
    return readGuestOffers(pool, request.params.slug, sessionHash(request));
  });

  app.post<{ Params: { slug: string }; Body: { offerId: string } }>('/api/guest-offers/:slug/claim', {
    onRequest: allowWrite, bodyLimit: 512, schema: { params: outletParams,
      body: body({ offerId: { type: 'string', pattern: '^[A-Z0-9][A-Z0-9-]{2,23}$' } }) }
  }, async (request, reply) => {
    const token = sessionHash(request);
    const id = await accountId(token);
    if (!id) return fail(reply, 401, 'Sign in with your phone to claim an offer.');
    if (!(await useLimit(pool, `offer:${id}`, 20, 900))) return fail(reply, 429, 'Too many attempts. Try again later.');
    const status = await claimOffer(pool, request.params.slug, request.body.offerId, token);
    if (status === 401) return fail(reply, status, 'Sign in with your phone to claim an offer.');
    if (status !== 204) return fail(reply, status, 'This offer is no longer available.');
    return reply.code(204).send();
  });

  app.get('/api/guest-account', async (request, reply) => {
    if (request.headers.host !== host) return fail(reply, 403, 'Open the guest menu and try again.');
    const token = sessionHash(request);
    if (!token) return { available: true, account: null };
    const { rows } = await pool.query<{ phoneLast4: string }>(`
      SELECT a.phone_last_four AS "phoneLast4" FROM guest_sessions s JOIN guest_accounts a ON a.id = s.account_id
      WHERE s.token_hash = $1 AND s.expires_at > now()
    `, [token]);
    return { available: true, account: rows[0] ?? null };
  });

  app.post<{ Body: { phone: string } }>('/api/guest-account/start', {
    onRequest: allowWrite, bodyLimit: 512, schema: { body: body({ phone: { type: 'string', pattern: '^[6-9][0-9]{9}$' } }) }
  }, async (request, reply) => {
    const { phone } = request.body;
    const e164 = `+91${phone}`;
    const phoneKey = privateKey(`phone:${e164}`);
    const ipKey = privateKey(`ip:${request.ip}`);
    if (!(await permitStart(pool, phoneKey, ipKey))) return fail(reply, 429, 'Too many code requests. Wait a little and try again.');
    await pool.query(`
      DELETE FROM guest_phone_challenges WHERE expires_at <= now();
      DELETE FROM guest_sessions WHERE expires_at <= now();
      DELETE FROM guest_phone_limits WHERE expires_at <= now();
    `);
    let providerId: string;
    try {
      providerId = await verifier.start(e164);
    } catch {
      return fail(reply, 503, 'A code could not be sent. Try again in a minute.');
    }
    const challenge = opaqueToken();
    const saved = await pool.query(`
      INSERT INTO guest_phone_challenges (id, phone_key, phone_last_four, provider_id, expires_at)
      VALUES ($1, $2, $3, $4, now() + interval '10 minutes')
      ON CONFLICT (provider_id) DO UPDATE SET id = excluded.id, expires_at = excluded.expires_at
      WHERE guest_phone_challenges.phone_key = excluded.phone_key
    `, [sha(challenge), phoneKey, phone.slice(-4), providerId]);
    if (!saved.rowCount) return fail(reply, 503, 'A code could not be sent. Try again in a minute.');
    return { challenge };
  });

  app.post<{ Body: { challenge: string; code: string } }>('/api/guest-account/verify', {
    onRequest: allowWrite, bodyLimit: 512, schema: { body: body({
      challenge: { type: 'string', pattern: tokenPattern }, code: { type: 'string', pattern: '^[0-9]{6}$' }
    }) }
  }, async (request, reply) => {
    const challenge = sha(request.body.challenge);
    const invalid = () => fail(reply, 422, 'That code is incorrect or expired. Try again or request a new code.');
    const { rows } = await pool.query<{ provider_id: string }>(`
      UPDATE guest_phone_challenges SET attempts = attempts + 1
      WHERE id = $1 AND expires_at > now() AND attempts < 5 RETURNING provider_id
    `, [challenge]);
    if (!rows[0]) return invalid();
    let approved: boolean;
    try {
      approved = await verifier.check(rows[0].provider_id, request.body.code);
    } catch {
      return fail(reply, 503, 'The code could not be checked. Try again shortly.');
    }
    if (!approved) return invalid();
    const token = opaqueToken();
    const saved = await pool.query<{ phoneLast4: string }>(`
      WITH verified AS (
        DELETE FROM guest_phone_challenges WHERE id = $1 AND expires_at > now()
        RETURNING phone_key, phone_last_four
      ), account AS (
        INSERT INTO guest_accounts (id, phone_key, phone_last_four)
        SELECT $2, phone_key, phone_last_four FROM verified
        ON CONFLICT (phone_key) DO UPDATE SET phone_last_four = excluded.phone_last_four
        RETURNING id, phone_last_four
      ), prior_session AS (
        DELETE FROM guest_sessions WHERE token_hash = $5 AND EXISTS (SELECT 1 FROM account)
      ), new_session AS (
        INSERT INTO guest_sessions (token_hash, account_id, expires_at)
        SELECT $3, id, now() + make_interval(secs => $4) FROM account
        RETURNING account_id
      )
      SELECT phone_last_four AS "phoneLast4" FROM account JOIN new_session ON new_session.account_id = account.id
    `, [challenge, randomUUID(), sha(token), sessionSeconds, sessionHash(request)]);
    const account = saved.rows[0];
    if (!account) return invalid();
    return reply.header('Set-Cookie', `${cookie}=${token}; ${cookieFlags}; Max-Age=${sessionSeconds}`).send({ account });
  });

  app.post('/api/guest-account/logout', { onRequest: allowWrite, bodyLimit: 512, schema: { body: body({}) } }, async (request, reply) => {
    const token = sessionHash(request);
    if (token) await pool.query('DELETE FROM guest_sessions WHERE token_hash = $1', [token]);
    return reply.header('Set-Cookie', `${cookie}=; ${cookieFlags}; Max-Age=0`).code(204).send();
  });

  app.post<{ Params: { slug: string }; Body: { code: string; rating: number; comment: string } }>('/api/guest-feedback/:slug', {
    onRequest: allowWrite, bodyLimit: 8192, schema: {
      params: body({ slug: { type: 'string', pattern: outletSlugPattern } }),
      body: body({ code: { type: 'string', minLength: 1, maxLength: 32 }, rating: { type: 'integer', minimum: 1, maximum: 5 },
        comment: { type: 'string', maxLength: 1000, pattern: '^[^\\u0000]*$' } })
    }
  }, async (request, reply) => {
    const token = sessionHash(request);
    const id = await accountId(token);
    if (!id) return fail(reply, 401, 'Sign in with your phone to leave feedback.');
    if (!(await useLimit(pool, `feedback:${id}`, 10, 900))) return fail(reply, 429, 'Too many attempts. Try again later.');
    const code = request.body.code.replace(/[-\s]/g, '').toUpperCase();
    const unavailable = () => fail(reply, 422, 'That code is unavailable. Check the code on your receipt slip or try again later.');
    if (!/^[A-F0-9]{16}$/.test(code)) return unavailable();
    const comment = request.body.comment.trim();
    if (/[\uD800-\uDFFF]/u.test(comment)) return fail(reply, 400, 'Enter valid feedback text.');
    const result = await pool.query(`
      UPDATE receipt_feedback SET feedback_id = $3, rating = $4, comment = $5, received_at = now()
      WHERE outlet = $1 AND digest = $2 AND expires_at > now() AND received_at IS NULL
        AND EXISTS (SELECT 1 FROM guest_sessions WHERE token_hash = $6 AND expires_at > now())
    `, [request.params.slug, sha(code), randomUUID(), request.body.rating, comment, token]);
    return result.rowCount ? reply.code(204).send() : unavailable();
  });
}
