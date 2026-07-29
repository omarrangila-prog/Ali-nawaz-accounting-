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
import { formatMoney, formatDate, cx } from '@/lib/utils';

interface Props {
  row: RegisterRow | null;
  onClose: () => void;
  onReverse: (txnId: string) => void;
  onDelete: (txnId: string) => void;
  onPrint: (row: RegisterRow) => void;
  onChequeAction: (chequeId: string, action: 'deposit' | 'clear' | 'bounce' | 'cancel' | 'replace' | 'edit') => void;
}

export function DetailsDrawer({ row, onClose, onReverse, onDelete, onPrint, onChequeAction }: Props) {
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

          {/* --- core facts --- */}
          <section className="pdc-detail-grid">
            <div><span className="faint">Date</span><span>{formatDate(txn.date)}</span></div>
            <div><span className="faint">Amount</span><span className="mono">{formatMoney(txn.amount, cur)}</span></div>
            {txn.partyId && <div><span className="faint">Party</span><span>{row.partyName}</span></div>}
            {txn.toPartyId && <div><span className="faint">To Party</span><span>{row.toPartyName}</span></div>}
            {row.bankLabel && <div><span className="faint">Bank</span><span>{row.bankLabel}</span></div>}
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
                {cheque.bounceReason && (
                  <div className="wide"><span className="faint">Bounce Reason</span><span>{cheque.bounceReason}</span></div>
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
