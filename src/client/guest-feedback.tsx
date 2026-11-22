import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, RequestError } from './api.js';

export function GuestFeedback({ outlet }: { outlet: string }) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const codeInput = useRef<HTMLInputElement>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  const confirmation = useRef<HTMLParagraphElement>(null);
  const closeFocus = useRef<'confirmation' | 'button' | null>(null);

  useEffect(() => {
    if (open) codeInput.current?.focus();
    else if (closeFocus.current) {
      // Focus after React mounts the destination; an animation frame can run before that commit.
      (closeFocus.current === 'confirmation' ? confirmation.current : openButton.current)?.focus();
      closeFocus.current = null;
    }
  }, [open, sent]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const fields = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      await api(`/api/guest-feedback/${outlet}`, 'POST', {
        code: String(fields.get('feedbackCode')), rating: Number(fields.get('rating')), comment: String(fields.get('comment') ?? '')
      });
      closeFocus.current = 'confirmation';
      setSent(true);
      setOpen(false);
    } catch (error) {
      setError(error instanceof RequestError ? error.message : 'Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) return <div className="guest-account-row">
    {sent && <p ref={confirmation} tabIndex={-1} role="status">Thank you. Your feedback was sent privately.</p>}
    <button ref={openButton} type="button" onClick={() => setOpen(true)}>{sent ? 'Leave feedback for another receipt' : 'Leave private feedback'}</button>
  </div>;

  return <form className="guest-account-form" onSubmit={submit} aria-label="Private feedback">
    <h2>Private feedback</h2>
    <p>Use the code from your receipt slip. Your rating and comment go to the restaurant owner.</p>
    <label htmlFor="guest-feedback-code">Feedback code</label>
    <input id="guest-feedback-code" ref={codeInput} name="feedbackCode" autoComplete="off" spellCheck={false} maxLength={32} required disabled={busy} />
    <label htmlFor="guest-feedback-rating">Rating</label>
    <select id="guest-feedback-rating" name="rating" defaultValue="" required disabled={busy}>
      <option value="" disabled>Choose a rating</option>
      <option value="5">5 · Excellent</option><option value="4">4 · Good</option>
      <option value="3">3 · Okay</option><option value="2">2 · Disappointing</option><option value="1">1 · Poor</option>
    </select>
    <label htmlFor="guest-feedback-comment">Comment (optional)</label>
    <textarea id="guest-feedback-comment" name="comment" rows={3} maxLength={1000} disabled={busy} />
    {error && <p role="alert">{error}</p>}
    <div className="guest-account-row">
      <button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send feedback'}</button>
      <button type="button" disabled={busy} onClick={() => {
        closeFocus.current = 'button';
        setOpen(false);
        setError('');
      }}>Cancel feedback</button>
    </div>
  </form>;
}
