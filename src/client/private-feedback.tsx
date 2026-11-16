import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { PrivateFeedback as Feedback } from '../shared/contracts.js';
import { api, message } from './api.js';
import { formatPublicationTime } from './menu-display.js';

export function PrivateFeedback({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<{ configured: boolean; feedback: Feedback[] }>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    void api<{ configured: boolean; feedback: Feedback[] }>('/api/feedback').then(result => {
      if (current) setData(result);
    }).catch((error: unknown) => { if (current) setError(message(error)); }).finally(() => {
      if (current) setLoading(false);
    });
    return () => { current = false; };
  }, [attempt]);
  return <section className="panel menu-catalog" aria-labelledby="private-feedback-title">
    <div className="table-header">
      <h2 id="private-feedback-title">Private feedback</h2>
      <Button variant="ghost" onClick={onClose}>Back to overview</Button>
    </div>
    {loading && <p role="status">{data ? 'Refreshing feedback…' : 'Loading feedback…'}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {(error || data?.configured || (loading && attempt > 0)) && <div className="actions">
      <Button variant="outline" disabled={loading} onClick={() => {
        setError(''); setLoading(true); setAttempt(value => value + 1);
      }}>Refresh feedback</Button>
    </div>}
    {data && (!data.configured ? <p className="note">Connect the hosted menu to receive guest feedback.</p>
      : data.feedback.length ? <>
        <p className="note">Latest {data.feedback.length} {data.feedback.length === 1 ? 'response' : 'responses'}.</p>
        <ul className="menu-management-list">{data.feedback.map(item => <li className="menu-management-row" key={item.id}>
          <div className="table-header"><strong>{item.rating} / 5</strong><time dateTime={item.receivedAt}>{formatPublicationTime(item.receivedAt)} IST</time></div>
          {item.comment && <p>{item.comment}</p>}
        </li>)}</ul>
      </> : <p className="note">No guest feedback yet.</p>)}
  </section>;
}
