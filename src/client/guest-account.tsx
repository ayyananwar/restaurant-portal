import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, RequestError } from './api.js';
import { GuestFeedback } from './guest-feedback.js';
import { GuestOffers } from './guest-offers.js';

type Account = { id: string; phoneLast4: string };
type AccountStatus = { available: boolean; account: Account | null };

export function GuestAccount({ outlet, onAccountChange }: { outlet: string; onAccountChange?: (id: string | null) => void }) {
  const [status, setStatus] = useState<AccountStatus>();
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [challenge, setChallenge] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let current = true;
    void api<AccountStatus>('/api/guest-account').then(result => { if (current) setStatus(result); }).catch(() => {});
    return () => { current = false; };
  }, []);
  useEffect(() => { if (open) input.current?.focus(); }, [open, challenge]);
  useEffect(() => { onAccountChange?.(status?.account?.id ?? null); }, [status?.account?.id, onAccountChange]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try { await action(); }
    catch (error) { setError(error instanceof RequestError ? error.message : 'Check your connection and try again.'); }
    finally { setBusy(false); }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get('code') ?? '');
    void run(async () => {
      if (!challenge) {
        const result = await api<{ challenge: string }>('/api/guest-account/start', 'POST', { phone });
        setChallenge(result.challenge);
      } else {
        const result = await api<{ account: Account }>('/api/guest-account/verify', 'POST', { challenge, code });
        setStatus({ available: true, account: result.account });
        setOpen(false);
        setPhone('');
        setChallenge('');
      }
    });
  }

  if (!status?.available) return null;
  return <><section className="guest-account" aria-label="Guest account">
    {status.account ? <><div className="guest-account-row">
      <p role="status">Signed in · phone ending {status.account.phoneLast4}</p>
      <button type="button" disabled={busy} onClick={() => void run(async () => {
        await api('/api/guest-account/logout', 'POST', {});
        setStatus({ available: true, account: null });
      })}>Sign out</button>
    </div><GuestFeedback outlet={outlet} /></> : !open ? <button type="button" onClick={() => setOpen(true)}>Sign in with phone</button> : <>
      <div className="guest-account-row">
        <h2>{challenge ? 'Enter your code' : 'Sign in with phone'}</h2>
        <button type="button" disabled={busy} onClick={() => { setOpen(false); setChallenge(''); setPhone(''); setError(''); }}>Close</button>
      </div>
      <form onSubmit={submit} className="guest-account-form">
        {challenge ? <>
          <p>We sent a six-digit code to the phone ending {phone.slice(-4)}.</p>
          <label htmlFor="guest-otp">Verification code</label>
          <input id="guest-otp" key="otp" ref={input} name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required disabled={busy} />
        </> : <>
          <p>We’ll send a sign-in code by SMS.</p>
          <label htmlFor="guest-phone">Indian mobile number (+91)</label>
          <input id="guest-phone" key="phone" ref={input} type="tel" autoComplete="tel-national" inputMode="numeric" pattern="[6-9][0-9]{9}"
            maxLength={10} value={phone} onChange={event => setPhone(event.target.value)} required disabled={busy} />
        </>}
        <div className="guest-account-row">
          <button type="submit" disabled={busy}>{busy ? 'Please wait…' : challenge ? 'Verify and sign in' : 'Send code'}</button>
          {challenge && <button type="button" disabled={busy} onClick={() => { setChallenge(''); setError(''); }}>Change number or request a new code</button>}
        </div>
      </form>
    </>}
    {error && <p role="alert">{error}</p>}
  </section><GuestOffers key={status.account ? 'signed-in' : 'signed-out'} outlet={outlet} signedIn={Boolean(status.account)} /></>;
}
