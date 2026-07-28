/**
 * Ali Nawaz PDC — Party & Bank ledgers (spec §5)
 *
 * Reads through pdcRegister so the balances shown here are the same numbers the
 * Cashbook and every report use — never a second calculation (spec §31.12).
 */

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '@/components/ui/PageHeader';
import { Icon } from '@/components/ui/Icon';
import { Combo } from '@/components/ui/Combo';
import { usePdc } from '@/store/pdcStore';
import { buildBankLedger, buildPartyLedger } from '@/lib/pdcRegister';
import { bankAccountLabel, balanceLabel, holderLabel } from '@/lib/pdcEngine';
import { formatMoney, formatDate, cx } from '@/lib/utils';
import { buildPartyStatementDoc, pdcFileName } from '@/lib/pdcReports';
import { usePrintConfirm } from '@/components/ui/PrintConfirm';
import { toast } from '@/store/toast';
import './pdc.css';
import './statement.css';

export function PdcLedger() {
  const [params, setParams] = useSearchParams();
  const store = usePdc();
  const data = store.dataset();
  const cur = data.settings.currency;
  const printConfirm = usePrintConfirm();

  const [partyId, setPartyId] = useState(params.get('party') ?? '');
  const [accountId, setAccountId] = useState(params.get('account') ?? '');

  // Keep the URL in step so the view is shareable / bookmarkable.
  useEffect(() => {
    const next = new URLSearchParams();
    if (partyId) next.set('party', partyId);
    if (accountId) next.set('account', accountId);
    setParams(next, { replace: true });
  }, [partyId, accountId]);

  const partyOptions = data.parties.map((p) => ({ id: p.id, label: p.name }));
  const accountOptions = data.bankAccounts.map((a) => ({
    id: a.id,
    label: bankAccountLabel(data.banks, data.bankAccounts, a.id),
  }));

  const ledger = useMemo(() => {
    if (partyId) return buildPartyLedger(data, partyId);
    if (accountId) return buildBankLedger(data, accountId);
    return null;
  }, [data, partyId, accountId]);

  const party = data.parties.find((p) => p.id === partyId);
  const account = data.bankAccounts.find((a) => a.id === accountId);
  const title = party?.name ?? (account ? bankAccountLabel(data.banks, data.bankAccounts, account.id) : '');

  /** Cheques connected to this party, for the summary strip. */
  const chequeStats = useMemo(() => {
    if (!partyId) return null;
    const mine = data.cheques.filter((c) => c.partyId === partyId);
    const sum = (f: (c: (typeof mine)[number]) => boolean) =>
      mine.filter(f).reduce((s, c) => s + c.amount, 0);
    return {
      received: sum((c) => c.direction === 'received'),
      issued: sum((c) => c.direction === 'issued'),
      pending: sum((c) => c.status === 'pending'),
      bounced: sum((c) => c.status === 'bounced'),
    };
  }, [data.cheques, partyId]);

  const printStatement = () => {
    if (!partyId) return;
    printConfirm.print({
      makeDoc: () => buildPartyStatementDoc(data, partyId),
      fileName: pdcFileName(`statement-${party?.name ?? 'party'}`),
    });
  };

  const downloadStatement = () => {
    if (!partyId) return;
    buildPartyStatementDoc(data, partyId).save(pdcFileName(`statement-${party?.name ?? 'party'}`));
    toast.success('Statement PDF downloaded');
  };

  return (
    <div className="pdc-page">
      <PageHeader title="Ledger" subtitle="Party and bank account ledgers with running balances" />

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="pdc-search-row">
          <div className="field" style={{ flex: 1, minWidth: 200 }}>
            <label>Party Ledger</label>
            <Combo
              value={partyId}
              options={[{ id: '', label: 'Select a party…' }, ...partyOptions]}
              placeholder="Select a party"
              onChange={(v) => { setPartyId(v); if (v) setAccountId(''); }}
            />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 200 }}>
            <label>Bank Ledger</label>
            <Combo
              value={accountId}
              options={[{ id: '', label: 'Select an account…' }, ...accountOptions]}
              placeholder="Select an account"
              onChange={(v) => { setAccountId(v); if (v) setPartyId(''); }}
            />
          </div>
          {partyId && (
            <div className="row" style={{ gap: 6, alignSelf: 'flex-end' }}>
              <button className="btn btn-sm" onClick={printStatement}>
                <Icon name="print" size={15} /> Print
              </button>
              <button className="btn btn-sm" onClick={downloadStatement}>
                <Icon name="pdf" size={15} /> PDF
              </button>
            </div>
          )}
        </div>
      </div>

      {!ledger ? (
        <div className="card">
          <div className="empty">Select a party or bank account above to view its ledger.</div>
        </div>
      ) : (
        <div className="card">
          <div className="pdc-register-head">
            <div className="stmt-title" style={{ margin: 0 }}>{title} — Ledger</div>
          </div>

          <div className="pdc-ledger-summary">
            {party && (
              <>
                <div>
                  <span className="lbl">Opening</span>
                  <span className="val mono">{formatMoney(party.openingBalance, cur)}</span>
                </div>
                <div>
                  <span className="lbl">Cheques Received</span>
                  <span className="val mono">{formatMoney(chequeStats?.received ?? 0, cur)}</span>
                </div>
                <div>
                  <span className="lbl">Cheques Issued</span>
                  <span className="val mono">{formatMoney(chequeStats?.issued ?? 0, cur)}</span>
                </div>
                <div>
                  <span className="lbl">Bounced</span>
                  <span className={cx('val mono', (chequeStats?.bounced ?? 0) > 0 && 'neg')}>
                    {formatMoney(chequeStats?.bounced ?? 0, cur)}
                  </span>
                </div>
              </>
            )}
            {account && (
              <div>
                <span className="lbl">Opening</span>
                <span className="val mono">{formatMoney(account.openingBalance, cur)}</span>
              </div>
            )}
            <div>
              <span className="lbl">{party ? 'Status' : 'Balance'}</span>
              <span className={cx('val', ledger.balance > 0 ? 'pos' : ledger.balance < 0 ? 'neg' : '')}>
                {party
                  ? `${formatMoney(Math.abs(ledger.balance), cur)} ${balanceLabel(ledger.balance)}`
                  : formatMoney(ledger.balance, cur)}
              </span>
            </div>
          </div>

          {ledger.rows.length === 0 ? (
            <div className="empty">No transactions yet for this {party ? 'party' : 'account'}.</div>
          ) : (
            <div className="table-wrap">
              <table className="grid pdc-grid stack-sm">
                <thead>
                  <tr>
                    <th>Date</th><th>Reference</th><th>Type</th><th>Method</th>
                    <th>Cheque #</th><th>Cheque Date</th>
                    <th>Description</th><th>Related</th>
                    <th className="num">Debit</th><th className="num">Credit</th>
                    <th className="num">Balance</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.rows.map(({ entry, txn, cheque, running, relatedName, bankLabel }) => (
                    <tr key={entry.id} className={cx(txn?.reversed && 'row-reversed')}>
                      <td data-label="Date">{formatDate(entry.date)}</td>
                      <td data-label="Reference" className="mono">{txn?.reference ?? '—'}</td>
                      <td data-label="Type">{entry.type}</td>
                      <td data-label="Method">{cheque ? 'Cheque' : bankLabel ? 'Bank' : 'Cash'}</td>
                      <td data-label="Cheque #" className="mono">{cheque?.chequeNumber ?? '—'}</td>
                      <td data-label="Cheque Date">{cheque ? formatDate(cheque.chequeDate) : '—'}</td>
                      <td data-label="Description">{entry.description}</td>
                      <td data-label="Related">{relatedName || bankLabel || '—'}</td>
                      <td data-label="Debit" className="num mono pos">{entry.debit ? formatMoney(entry.debit, cur) : '—'}</td>
                      <td data-label="Credit" className="num mono neg">{entry.credit ? formatMoney(entry.credit, cur) : '—'}</td>
                      <td data-label="Balance" className={cx('num mono stmt-bal', running > 0 ? 'pos' : running < 0 ? 'neg' : '')}>
                        {party
                          ? running === 0
                            ? formatMoney(0, cur)
                            : `${running > 0 ? '+' : '−'}${formatMoney(Math.abs(running), cur)}`
                          : formatMoney(running, cur)}
                      </td>
                      <td data-label="Status">
                        {cheque
                          ? <span className={cx('pdc-status', `st-${cheque.status}`)}>{cheque.status}</span>
                          : <span className="faint">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {party && (
            <div className="faint" style={{ marginTop: 10, fontSize: 12 }}>
              Balance is <strong>{balanceLabel(ledger.balance)}</strong>
              {ledger.balance !== 0 && <> · {formatMoney(Math.abs(ledger.balance), cur)}</>}
            </div>
          )}
        </div>
      )}

      {printConfirm.dialog}
    </div>
  );
}
