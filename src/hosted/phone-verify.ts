export interface PhoneVerifier {
  start(phone: string): Promise<string>;
  check(verification: string, code: string): Promise<boolean>;
}

export interface GuestAccountOptions {
  origin: string;
  phoneKey: Buffer;
  verifier: PhoneVerifier;
  trustLoopbackProxy?: boolean;
}

export function twilioVerifier(service: string, key: string, secret: string, send = fetch): PhoneVerifier {
  const base = `https://verify.twilio.com/v2/Services/${service}`;
  const authorization = `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`;
  async function post(path: string, form: Record<string, string>) {
    return send(`${base}/${path}`, {
      method: 'POST', body: new URLSearchParams(form), redirect: 'error', signal: AbortSignal.timeout(6_000),
      headers: { Authorization: authorization }
    });
  }
  return {
    async start(phone) {
      const result = await post('Verifications', { To: phone, Channel: 'sms' });
      const body = await result.json().catch(() => null);
      if (!result.ok || body?.status !== 'pending' || !/^VE[0-9a-f]{32}$/i.test(body.sid ?? '')) {
        throw new Error('SMS verification could not start.');
      }
      return body.sid as string;
    },
    async check(verification, code) {
      const result = await post('VerificationCheck', { VerificationSid: verification, Code: code });
      const body = await result.json().catch(() => null);
      if (result.status === 404) return false;
      if (!result.ok || !body || typeof body.status !== 'string') throw new Error('SMS verification could not be checked.');
      return body.status === 'approved' && body.sid === verification;
    }
  };
}

export function guestAccountOptions(env: NodeJS.ProcessEnv): GuestAccountOptions | undefined {
  const { HOSTED_ORIGIN, HOSTED_PHONE_KEY, TWILIO_VERIFY_SERVICE_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET } = env;
  if (!HOSTED_PHONE_KEY && !TWILIO_VERIFY_SERVICE_SID && !TWILIO_API_KEY_SID && !TWILIO_API_KEY_SECRET) return;
  const origin = URL.parse(HOSTED_ORIGIN ?? '');
  if (!origin || origin.protocol !== 'https:' || origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash
    || !HOSTED_PHONE_KEY || !/^[a-f0-9]{64}$/.test(HOSTED_PHONE_KEY)
    || !TWILIO_VERIFY_SERVICE_SID || !/^VA[0-9a-f]{32}$/i.test(TWILIO_VERIFY_SERVICE_SID)
    || !TWILIO_API_KEY_SID || !/^SK[0-9a-f]{32}$/i.test(TWILIO_API_KEY_SID) || !TWILIO_API_KEY_SECRET?.trim()) {
    throw new Error('Phone sign-in requires an HTTPS origin, phone key, and complete SMS credentials.');
  }
  return {
    origin: origin.origin, phoneKey: Buffer.from(HOSTED_PHONE_KEY, 'hex'),
    verifier: twilioVerifier(TWILIO_VERIFY_SERVICE_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET),
    trustLoopbackProxy: env.HOSTED_TRUST_LOOPBACK_PROXY === 'true'
  };
}
