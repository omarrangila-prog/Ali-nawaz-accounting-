/**
 * Ali Nawaz PDC — transaction details drawer (spec §22)
 *
 * Opens over the Cashbook (Enter on a row) and shows the full accounting effect,
 * every linked record, and the cheque's complete movement timeline. Esc closes.
 */

import { useEffect } from 'react';
import { Icon } from '@/components/ui/Icon';
import { usePdc } from '@/store/pdcStore';
import { chequeTimeline } from '@/lib/chequeWorkflow';
import { bankAccountLabel, holderLabel, partyName } from '@/lib/pdcEngine';
import type { RegisterRow } from '@/types/pdc';
import { formatMoney, formatDate, formatNumber, cx } from '@/lib/utils';

interface Props {
  row: RegisterRow | null;
  onClose: () => void;
  onReverse: (txnId: string) => void;
  onDelete: (txnId: string) => void;
  /** Hand this payment on to another party (cheque endorsement, or a balance move). */
  onTransfer?: (row: RegisterRow) => void;
  onPrint: (row: RegisterRow) => void;
  onChequeAction: (chequeId: string, action: 'deposit' | 'clear' | 'bounce' | 'cancel' | 'replace' | 'edit' | 'return') => void;
}

export function DetailsDrawer({ row, onClose, onReverse, onDelete, onPrint, onChequeAction, onTransfer }: Props) {
  const store = usePdc();
  const data = store.dataset();
  const cur = data.settings.currency;

  useEffect(() => {
    if (!row) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [row, onClose]);

  if (!row) return null;

  const { txn, cheque } = row;
  const lines = data.ledger.filter((l) => l.txnId === txn.id);
  const timeline = cheque ? chequeTimeline(data, cheque.id) : [];
  const reversal = txn.reversedByTxnId
    ? data.transactions.find((t) => t.id === txn.reversedByTxnId)
    : undefined;

  // Which direction the money went, so the party can be labelled plainly as
  // "Received From" or "Paid To" rather than a bare "Party".
  const inbound = ['Sale', 'Cash Received', 'Income', 'PDC Received', 'Debit Adjustment']
    .includes(txn.type);
  const outbound = ['Purchase', 'Cash Paid', 'Expense', 'PDC Issued', 'Credit Adjustment']
    .includes(txn.type);

  const accountLabel = (l: (typeof lines)[number]) => {
    switch (l.account.kind) {
      case 'party': return partyName(data, l.account.id);
      case 'bank': return bankAccountLabel(data.banks, data.bankAccounts, l.account.id);
      case 'ledger':
        return data.ledgers.find((x) => x.id === l.account.id)?.name ?? l.account.id;
      case 'cash':
        if (l.account.id === 'CASH') return 'Cash in Hand';
        if (l.account.id === 'ADJ') return 'Adjustments';
        // Nominal (profit & loss) accounts.
        if (l.account.id.startsWith('NOM:')) {
          const n = l.account.id.slice(4);
          return n.charAt(0) + n.slice(1).toLowerCase();
        }
        if (l.account.id.startsWith('PDC:')) return 'PDC Received (cheque in hand)';
        if (l.account.id.startsWith('PDCI:')) return 'PDC Issued (outstanding)';
        return l.account.id;
    }
  };

  return (
    <>
      <div className="pdc-drawer-backdrop no-print" onMouseDown={onClose} />
      <aside className="pdc-drawer glass no-print" role="dialog" aria-modal>
        <header className="pdc-drawer-head">
          <div>
            <div className="pdc-drawer-ref mono">{txn.reference}</div>
            <h3>{txn.type}</h3>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </header>

        <div className="pdc-drawer-body">
          {txn.reversed && (
            <div className="pdc-warn">
              Reversed{reversal ? ` by ${reversal.reference}` : ''} — kept for history.
            </div>
          )}

          {/* --- core facts. Only fields that apply to THIS entry appear. --- */}
          <section className="pdc-detail-grid">
            <div><span className="faint">Date</span><span>{formatDate(txn.date)}</span></div>
            <div><span className="faint">Type</span><span>{txn.type}</span></div>
            <div>
              <span className="faint">Payment Method</span>
              <span>
                <span className={cx('method-pill', `m-${row.method.toLowerCase()}`)}>{row.method}</span>
              </span>
            </div>
            {row.bankName && <div><span className="faint">Bank</span><span>{row.bankName}</span></div>}

            {/* "Received from" / "Paid to" reads more plainly than "Party". */}
            {txn.partyId && (
              <div>
                <span className="faint">{inbound ? 'Received From' : outbound ? 'Paid To' : 'Party'}</span>
                <span>{row.partyName}</span>
              </div>
            )}
            {txn.toPartyId && <div><span className="faint">Transferred To</span><span>{row.toPartyName}</span></div>}

            {/* Item, quantity and rate for trading entries. */}
            {txn.itemName && <div><span className="faint">Item</span><span>{txn.itemName}</span></div>}
            {txn.quantity !== undefined && (
              <div><span className="faint">Quantity</span><span className="mono">{formatNumber(txn.quantity)}</span></div>
            )}
            {txn.rate !== undefined && (
              <div><span className="faint">Rate</span><span className="mono">{formatMoney(txn.rate, cur)}</span></div>
            )}
            {txn.category && <div><span className="faint">Category</span><span>{txn.category}</span></div>}
            {txn.settlement && (
              <div>
                <span className="faint">Settled</span>
                <span>{txn.settlement === 'cash' ? 'Paid now' : 'On account'}</span>
              </div>
            )}

            <div><span className="faint">Total Amount</span><span className="mono detail-total">{formatMoney(txn.amount, cur)}</span></div>
            {txn.description && <div className="wide"><span className="faint">Description</span><span>{txn.description}</span></div>}
          </section>

          {/* --- cheque --- */}
          {cheque && (
            <section>
              <h4 className="pdc-section-title">Cheque</h4>
              <div className="pdc-detail-grid">
                <div><span className="faint">Number</span><span className="mono">{cheque.chequeNumber}</span></div>
                <div><span className="faint">Cheque Date</span><span>{formatDate(cheque.chequeDate)}</span></div>
                <div><span className="faint">Amount</span><span className="mono">{formatMoney(cheque.amount, cur)}</span></div>
                <div><span className="faint">Status</span><span className={cx('pdc-status', `st-${cheque.status}`)}>{cheque.status}</span></div>
                <div><span className="faint">Current Holder</span><span>{holderLabel(data, cheque.holder)}</span></div>
                {cheque.allocatedAmount > 0 && (
                  <div><span className="faint">Allocated</span><span className="mono">{formatMoney(cheque.allocatedAmount, cur)}</span></div>
                )}
                <div>
                  <span className="faint">Direction</span>
                  <span>{cheque.direction === 'received' ? 'Received from party' : 'Issued to party'}</span>
                </div>
                {cheque.drawerName && (
                  <div><span className="faint">Drawer Name</span><span>{cheque.drawerName}</span></div>
                )}
                {cheque.accountNumber && (
                  <div><span className="faint">Account Number</span><span className="mono">{cheque.accountNumber}</span></div>
                )}
                {cheque.branch && <div><span className="faint">Branch</span><span>{cheque.branch}</span></div>}
                {cheque.bouncedOn && (
                  <div><span className="faint">Bounced On</span><span>{formatDate(cheque.bouncedOn)}</span></div>
                )}
                {cheque.bounceReason && (
                  <div className="wide"><span className="faint">Bounce Reason</span><span>{cheque.bounceReason}</span></div>
                )}
                {cheque.replacedByChequeId && (
                  <div>
                    <span className="faint">Replaced By</span>
                    <span className="mono">
                      {data.cheques.find((c) => c.id === cheque.replacedByChequeId)?.chequeNumber ?? '—'}
                    </span>
                  </div>
                )}
                {cheque.replacesChequeId && (
                  <div>
                    <span className="faint">Replaces</span>
                    <span className="mono">
                      {data.cheques.find((c) => c.id === cheque.replacesChequeId)?.chequeNumber ?? '—'}
                    </span>
                  </div>
                )}
              </div>

              <div className="pdc-drawer-actions">
                <button className="btn btn-sm" onClick={() => onChequeAction(cheque.id, 'edit')}>Edit Details</button>
                {cheque.direction === 'received' && cheque.status === 'pending' && (
                  <button className="btn btn-sm" onClick={() => onChequeAction(cheque.id, 'deposit')}>Deposit</button>
                )}
                {(cheque.status === 'deposited' || cheque.status === 'presented') && (
                  <button className="btn btn-sm btn-green" onClick={() => onChequeAction(cheque.id, 'clear')}>Mark Cleared</button>
                )}
                {cheque.status !== 'cleared' && cheque.status !== 'cancelled' && cheque.status !== 'replaced' && (
                  <button className="btn btn-sm btn-danger" onClick={() => onChequeAction(cheque.id, 'bounce')}>Bounced</button>
                )}
                {cheque.status !== 'cleared' && cheque.status !== 'cancelled' &&
                 cheque.status !== 'replaced' && cheque.status !== 'returned' && (
                  <button className="btn btn-sm btn-danger" onClick={() => onChequeAction(cheque.id, 'return')}>Returned</button>
                )}
                {(cheque.status === 'bounced' || cheque.status === 'returned') && (
                  <button className="btn btn-sm" onClick={() => onChequeAction(cheque.id, 'replace')}>Link Replacement</button>
                )}
                {cheque.status === 'pending' && (
                  <button className="btn btn-sm" onClick={() => onChequeAction(cheque.id, 'cancel')}>Cancel Cheque</button>
                )}
              </div>
            </section>
          )}

          {/* --- double-entry effect (spec §22) --- */}
          <section>
            <h4 className="pdc-section-title">Accounting Effect</h4>
            {lines.length === 0 ? (
              <div className="faint">Status-only entry — no money movement.</div>
            ) : (
              <table className="grid pdc-mini-grid">
                <thead>
                  <tr><th>Account</th><th className="num">Debit</th><th className="num">Credit</th></tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.id}>
                      <td>{accountLabel(l)} <span className="faint">· {l.mainLedger}</span></td>
                      <td className="num mono">{l.debit ? formatMoney(l.debit, cur) : '—'}</td>
                      <td className="num mono">{l.credit ? formatMoney(l.credit, cur) : '—'}</td>
                    </tr>
                  ))}
                  <tr className="pdc-total-row">
                    <td>Total</td>
                    <td className="num mono">{formatMoney(lines.reduce((s, l) => s + l.debit, 0), cur)}</td>
                    <td className="num mono">{formatMoney(lines.reduce((s, l) => s + l.credit, 0), cur)}</td>
                  </tr>
                </tbody>
              </table>
            )}
          </section>

          {/* --- cheque movement timeline (spec §18) --- */}
          {timeline.length > 0 && (
            <section>
              <h4 className="pdc-section-title">Cheque Movement Timeline</h4>
              <ol className="pdc-timeline">
                {timeline.map((m) => (
                  <li key={m.id}>
                    <div className="pdc-tl-dot" />
                    <div className="pdc-tl-body">
                      <div className="pdc-tl-action">{m.action}</div>
                      <div className="faint pdc-tl-meta">
                        {formatDate(m.date)}
                        {m.fromStatus && m.toStatus && ` · ${m.fromStatus} → ${m.toStatus}`}
                        {m.toPartyId && ` · to ${partyName(data, m.toPartyId)}`}
                        {m.reference && ` · ${m.reference}`}
                      </div>
                      {m.description && <div className="pdc-tl-desc">{m.description}</div>}
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {/* --- meta --- */}
          <section className="pdc-detail-grid faint" style={{ fontSize: 12 }}>
            <div><span>Created</span><span>{new Date(txn.createdAt).toLocaleString()}</span></div>
            {txn.updatedAt !== txn.createdAt && (
              <div><span>Last edited</span><span>{new Date(txn.updatedAt).toLocaleString()}</span></div>
            )}
          </section>
        </div>

        <footer className="pdc-drawer-foot">
          <button className="btn btn-sm" onClick={() => onPrint(row)}>
            <Icon name="print" size={15} /> Print
          </button>
          {/* Hand this payment on to someone else. A cheque is ENDORSED — the
              same physical cheque changes hands, never a copy — while anything
              else moves the balance between the two parties. */}
          {!txn.reversed && txn.partyId && onTransfer && (
            <button
              className="btn btn-sm"
              onClick={() => onTransfer(row)}
              title={
                cheque
                  ? `Endorse cheque ${cheque.chequeNumber || '(no number)'} to another party`
                  : 'Move this amount to another party'
              }
            >
              <Icon name="transfer" size={15} /> Transfer
            </button>
          )}
          {!txn.reversed && (
            <button className="btn btn-sm" onClick={() => onReverse(txn.id)}>
              Reverse
            </button>
          )}
          <button className="btn btn-sm btn-danger" onClick={() => onDelete(txn.id)}>
            Delete
          </button>
        </footer>
      </aside>
    </>
  );
}
