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
import { buildBankLedger, buildCashLedger, buildPartyLedger, buildRegister, paymentMethodOf } from '@/lib/pdcRegister';
import { DetailsDrawer } from '@/components/pdc/DetailsDrawer';
import { EditTxnModal, canEdit } from '@/components/pdc/EditTxnModal';
import { ConfirmDialog } from '@/components/ui/Modal';
import type { RegisterRow } from '@/types/pdc';
import { bankAccountLabel, balanceLabel, holderLabel, partyBalances } from '@/lib/pdcEngine';
import { formatMoney, formatDate, formatNumber, cx } from '@/lib/utils';
import { pdcFileName } from '@/lib/pdcReports';
import { buildPartyWorksheet, buildBankWorksheet, buildCashWorksheet } from '@/lib/pdcWorksheet';
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
  /** The Cash Account view — physical cash in hand, with nothing else in it. */
  const [showCash, setShowCash] = useState(params.get('cash') === '1');
  /** Which side of the book to list: everyone, only debtors, or only creditors. */
  const [side, setSide] = useState<'all' | 'receivable' | 'payable'>(
    (params.get('side') as 'receivable' | 'payable') ?? 'all'
  );
  const [detail, setDetail] = useState<RegisterRow | null>(null);
  const [toEdit, setToEdit] = useState<RegisterRow | null>(null);
  const [toDelete, setToDelete] = useState<string | null>(null);
  const register = useMemo(() => buildRegister(data), [data]);

  // Keep the URL in step so the view is shareable / bookmarkable.
  useEffect(() => {
    const next = new URLSearchParams();
    if (partyId) next.set('party', partyId);
    if (accountId) next.set('account', accountId);
    if (showCash) next.set('cash', '1');
    if (side !== 'all') next.set('side', side);
    setParams(next, { replace: true });
  }, [partyId, accountId, showCash, side]);

  /**
   * Split the parties by what they actually mean: someone who owes YOU, or
   * someone you owe. Seeing both mixed together is what makes it easy to read a
   * payable as a receivable, so the choice is made explicit at the top.
   */
  const balances = useMemo(() => partyBalances(data), [data]);

  const partyRows = useMemo(
    () =>
      data.parties
        .map((p) => ({ party: p, balance: balances.get(p.id) ?? 0 }))
        .sort((a, b) => a.party.name.localeCompare(b.party.name)),
    [data.parties, balances]
  );

  const counts = useMemo(() => ({
    all: partyRows.length,
    receivable: partyRows.filter((r) => r.balance > 0).length,
    payable: partyRows.filter((r) => r.balance < 0).length,
    settled: partyRows.filter((r) => r.balance === 0).length,
  }), [partyRows]);

  /** Total owed to you, and total you owe — the headline for the chosen side. */
  const sideTotals = useMemo(() => ({
    receivable: partyRows.reduce((s, r) => s + (r.balance > 0 ? r.balance : 0), 0),
    payable: partyRows.reduce((s, r) => s + (r.balance < 0 ? -r.balance : 0), 0),
  }), [partyRows]);

  const shownParties = useMemo(() => {
    if (side === 'receivable') return partyRows.filter((r) => r.balance > 0);
    if (side === 'payable') return partyRows.filter((r) => r.balance < 0);
    return partyRows;
  }, [partyRows, side]);

  // The balance rides along in the dropdown, so which side a party is on is
  // visible while choosing rather than only after opening the ledger.
  const partyOptions = shownParties.map(({ party, balance }) => ({
    id: party.id,
    label: party.name,
    sub: balance === 0
      ? 'settled'
      : `${formatMoney(Math.abs(balance), cur)} ${balance > 0 ? 'receivable' : 'payable'}`,
  }));
  const accountOptions = data.bankAccounts.map((a) => ({
    id: a.id,
    label: bankAccountLabel(data.banks, data.bankAccounts, a.id),
  }));

  /** The cash account, computed whenever it is the chosen view. */
  const cash = useMemo(
    () => (showCash ? buildCashLedger(data) : null),
    [data, showCash]
  );

  const ledger = useMemo(() => {
    if (showCash && cash) return { rows: cash.rows, balance: cash.balance };
    if (partyId) return buildPartyLedger(data, partyId);
    if (accountId) return buildBankLedger(data, accountId);
    return null;
  }, [data, partyId, accountId, showCash, cash]);

  const party = data.parties.find((p) => p.id === partyId);
  const account = data.bankAccounts.find((a) => a.id === accountId);
  const title = showCash
    ? 'Cash Account'
    : party?.name ?? (account ? bankAccountLabel(data.banks, data.bankAccounts, account.id) : '');

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
    showCash ? buildCashWorksheet(data)
      : partyId ? buildPartyWorksheet(data, partyId)
      : buildBankWorksheet(data, accountId);

  const statementName = () =>
    pdcFileName(showCash ? 'cash-account' : `ledger-${(party?.name ?? title) || 'statement'}`);

  const printStatement = () => {
    if (!partyId && !accountId && !showCash) return;
    printConfirm.print({ makeDoc: makeStatement, fileName: statementName() });
  };

  const downloadStatement = () => {
    if (!partyId && !accountId && !showCash) return;
    makeStatement().save(statementName());
    toast.success('Ledger PDF downloaded');
  };

  return (
    <div className="pdc-page">
      <PageHeader title="Ledger" subtitle="Party and bank account ledgers with running balances" />

      <div className="card" style={{ marginBottom: 12 }}>
        {/* Choose the side of the book FIRST, so a payable is never mistaken
            for a receivable while picking a party. */}
        <div className="quick-filters no-print" style={{ marginBottom: 10 }}>
          {([
            { id: 'all' as const, label: `All Parties (${counts.all})`, hint: '' },
            {
              id: 'receivable' as const,
              label: `Receivable (${counts.receivable})`,
              hint: formatMoney(sideTotals.receivable, cur),
            },
            {
              id: 'payable' as const,
              label: `Payable (${counts.payable})`,
              hint: formatMoney(sideTotals.payable, cur),
            },
          ]).map((c) => (
            <button
              key={c.id}
              className={cx('chip', side === c.id && 'chip-done')}
              title={c.hint ? `Total ${c.hint}` : 'Every party, whichever side they are on'}
              onClick={() => {
                setSide(c.id);
                // A party from the other side would otherwise stay open and
                // contradict the filter just chosen.
                const still = c.id === 'all'
                  || (c.id === 'receivable' && (balances.get(partyId) ?? 0) > 0)
                  || (c.id === 'payable' && (balances.get(partyId) ?? 0) < 0);
                if (partyId && !still) setPartyId('');
              }}
            >
              {c.label}
              {c.hint && <span className="faint" style={{ marginLeft: 6 }}>{c.hint}</span>}
            </button>
          ))}
        </div>

        <div className="pdc-search-row">
          <div className="field" style={{ flex: 1, minWidth: 200 }}>
            <label>
              {side === 'receivable' ? 'Receivable Parties'
                : side === 'payable' ? 'Payable Parties'
                : 'Party Ledger'}
            </label>
            <Combo
              value={partyId}
              options={[{ id: '', label: 'Select a party…' }, ...partyOptions]}
              placeholder={partyOptions.length ? 'Select a party' : 'No parties yet'}
              onChange={(v) => { setPartyId(v); if (v) { setAccountId(''); setShowCash(false); } }}
            />
            {/* An empty dropdown with no explanation looks broken — say why and
                where to fix it. */}
            {partyOptions.length === 0 && (
              <div className="faint" style={{ fontSize: 11.5, marginTop: 4 }}>
                {/* An empty list means something different depending on the
                    filter — say which, rather than looking broken. */}
                {side === 'receivable' ? 'No party currently owes you anything.'
                  : side === 'payable' ? 'You do not owe any party at the moment.'
                  : <>No parties yet —{' '}
                      <button className="link-btn" onClick={() => navigate('/parties')}>
                        add one
                      </button>.
                    </>}
              </div>
            )}
          </div>
          <div className="field" style={{ flex: 1, minWidth: 200 }}>
            <label>Bank Ledger</label>
            <Combo
              value={accountId}
              options={[{ id: '', label: 'Select an account…' }, ...accountOptions]}
              placeholder={accountOptions.length ? 'Select an account' : 'No bank accounts yet'}
              onChange={(v) => { setAccountId(v); if (v) { setPartyId(''); setShowCash(false); } }}
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
          {/* Cash in hand is an account like any other, so it is chosen here
              alongside the party and bank pickers rather than hidden away. */}
          <div className="field" style={{ flex: '0 0 auto', alignSelf: 'flex-end' }}>
            <button
              className={cx('btn', showCash && 'btn-primary')}
              onClick={() => {
                const next = !showCash;
                setShowCash(next);
                if (next) { setPartyId(''); setAccountId(''); }
              }}
              title="Every physical-cash movement, with totals in and out"
            >
              <Icon name="coins" size={15} /> Cash Account
            </button>
          </div>
          {(partyId || accountId || showCash) && (
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
          <div className="empty">Select a party, a bank account, or the Cash Account above to view its ledger.</div>
        </div>
      ) : (
        <div className="card">
          <div className="pdc-register-head">
            <div className="stmt-title" style={{ margin: 0 }}>{title} — Ledger</div>
          </div>

          <div className="pdc-ledger-summary">
            {/* Cash: where it came from, what it went on, and what is left —
                the whole answer to "how much cash do we have?" in one strip. */}
            {cash && (
              <>
                <div>
                  <span className="lbl">Cash from Sales</span>
                  <span className="val mono pos">{formatMoney(cash.breakdown.fromSales, cur)}</span>
                </div>
                <div>
                  <span className="lbl">Cash from Receive</span>
                  <span className="val mono pos">{formatMoney(cash.breakdown.fromReceive, cur)}</span>
                </div>
                <div>
                  <span className="lbl">Cash for Purchases</span>
                  <span className="val mono neg">{formatMoney(cash.breakdown.forPurchases, cur)}</span>
                </div>
                <div>
                  <span className="lbl">Cash for Pay</span>
                  <span className="val mono neg">{formatMoney(cash.breakdown.forPay, cur)}</span>
                </div>
                <div>
                  <span className="lbl">Cash for Expenses</span>
                  <span className="val mono neg">{formatMoney(cash.breakdown.forExpenses, cur)}</span>
                </div>
                <div>
                  <span className="lbl">Total Cash In</span>
                  <span className="val mono pos">{formatMoney(cash.totalIn, cur)}</span>
                </div>
                <div>
                  <span className="lbl">Total Cash Out</span>
                  <span className="val mono neg">{formatMoney(cash.totalOut, cur)}</span>
                </div>
              </>
            )}
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
              <span className="lbl">{party ? 'Status' : showCash ? 'Cash in Hand' : 'Balance'}</span>
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
                    <th className="mid">Date</th>
                    <th className="num">Qty</th><th className="num">Rate</th>
                    <th className="mid">Method</th>
                    {/* Who it came from or went to, and the cheque it rode on —
                        a statement line has to be readable on its own. */}
                    <th>From / To</th>
                    <th className="mid">Cheque #</th><th className="mid">Cheque Date</th>
                    <th>Description</th>
                    {/* On a bank account a debit is money IN and a credit is
                        money OUT, so name them the way a bank statement does. */}
                    <th className="num">{showCash ? 'Cash In' : account ? 'Deposits' : 'Debit'}</th>
                    <th className="num">{showCash ? 'Cash Out' : account ? 'Withdrawals' : 'Credit'}</th>
                    <th className="num">Balance</th>
                    <th className="mid">Status</th>
                    <th className="no-print"></th>
                  </tr>
                </thead>
                <tbody>
                  {/* Row one is ALWAYS the Opening Balance — the figure the
                      statement starts from, shown even when it is zero. */}
                  <tr className="stmt-opening">
                    <td data-label="Date" className="mid">
                      {opening.date ? formatDate(opening.date) : <span className="faint">—</span>}
                    </td>
                    <td data-label="Qty" className="num mono">—</td>
                    <td data-label="Rate" className="num mono">—</td>
                    <td data-label="Method" className="mid"><span className="faint">—</span></td>
                    <td data-label="From / To"><span className="faint">—</span></td>
                    <td data-label="Cheque #" className="mid"><span className="faint">—</span></td>
                    <td data-label="Cheque Date" className="mid"><span className="faint">—</span></td>
                    <td data-label="Description">
                      <strong>{showCash ? 'Opening Cash' : 'Opening Balance'}</strong>
                    </td>
                    <td data-label={showCash ? 'Cash In' : account ? 'Deposits' : 'Debit'} className="num mono pos">
                      {opening.amount > 0 ? formatMoney(opening.amount, cur) : '—'}
                    </td>
                    <td data-label={showCash ? 'Cash Out' : account ? 'Withdrawals' : 'Credit'} className="num mono neg">
                      {opening.amount < 0 ? formatMoney(-opening.amount, cur) : '—'}
                    </td>
                    <td data-label="Balance" className={cx('num mono stmt-bal',
                      opening.amount > 0 ? 'pos' : opening.amount < 0 ? 'neg' : '')}>
                      {formatMoney(opening.amount, cur)}
                    </td>
                    <td data-label="Status" className="mid"><span className="faint">—</span></td>
                    <td className="no-print"></td>
                  </tr>
                  {/* Oldest first, so the running balance builds down the page
                      exactly as it does on the printed statement. */}
                  {statementRows.map(({ entry, txn, cheque, running, relatedName, bankLabel }) => (
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
                      <td data-label="Date" className="mid">{formatDate(entry.date)}</td>
                      <td data-label="Qty" className="num mono">
                        {txn?.quantity !== undefined ? formatNumber(txn.quantity) : '—'}
                      </td>
                      <td data-label="Rate" className="num mono">
                        {txn?.rate !== undefined ? formatMoney(txn.rate, cur) : '—'}
                      </td>
                      <td data-label="Method" className="mid">
                        {(() => {
                          const m = txn ? paymentMethodOf(data, txn).method : '—';
                          return m === '—'
                            ? <span className="faint">—</span>
                            : <span className={cx('method-pill', `m-${m.toLowerCase()}`)}>{m}</span>;
                        })()}
                      </td>
                      <td data-label="From / To">{relatedName || bankLabel || '—'}</td>
                      <td data-label="Cheque #" className="mono mid">{cheque?.chequeNumber || '—'}</td>
                      <td data-label="Cheque Date" className="mid">{cheque ? formatDate(cheque.chequeDate) : '—'}</td>
                      <td data-label="Description">{describe(entry, txn)}</td>
                      <td data-label={showCash ? 'Cash In' : account ? 'Deposits' : 'Debit'} className="num mono pos">{entry.debit ? formatMoney(entry.debit, cur) : '—'}</td>
                      <td data-label={showCash ? 'Cash Out' : account ? 'Withdrawals' : 'Credit'} className="num mono neg">{entry.credit ? formatMoney(entry.credit, cur) : '—'}</td>
                      <td data-label="Balance" className={cx('num mono stmt-bal', running > 0 ? 'pos' : running < 0 ? 'neg' : '')}>
                        {party
                          ? running === 0
                            ? formatMoney(0, cur)
                            : `${running > 0 ? '+' : '−'}${formatMoney(Math.abs(running), cur)}`
                          : formatMoney(running, cur)}
                      </td>
                      <td data-label="Status" className="mid">
                        {cheque
                          ? <span className={cx('pdc-status', `st-${cheque.status}`)}>{cheque.status}</span>
                          : <span className="faint">—</span>}
                      </td>
                      <td className="no-print actions-cell">
                        <div className="row" style={{ gap: 2, justifyContent: 'flex-end' }}>
                          {/* Edit and Delete right here, so a wrong line can be
                              put right without leaving the statement. */}
                          <button className="btn btn-ghost btn-icon btn-sm" title="Edit this entry"
                            onClick={(e) => {
                              e.stopPropagation();
                              const found = register.find((r) => r.txn.id === txn?.id);
                              if (found) setToEdit(found);
                            }}>
                            <Icon name="settings" size={14} />
                          </button>
                          <button className="btn btn-ghost btn-icon btn-sm del-btn" title="Delete permanently"
                            onClick={(e) => { e.stopPropagation(); if (txn) setToDelete(txn.id); }}>
                            <Icon name="trash" size={14} />
                          </button>
                        </div>
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
        // The entry forms live on the Cash Book, so a transfer started here
        // hands over to that screen with the party already chosen.
        onTransfer={(row) => {
          setDetail(null);
          navigate(`/cashbook?transfer=${row.txn.id}`);
        }}
        onEdit={(row) => {
          if (!canEdit(row)) {
            toast.info('This entry cannot be edited — reverse it and post a fresh one.');
            return;
          }
          setDetail(null);
          setToEdit(row);
        }}
      />

      <EditTxnModal row={toEdit} onClose={() => setToEdit(null)} />

      <ConfirmDialog
        open={!!toDelete}
        title="Delete this entry permanently?"
        message="The entry, its ledger effect and any cheque it created are removed completely — balances update immediately. Use Edit instead if the entry really happened and only a detail is wrong."
        confirmLabel="Delete"
        danger
        onConfirm={async () => {
          const id = toDelete;
          setToDelete(null);
          if (id) await store.deleteTransaction(id);
        }}
        onCancel={() => setToDelete(null)}
      />

      {printConfirm.dialog}
    </div>
  );
}
