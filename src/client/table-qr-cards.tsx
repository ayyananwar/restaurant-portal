import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { Table, TableQrDestination } from '../shared/contracts.js';

export function TableQrCards({ tables, destination, connected, onClose }: {
  tables: Pick<Table, 'id' | 'label'>[];
  destination?: TableQrDestination;
  connected: boolean;
  onClose: () => void;
}) {
  const sheet = useRef<HTMLUListElement>(null);
  const [selected, setSelected] = useState('');
  const [printing, setPrinting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const tableSelection = tables.some(table => String(table.id) === selected) ? selected : '';
  const visible = tables.filter(table => !tableSelection || String(table.id) === tableSelection);

  async function printCards() {
    const currentSheet = sheet.current;
    const images = currentSheet?.querySelectorAll('img');
    if (!connected || !images?.length) return;
    setPrinting(true);
    setFailed(false);
    try {
      await Promise.all(Array.from(images, image => image.decode()));
      if (sheet.current === currentSheet) window.print();
    } catch {
      setFailed(true);
    } finally {
      setPrinting(false);
    }
  }

  return <section className="panel table-qr-sheet" aria-labelledby="table-qr-title">
    <div className="table-qr-controls">
      <div className="table-header">
        <h2 id="table-qr-title">Table QR cards</h2>
        <Button variant="ghost" disabled={printing} onClick={onClose}>Back to overview</Button>
      </div>
      {!destination ? <p className="muted">Publish the guest menu to an HTTPS address to create table cards.</p>
        : !tables.length ? <p className="muted">There are no tables configured for this outlet.</p> : <>
          <p className="muted">Guests can scan a card to open the menu and ask their waiter to order.</p>
          {destination.preview && <p className="note">Local preview. These codes open only on this computer.</p>}
          <a className="menu-preview-link" href={destination.url}>Open guest menu</a>
          <div className="actions">
            <label className="table-qr-select">Tables to print
              <select value={tableSelection} disabled={printing} onChange={event => { setSelected(event.target.value); setFailed(false); }}>
                <option value="">All tables</option>
                {tables.map(table => <option key={table.id} value={table.id}>{table.label}</option>)}
              </select>
            </label>
            <Button disabled={!connected || printing || !visible.length} onClick={() => void printCards()}>
              {printing ? 'Preparing cards…' : 'Print cards'}
            </Button>
          </div>
          {failed && <div>
            <p className="error" role="alert">Some QR codes could not load. Reconnect to the outlet and reload the codes.</p>
            <Button variant="outline" disabled={!connected} onClick={() => { setAttempt(value => value + 1); setFailed(false); }}>Reload codes</Button>
          </div>}
        </>}
    </div>
    {destination && visible.length > 0 && <ul key={destination.url} className="table-qr-grid" ref={sheet} role="list">
      {visible.map(table => <li key={table.id} className="table-qr-card">
        <h3>{table.label}</h3>
        <img src={`/api/tables/${table.id}/qr${attempt ? `?retry=${attempt}` : ''}`} width="168" height="168" alt={`Menu QR code for ${table.label}`} />
        <p>Scan for the menu</p>
        {destination.preview && <p className="table-qr-preview">Local preview only</p>}
      </li>)}
    </ul>}
  </section>;
}
