import { useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import type { BillSnapshot } from '../shared/contracts.js';
import { stateNames } from '../shared/billing.js';
import { formatPaise } from './money.js';
import { formatPublicationTime } from './menu-display.js';

export const billNames = { receipt: 'Customer receipt', 'tax-invoice': 'Tax invoice',
  'bill-of-supply': 'Bill of supply', 'credit-note': 'Credit note' };

export function BillDocument({ bill }: { bill: BillSnapshot }) {
  return <article className="bill-document" aria-label={`${billNames[bill.kind]} ${bill.number}`}>
    {bill.profile.testMode && <p className="bill-test">TEST · Not for customer use</p>}
    <h3>{bill.profile.legalName}</h3>
    <p className="bill-address">{bill.profile.address}</p>
    <p>{stateNames[bill.profile.stateCode]} · {bill.profile.stateCode}</p>
    {bill.profile.gstin && <p>GSTIN {bill.profile.gstin}</p>}
    <h4>{billNames[bill.kind]}</h4>
    <p><strong>{bill.number}</strong>{bill.issuedAt > 0 && <> · {formatPublicationTime(bill.issuedAt)} IST</>}</p>
    {bill.originalNumber && <p>Against invoice {bill.originalNumber}</p>}
    {bill.reason && <p>Reason: {bill.reason}</p>}
    {bill.buyer.name && <p>Customer: {bill.buyer.name}</p>}
    {bill.buyer.address && <p className="bill-address">{bill.buyer.address}</p>}
    {bill.buyer.gstin && <p>Customer GSTIN {bill.buyer.gstin}</p>}
    <p>Place of supply: {stateNames[bill.buyer.placeState]} ({bill.buyer.placeState})</p>
    {bill.profile.classification && <p>HSN/SAC {bill.profile.classification}</p>}
    <table><thead><tr><th scope="col">Item / unit price</th><th scope="col">Qty</th><th scope="col">Amount</th></tr></thead>
      <tbody>{bill.items.map((item, index) => <tr key={index}><td>{item.name}<small>{formatPaise(item.unitPaise)}</small></td>
        <td>{item.quantity}</td><td>{formatPaise(item.amountPaise)}</td></tr>)}</tbody></table>
    <dl className="bill-totals">
      <div><dt>Items</dt><dd>{formatPaise(bill.subtotalPaise)}</dd></div>
      {bill.discountPaise > 0 && <div><dt>Discount</dt><dd>−{formatPaise(bill.discountPaise)}</dd></div>}
      {bill.profile.taxMode === 'gst' && <>
        <div><dt>Taxable value</dt><dd>{formatPaise(bill.taxablePaise)}</dd></div>
        {bill.buyer.placeState === bill.profile.stateCode ? <>
          <div><dt>CGST {bill.profile.rateBasisPoints / 200}%</dt><dd>{formatPaise(bill.cgstPaise)}</dd></div>
          <div><dt>SGST/UTGST {bill.profile.rateBasisPoints / 200}%</dt><dd>{formatPaise(bill.sgstPaise)}</dd></div>
        </> : <div><dt>IGST {bill.profile.rateBasisPoints / 100}%</dt><dd>{formatPaise(bill.igstPaise)}</dd></div>}
        {bill.roundingPaise !== 0 && <div><dt>Rounding</dt><dd>{formatPaise(bill.roundingPaise)}</dd></div>}
      </>}
      <div className="bill-grand-total"><dt>{bill.kind === 'credit-note' ? 'Credit total' : 'Total'}</dt><dd>{formatPaise(bill.totalPaise)}</dd></div>
    </dl>
    {bill.profile.taxMode === 'gst' && <p>Reverse charge: No</p>}
    {bill.profile.taxMode === 'composition' && <p>Composition taxable person. Not eligible to collect tax on supplies.</p>}
    {bill.kind === 'credit-note' && <p>This credit note does not process a payment refund. Record the refund separately.</p>}
    <p className="bill-signature">Authorised signatory: __________________</p>
  </article>;
}

export function BillPrint({ bill }: { bill: BillSnapshot }) {
  const [width, setWidth] = useState('80');
  const id = useId();
  const document = useRef<HTMLDivElement>(null);
  function print() {
    if (!document.current) return;
    document.current.dataset.printBill = width;
    try { window.print(); } finally { delete document.current.dataset.printBill; }
  }
  return <details className="saved-bill">
    <summary>View / print {billNames[bill.kind].toLowerCase()} · {bill.number}</summary>
    <div className="bill-print-controls">
      <Field><FieldLabel htmlFor={id}>Paper layout</FieldLabel><select id={id} value={width} onChange={event => setWidth(event.target.value)}>
        <option value="58">58 mm receipt</option><option value="80">80 mm receipt</option><option value="a4">A4</option>
      </select></Field>
      <Button variant="outline" onClick={print}>Print {bill.kind === 'credit-note' ? 'credit note' : 'bill'}</Button>
      <p className="note">Choose your installed printer, paper size and copies in the print dialog. Reprinting does not create another bill.</p>
    </div>
    <div ref={document}><BillDocument bill={bill} /></div>
  </details>;
}
