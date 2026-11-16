import { useEffect, useState } from 'react';
import type { OfferClaim, PublicOffer } from '../shared/contracts.js';
import { api, RequestError } from './api.js';
import { formatPublicationTime } from './menu-display.js';
import { formatPaise } from './money.js';

type Offers = { offers: PublicOffer[]; claims: OfferClaim[] };

export function GuestOffers({ outlet, signedIn }: { outlet: string; signedIn: boolean }) {
  const [data, setData] = useState<Offers>();
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const path = `/api/guest-offers/${outlet}`;
  const waiting = signedIn && data?.claims.some(claim => claim.status === 'waiting');

  useEffect(() => {
    let current = true;
    void api<Offers>(path).then(result => { if (current) { setData(result); setError(''); } }).catch((error: unknown) => {
      if (current) setError(error instanceof RequestError ? error.message : 'Offers couldn’t load. Try refreshing.');
    });
    return () => { current = false; };
  }, [path, signedIn, attempt]);
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => setAttempt(value => value + 1), 15_000);
    return () => window.clearInterval(timer);
  }, [waiting]);

  async function claim(offerId: string) {
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      await api(`${path}/claim`, 'POST', { offerId });
      setData(await api<Offers>(path));
    } catch (error) {
      setError(error instanceof RequestError ? error.message : 'The claim couldn’t load. Refresh to check its status.');
    } finally { setBusy(false); }
  }

  const claims = signedIn ? data?.claims ?? [] : [];
  const claimed = new Set(claims.map(item => item.offerId));
  if (!data?.offers.length && !claims.length && !error) return null;
  return <section className="guest-account guest-offers" aria-labelledby="guest-offers-title">
    <div className="guest-account-row">
      <h2 id="guest-offers-title">Dine-in offers</h2>
      {(signedIn || error) && <button type="button" disabled={busy} onClick={() => { setError(''); setAttempt(value => value + 1); }}>Refresh offers</button>}
    </div>
    {!signedIn && Boolean(data?.offers.length) && <p>Sign in with your phone to claim an offer.</p>}
    <ul className="guest-offer-list" role="list">
      {data?.offers.map(offer => <li key={offer.id}>
        <strong>{offer.title}</strong>
        <p>{formatPaise(offer.discountPaise)} off{offer.minimumPaise > 0 && ` · Minimum ${formatPaise(offer.minimumPaise)}`}
          {offer.expiresAt !== null && ` · Ends ${formatPublicationTime(offer.expiresAt)} IST`}</p>
        {signedIn && !claimed.has(offer.id) && <button type="button" disabled={busy} onClick={() => void claim(offer.id)}>Claim offer</button>}
      </li>)}
    </ul>
    {claims.length > 0 && <>
      <h3>Your claims</h3>
      <ul className="guest-offer-list" role="list">{claims.map(item => <li key={item.offerId}>
        <strong>{item.title}</strong>
        <p>{item.status === 'ready' ? 'Show this code at the counter' : item.status === 'waiting' ? 'Waiting for the restaurant to sync'
          : item.status === 'redeemed' ? 'Redeemed' : 'Offer unavailable'}</p>
        {item.code && <p className="guest-claim-code">{item.code}</p>}
      </li>)}</ul>
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
