/**
 * Ali Nawaz PDC — Party & Bank ledgers (spec §5)
 *
 * Reads through pdcRegister so the balances shown here are the same numbers the
 * Cashbook and every report use — never a second calculation (spec §31.12).
 */

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { PageHeader } from '@/components/ui/PageHeader';
import { Icon } from '@/components/ui/Icon';
import { Combo } from '@/components/ui/Combo';
import { usePdc } from '@/store/pdcStore';
import { buildBankLedger, buildPartyLedger, buildRegister, paymentMethodOf } from '@/lib/pdcRegister';
import { DetailsDrawer } from '@/components/pdc/DetailsDrawer';
import type { RegisterRow } from '@/types/pdc';
import { bankAccountLabel, balanceLabel, holderLabel } from '@/lib/pdcEngine';
import { formatMoney, formatDate, formatNumber, cx } from '@/lib/utils';
import { pdcFileName } from '@/lib/pdcReports';
import { buildPartyWorksheet, buildBankWorksheet } from '@/lib/pdcWorksheet';
import { usePrintConfirm } from '@/components/ui/PrintConfirm';
import { toast } from '@/store/toast';
import './pdc.css';
import './statement.css';

export function PdcLedger() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const store = usePdc();
  const data = store.dataset();
  const cur = data.settings.currency;
  const printConfirm = usePrintConfirm();

  const [partyId, setPartyId] = useState(params.get('party') ?? '');
  const [accountId, setAccountId] = useState(params.get('account') ?? '');
  const [detail, setDetail] = useState<RegisterRow | null>(null);
  const register = useMemo(() => buildRegister(data), [data]);

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

  /**
   * The opening figure this statement starts from. Always shown as row one,
   * even when it is zero, so the reader can see where the balance began rather
   * than having to infer it.
   */
  const opening = useMemo(() => {
    if (party) return { amount: party.openingBalance, date: '' };
    if (account) return { amount: account.openingBalance, date: '' };
    return { amount: 0, date: '' };
  }, [party, account]);

  /**
   * Statement rows oldest-first. buildPartyLedger returns newest-first for the
   * register's on-screen feel, but a statement has to read downwards so each
   * running balance follows from the line above it.
   */
  const statementRows = useMemo(
    () => (ledger ? [...ledger.rows].reverse() : []),
    [ledger]
  );

  /**
   * What a line says on the statement. The user's own words come first — the
   * printed book reads "shoaib", not a generated label — falling back to the
   * item, then the category, then the entry type.
   */
  const describe = (
    entry: { description: string; type: string },
    txn?: { description?: string; itemName?: string; category?: string }
  ): string =>
    txn?.description?.trim() ||
    txn?.itemName?.trim() ||
    txn?.category?.trim() ||
    entry.description?.trim() ||
    entry.type;

  /** The printed worksheet, matching the ledger book the business already uses. */
  const makeStatement = () =>
    partyId ? buildPartyWorksheet(data, partyId) : buildBankWorksheet(data, accountId);

  const statementName = () =>
    pdcFileName(`ledger-${(party?.name ?? title) || 'statement'}`);

  const printStatement = () => {
    if (!partyId && !accountId) return;
    printConfirm.print({ makeDoc: makeStatement, fileName: statementName() });
  };

  const downloadStatement = () => {
    if (!partyId && !accountId) return;
    makeStatement().save(statementName());
    toast.success('Ledger PDF downloaded');
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
              placeholder={partyOptions.length ? 'Select a party' : 'No parties yet'}
              onChange={(v) => { setPartyId(v); if (v) setAccountId(''); }}
            />
            {/* An empty dropdown with no explanation looks broken — say why and
                where to fix it. */}
            {partyOptions.length === 0 && (
              <div className="faint" style={{ fontSize: 11.5, marginTop: 4 }}>
                No parties yet —{' '}
                <button className="link-btn" onClick={() => navigate('/parties')}>
                  add one
                </button>
                .
              </div>
            )}
          </div>
          <div className="field" style={{ flex: 1, minWidth: 200 }}>
            <label>Bank Ledger</label>
            <Combo
              value={accountId}
              options={[{ id: '', label: 'Select an account…' }, ...accountOptions]}
              placeholder={accountOptions.length ? 'Select an account' : 'No bank accounts yet'}
              onChange={(v) => { setAccountId(v); if (v) setPartyId(''); }}
            />
            {accountOptions.length === 0 && (
              <div className="faint" style={{ fontSize: 11.5, marginTop: 4 }}>
                {data.banks.length > 0
                  ? <>You have {data.banks.length} banks but no account under any of them. </>
                  : <>No banks yet. </>}
                <button className="link-btn" onClick={() => navigate('/parties?tab=banks')}>
                  Add a bank account
                </button>
                .
              </div>
            )}
          </div>
          {(partyId || accountId) && (
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
                    {/* A statement, read like a bank statement. The figures that
                        explain the amount — quantity, rate, how it was paid —
                        come before the free text, so the eye reaches them
                        without crossing a sentence. */}
                    <th>Date</th>
                    <th className="num">Qty</th><th className="num">Rate</th>
                    <th>Method</th>
                    <th>Description</th>
                    <th className="num">Debit</th><th className="num">Credit</th>
                    <th className="num">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {/* Row one is ALWAYS the Opening Balance — the figure the
                      statement starts from, shown even when it is zero. */}
                  <tr className="stmt-opening">
                    <td data-label="Date">
                      {opening.date ? formatDate(opening.date) : <span className="faint">—</span>}
                    </td>
                    <td data-label="Qty" className="num mono">—</td>
                    <td data-label="Rate" className="num mono">—</td>
                    <td data-label="Method"><span className="faint">—</span></td>
                    <td data-label="Description"><strong>Opening Balance</strong></td>
                    <td data-label="Debit" className="num mono pos">
                      {opening.amount > 0 ? formatMoney(opening.amount, cur) : '—'}
                    </td>
                    <td data-label="Credit" className="num mono neg">
                      {opening.amount < 0 ? formatMoney(-opening.amount, cur) : '—'}
                    </td>
                    <td data-label="Balance" className={cx('num mono stmt-bal',
                      opening.amount > 0 ? 'pos' : opening.amount < 0 ? 'neg' : '')}>
                      {formatMoney(opening.amount, cur)}
                    </td>
                  </tr>
                  {/* Oldest first, so the running balance builds down the page
                      exactly as it does on the printed statement. */}
                  {statementRows.map(({ entry, txn, running }) => (
                    <tr
                      key={entry.id}
                      className={cx(txn?.reversed && 'row-reversed')}
                      style={{ cursor: txn ? 'pointer' : undefined }}
                      onClick={() => {
                        // Open the same detail panel the Cash Book uses, so a
                        // transaction reads identically wherever it appears.
                        const found = register.find((r) => r.txn.id === txn?.id);
                        if (found) setDetail(found);
                      }}
                    >
                      <td data-label="Date">{formatDate(entry.date)}</td>
                      <td data-label="Qty" className="num mono">
                        {txn?.quantity !== undefined ? formatNumber(txn.quantity) : '—'}
                      </td>
                      <td data-label="Rate" className="num mono">
                        {txn?.rate !== undefined ? formatMoney(txn.rate, cur) : '—'}
                      </td>
                      <td data-label="Method">
                        {(() => {
                          const m = txn ? paymentMethodOf(data, txn).method : '—';
                          return m === '—'
                            ? <span className="faint">—</span>
                            : <span className={cx('method-pill', `m-${m.toLowerCase()}`)}>{m}</span>;
                        })()}
                      </td>
                      <td data-label="Description">{describe(entry, txn)}</td>
                      <td data-label="Debit" className="num mono pos">{entry.debit ? formatMoney(entry.debit, cur) : '—'}</td>
                      <td data-label="Credit" className="num mono neg">{entry.credit ? formatMoney(entry.credit, cur) : '—'}</td>
                      <td data-label="Balance" className={cx('num mono stmt-bal', running > 0 ? 'pos' : running < 0 ? 'neg' : '')}>
                        {party
                          ? running === 0
                            ? formatMoney(0, cur)
                            : `${running > 0 ? '+' : '−'}${formatMoney(Math.abs(running), cur)}`
                          : formatMoney(running, cur)}
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

      <DetailsDrawer
        row={detail}
        onClose={() => setDetail(null)}
        onReverse={async (id) => { await store.reverse(id); setDetail(null); }}
        onDelete={async (id) => { await store.deleteTransaction(id); setDetail(null); }}
        onPrint={() => window.print()}
        onChequeAction={() => toast.info('Open this cheque from the Cash Book to change its status.')}
      />

      {printConfirm.dialog}
    </div>
  );
}
