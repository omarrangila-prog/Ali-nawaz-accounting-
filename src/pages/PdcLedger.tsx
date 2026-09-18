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
  const [side, setSide] = useState<'all' | 'receivable' | 'payable' | 'i-pay' | 'i-receive'>(
    (params.get('side') as 'receivable' | 'payable') ?? 'all'
  );
  /** Narrows the party list by name — with dozens of parties, scanning is slow. */
  const [partySearch, setPartySearch] = useState('');
  /** Which lines of the statement to show: everything, money in, or money out. */
  const [lineKind, setLineKind] = useState<'all' | 'receive' | 'pay' | 'sale' | 'purchase'>('all');
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

  /**
   * Who a party IS to the business, taken from what has actually happened with
   * them rather than from the sign of their balance:
   *
   *   paid     — money has gone out to them (a supplier / payee)
   *   received — money has come in from them (a customer)
   *
   * A party can be both. This is separate from receivable/payable, which only
   * says which way the balance currently leans — a supplier you have paid in
   * advance shows as receivable, and that is correct but not what you want to
   * read when asking "who do I pay?".
   */
  const roles = useMemo(() => {
    const paid = new Set<string>(), received = new Set<string>();
    for (const t of data.transactions) {
      if (t.reversed || !t.partyId) continue;
      if (t.type === 'Cash Paid' || t.type === 'PDC Issued' || t.type === 'Purchase') paid.add(t.partyId);
      if (t.type === 'Cash Received' || t.type === 'PDC Received' || t.type === 'Sale') received.add(t.partyId);
    }
    return { paid, received };
  }, [data.transactions]);

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
    iPay: partyRows.filter((r) => roles.paid.has(r.party.id)).length,
    iReceive: partyRows.filter((r) => roles.received.has(r.party.id)).length,
  }), [partyRows, roles]);

  /** Total owed to you, and total you owe — the headline for the chosen side. */
  const sideTotals = useMemo(() => ({
    receivable: partyRows.reduce((s, r) => s + (r.balance > 0 ? r.balance : 0), 0),
    payable: partyRows.reduce((s, r) => s + (r.balance < 0 ? -r.balance : 0), 0),
  }), [partyRows]);

  const shownParties = useMemo(() => {
    const bySide =
      side === 'receivable' ? partyRows.filter((r) => r.balance > 0)
        : side === 'payable' ? partyRows.filter((r) => r.balance < 0)
        : side === 'i-pay' ? partyRows.filter((r) => roles.paid.has(r.party.id))
        : side === 'i-receive' ? partyRows.filter((r) => roles.received.has(r.party.id))
        : partyRows;
    const q = partySearch.trim().toLowerCase();
    return q ? bySide.filter((r) => r.party.name.toLowerCase().includes(q)) : bySide;
  }, [partyRows, side, partySearch, roles]);

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
  const allStatementRows = useMemo(
    () => (ledger ? [...ledger.rows].reverse() : []),
    [ledger]
  );
  const LINE_TYPES: Record<string, string[]> = {
    receive: ['Cash Received', 'PDC Received', 'Cheque Cleared'],
    pay: ['Cash Paid', 'PDC Issued'],
    sale: ['Sale'],
    purchase: ['Purchase'],
  };
  const statementRows = useMemo(() => {
    if (lineKind === 'all') return allStatementRows;
    const want = LINE_TYPES[lineKind];
    return allStatementRows.filter((r) => r.txn && want.includes(r.txn.type));
  }, [allStatementRows, lineKind]);

  /** Counts per kind, so the chips say what they will show before clicking. */
  const lineCounts = useMemo(() => {
    const c = { all: allStatementRows.length, receive: 0, pay: 0, sale: 0, purchase: 0 };
    for (const r of allStatementRows) {
      const t = r.txn?.type;
      if (!t) continue;
      if (LINE_TYPES.receive.includes(t)) c.receive++;
      else if (LINE_TYPES.pay.includes(t)) c.pay++;
      else if (t === 'Sale') c.sale++;
      else if (t === 'Purchase') c.purchase++;
    }
    return c;
  }, [allStatementRows]);

  /** Total of the lines shown, so a filtered view totals itself. */
  const shownTotal = useMemo(
    () => statementRows.reduce((s, r) => s + r.entry.debit - r.entry.credit, 0),
    [statementRows]
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
            // By ROLE, not by balance: who you pay, and who pays you.
            { id: 'i-pay' as const, label: `I Pay (${counts.iPay})`, hint: '' },
            { id: 'i-receive' as const, label: `I Receive (${counts.iReceive})`, hint: '' },
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
                  || (c.id === 'payable' && (balances.get(partyId) ?? 0) < 0)
                  || (c.id === 'i-pay' && roles.paid.has(partyId))
                  || (c.id === 'i-receive' && roles.received.has(partyId));
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

      {/* The parties on the chosen side, listed and clickable. A dropdown hides
          them behind a click; the daily job here is reading down the
          outstanding list, so it is shown outright. */}
      {!showCash && !accountId && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="pdc-register-head">
            <div className="stmt-title" style={{ margin: 0 }}>
              {side === 'receivable' ? 'Receivable Parties'
                : side === 'payable' ? 'Payable Parties'
                : side === 'i-pay' ? 'Parties I Pay'
                : side === 'i-receive' ? 'Parties I Receive From'
                : 'All Parties'}
              {' · '}{formatNumber(shownParties.length)}
            </div>
            {/* The total of what is LISTED, so it always agrees with the rows
                above it — a full-side total beside a searched list would not. */}
            {side !== 'all' && (
              <div className="mono" style={{ fontWeight: 700 }}>
                {formatMoney(
                  shownParties.reduce((s, r) => s + Math.abs(r.balance), 0),
                  cur
                )}
              </div>
            )}
          </div>

          <div className="pdc-search-box no-print" style={{ margin: '8px 0' }}>
            <Icon name="search" size={16} />
            <input
              className="input"
              placeholder="Search party name…"
              value={partySearch}
              onChange={(e) => setPartySearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') setPartySearch(''); }}
            />
          </div>

          {shownParties.length === 0 ? (
            <div className="empty">
              {partySearch.trim()
                ? `No party matches "${partySearch.trim()}" on this list.`
                : side === 'receivable' ? 'No party currently owes you anything — everything is collected.'
                : side === 'payable' ? 'You do not owe any party at the moment — everything is paid.'
                : 'No parties yet.'}
            </div>
          ) : (
            <div className="table-wrap" style={{ maxHeight: 320 }}>
              <table className="grid stack-sm">
                <thead>
                  <tr>
                    <th>Party</th>
                    <th className="num">Outstanding</th>
                    <th className="mid">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {shownParties.map(({ party, balance }) => (
                    <tr
                      key={party.id}
                      className={cx('row-link', partyId === party.id && 'row-selected')}
                      style={{ cursor: 'pointer' }}
                      title={`Open ${party.name}'s ledger`}
                      onClick={() => { setPartyId(party.id); setAccountId(''); setShowCash(false); }}
                    >
                      <td data-label="Party"><span className="link-text">{party.name}</span></td>
                      <td data-label="Outstanding" className={cx('num mono', balance > 0 ? 'pos' : balance < 0 ? 'neg' : '')}>
                        {balance === 0 ? '—' : formatMoney(Math.abs(balance), cur)}
                      </td>
                      <td data-label="Status" className="mid">
                        {/* Derived from the live balance, so a party that has
                            been settled stops showing as owing the moment the
                            payment is recorded. */}
                        <span className={cx('pdc-status',
                          balance > 0 ? 'st-cleared' : balance < 0 ? 'st-bounced' : 'st-cancelled')}>
                          {balanceLabel(balance)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Settled parties are absent from both sides by design — say so, so
              a shrinking list reads as progress rather than missing data. */}
          {side !== 'all' && counts.settled > 0 && (
            <div className="faint" style={{ fontSize: 11.5, marginTop: 8 }}>
              {formatNumber(counts.settled)} settled part{counts.settled === 1 ? 'y is' : 'ies are'} hidden
              — they have nothing outstanding.
            </div>
          )}
        </div>
      )}

      {!ledger ? (
        <div className="card">
          <div className="empty">Select a party, a bank account, or the Cash Account above to view its ledger.</div>
        </div>
      ) : (
        <div className="card">
          <div className="pdc-register-head">
            <div className="stmt-title" style={{ margin: 0 }}>{title} — Ledger</div>
          </div>

          {/* See only the receipts, only the payments, or only the trades on
              this statement. The running balance stays the TRUE balance at
              each line, so this is a selection from the real statement, not a
              recalculated one. */}
          <div className="quick-filters no-print" style={{ margin: '8px 0' }}>
            {([
              { id: 'all' as const, label: `All (${lineCounts.all})` },
              { id: 'receive' as const, label: `Receive (${lineCounts.receive})` },
              { id: 'pay' as const, label: `Pay (${lineCounts.pay})` },
              { id: 'sale' as const, label: `Sales (${lineCounts.sale})` },
              { id: 'purchase' as const, label: `Purchases (${lineCounts.purchase})` },
            ]).map((c) => (
              <button
                key={c.id}
                className={cx('chip', lineKind === c.id && 'chip-done')}
                onClick={() => setLineKind(lineKind === c.id ? 'all' : c.id)}
              >
                {c.label}
              </button>
            ))}
            {lineKind !== 'all' && statementRows.length > 0 && (
              <span className="mono" style={{ marginLeft: 'auto', fontWeight: 700 }}>
                {formatMoney(Math.abs(shownTotal), cur)}
              </span>
            )}
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
