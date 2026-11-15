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
import {
  buildBankLedger, buildCashLedger, buildPartyLedger, buildRegister, paymentMethodOf, paymentsByParty, paymentsSentence,
} from '@/lib/pdcRegister';
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
  /** Which parties to list: everyone, those money came in from, or those paid. */
  const [side, setSide] = useState<'all' | 'received' | 'paid'>(() => {
    const v = params.get('side');
    // Older links still name the balance sides; they map onto Paid / Received.
    if (v === 'received' || v === 'receivable' || v === 'i-receive') return 'received';
    if (v === 'paid' || v === 'payable' || v === 'i-pay') return 'paid';
    return 'all';
  });
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
   * Money received from, and paid to, each party. The client records an entry
   * only once the payment has been made, so these completed payments — not an
   * outstanding balance — are what the list is built on.
   */
  const payments = useMemo(() => paymentsByParty(data), [data]);
  /** Each party's balance now — the last line of its ledger. */
  const balances = useMemo(() => partyBalances(data), [data]);
  const money = (n: number) => formatMoney(n, cur);
  /** A balance with its sign: + the party has to give you, − you have to give them. */
  const signed = (n: number) =>
    Math.abs(n) < 0.005 ? formatMoney(0, cur) : `${n > 0 ? '+' : '−'}${formatMoney(Math.abs(n), cur)}`;

  const partyRows = useMemo(
    () =>
      data.parties
        .map((p) => ({ party: p, pay: payments.get(p.id) ?? { received: 0, paid: 0, receivedCount: 0, paidCount: 0 } }))
        .sort((a, b) => a.party.name.localeCompare(b.party.name)),
    [data.parties, payments]
  );

  const counts = useMemo(() => ({
    all: partyRows.length,
    received: partyRows.filter((r) => r.pay.receivedCount > 0).length,
    paid: partyRows.filter((r) => r.pay.paidCount > 0).length,
  }), [partyRows]);

  /** Everything received, and everything paid — the two headline figures. */
  const sideTotals = useMemo(() => ({
    received: partyRows.reduce((s, r) => s + r.pay.received, 0),
    paid: partyRows.reduce((s, r) => s + r.pay.paid, 0),
  }), [partyRows]);

  const shownParties = useMemo(() => {
    const bySide =
      side === 'received' ? partyRows.filter((r) => r.pay.receivedCount > 0)
        : side === 'paid' ? partyRows.filter((r) => r.pay.paidCount > 0)
        : partyRows;
    const q = partySearch.trim().toLowerCase();
    return q ? bySide.filter((r) => r.party.name.toLowerCase().includes(q)) : bySide;
  }, [partyRows, side, partySearch]);

  // The balance rides along in the dropdown, so which side a party is on is
  // visible while choosing rather than only after opening the ledger.
  const partyOptions = shownParties.map(({ party, pay }) => ({
    id: party.id,
    label: party.name,
    sub: [pay.received ? `received ${money(pay.received)}` : '', pay.paid ? `paid ${money(pay.paid)}` : '']
      .filter(Boolean).join(' · ') || 'no payments yet',
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
  /**
   * Which chip a statement line belongs to. Money lines go by the way the
   * money moved on THIS account — on a party, a credit is money received from
   * them and a debit is money paid to them; on cash or a bank, a debit is money
   * in. So an entry that passed between two parties is "Received" on one
   * party's ledger and "Paid" on the other's, which is exactly what happened.
   */
  const MONEY_TYPES = ['Cash Received', 'Cash Paid', 'PDC Received', 'PDC Issued', 'Cheque Endorsement'];
  const kindOf = (r: (typeof allStatementRows)[number]): 'receive' | 'pay' | 'sale' | 'purchase' | null => {
    const t = r.txn?.type;
    if (!t) return null;
    if (t === 'Sale') return 'sale';
    if (t === 'Purchase') return 'purchase';
    if (party && !MONEY_TYPES.includes(t)) return null;
    const inbound = party ? r.entry.credit > 0 : r.entry.debit > 0;
    return inbound ? 'receive' : 'pay';
  };
  const statementRows = useMemo(() => {
    if (lineKind === 'all') return allStatementRows;
    return allStatementRows.filter((r) => kindOf(r) === lineKind);
  }, [allStatementRows, lineKind, party]);

  /** Counts per kind, so the chips say what they will show before clicking. */
  const lineCounts = useMemo(() => {
    const c = { all: allStatementRows.length, receive: 0, pay: 0, sale: 0, purchase: 0 };
    for (const r of allStatementRows) {
      const k = kindOf(r);
      if (k) c[k]++;
    }
    return c;
  }, [allStatementRows, party]);

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

      {/* The two questions, answered before anything else: how much will come
          in, and how much must go out. Click one to list those parties. */}
      <div className="owe-boxes no-print">
        <button
          className={cx('owe-box in', side === 'received' && 'on')}
          onClick={() => { setSide(side === 'received' ? 'all' : 'received'); setPartyId(''); }}
        >
          <span className="owe-lbl">Received · Mila</span>
          <span className="owe-val mono">{money(sideTotals.received)}</span>
          <span className="owe-sub">from {formatNumber(counts.received)} parties — tap to see who paid you</span>
        </button>
        <button
          className={cx('owe-box out', side === 'paid' && 'on')}
          onClick={() => { setSide(side === 'paid' ? 'all' : 'paid'); setPartyId(''); }}
        >
          <span className="owe-lbl">Paid · Diya</span>
          <span className="owe-val mono">{money(sideTotals.paid)}</span>
          <span className="owe-sub">to {formatNumber(counts.paid)} parties — tap to see who you paid</span>
        </button>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        {/* Who to list: everyone, the parties money came in from, or the
            parties money went out to. */}
        <div className="quick-filters no-print" style={{ marginBottom: 10 }}>
          {([
            { id: 'all' as const, label: `All Parties (${counts.all})`, hint: '' },
            { id: 'received' as const, label: `Received from (${counts.received})`, hint: money(sideTotals.received) },
            { id: 'paid' as const, label: `Paid to (${counts.paid})`, hint: money(sideTotals.paid) },
          ]).map((c) => (
            <button
              key={c.id}
              className={cx('chip', side === c.id && 'chip-done')}
              title={c.hint ? `Total ${c.hint}` : 'Every party'}
              onClick={() => {
                setSide(c.id);
                // A party not on the chosen list would otherwise stay open and
                // contradict the filter just chosen.
                const p = payments.get(partyId);
                const still = c.id === 'all'
                  || (c.id === 'received' && !!p?.receivedCount)
                  || (c.id === 'paid' && !!p?.paidCount);
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
              {side === 'received' ? 'Parties who paid you'
                : side === 'paid' ? 'Parties you paid'
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
                {side === 'received' ? 'No money has been received from any party yet.'
                  : side === 'paid' ? 'No money has been paid to any party yet.'
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
              {side === 'received' ? 'Parties who paid you'
                : side === 'paid' ? 'Parties you paid'
                : 'All Parties'}
              {' · '}{formatNumber(shownParties.length)}
            </div>
            {/* The total of what is LISTED, so it always agrees with the rows
                above it — a full-side total beside a searched list would not. */}
            {side !== 'all' && (
              <div className="mono" style={{ fontWeight: 700 }}>
                {formatMoney(
                  shownParties.reduce((s, r) => s + (side === 'received' ? r.pay.received : r.pay.paid), 0),
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
                : side === 'received' ? 'No money has been received from any party yet.'
                : side === 'paid' ? 'No money has been paid to any party yet.'
                : 'No parties yet.'}
            </div>
          ) : (
            <div className="table-wrap" style={{ maxHeight: 320 }}>
              <table className="grid stack-sm">
                <thead>
                  <tr>
                    <th>Party</th>
                    {/* Completed payments only: what came in from them, what
                        went out to them. */}
                    <th className="num" title="Money and cheques received from this party">Received</th>
                    <th className="num" title="Money and cheques paid to this party">Paid</th>
                    <th className="num" title="The party's balance after its latest entry">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {shownParties.map(({ party, pay }) => (
                    <tr
                      key={party.id}
                      className={cx('row-link', partyId === party.id && 'row-selected')}
                      style={{ cursor: 'pointer' }}
                      title={`Open ${party.name}'s ledger`}
                      onClick={() => { setPartyId(party.id); setAccountId(''); setShowCash(false); }}
                    >
                      <td data-label="Party"><span className="link-text">{party.name}</span></td>
                      <td data-label="Received" className="num mono pos">
                        {pay.received ? money(pay.received) : '—'}
                        {pay.receivedCount > 0 && <span className="faint"> · {pay.receivedCount}×</span>}
                      </td>
                      <td data-label="Paid" className="num mono neg">
                        {pay.paid ? money(pay.paid) : '—'}
                        {pay.paidCount > 0 && <span className="faint"> · {pay.paidCount}×</span>}
                      </td>
                      <td data-label="Balance" className="num mono">
                        {signed(balances.get(party.id) ?? 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {shownParties.length > 0 && (
            <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>
              Balance after every entry: <strong className="pos">+</strong> means the party has to give you ·{' '}
              <strong className="neg">−</strong> means you have to give the party
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

          {/* A bank account or the cash box, said in one line. */}
          {!party && (
            <div className={cx('owe-banner', ledger.balance >= 0 ? 'in' : 'out')}>
              <div className="owe-banner-say" style={{ marginBottom: cash ? 10 : 0 }}>
                {showCash
                  ? (ledger.balance >= 0
                    ? `Cash in hand: ${money(ledger.balance)}`
                    : `Cash is short by ${money(-ledger.balance)} — some cash going out was never recorded coming in`)
                  : (ledger.balance >= 0
                    ? `You have ${money(ledger.balance)} in ${title}`
                    : `${title} is overdrawn by ${money(-ledger.balance)}`)}
              </div>
              {cash && (
                <div className="owe-banner-math">
                  <div><span className="lbl">Cash came in</span><span className="mono">{money(cash.totalIn)}</span></div>
                  <div className="owe-op">−</div>
                  <div><span className="lbl">Cash went out</span><span className="mono">{money(cash.totalOut)}</span></div>
                  <div className="owe-op">=</div>
                  <div><span className="lbl">In hand now</span><span className="mono">{money(cash.balance)}</span></div>
                </div>
              )}
            </div>
          )}

          {/* What has passed between us and this party, in one line. */}
          {party && (() => {
            const p = payments.get(party.id);
            return (
              <div className="owe-banner">
                <div className="owe-banner-say">{paymentsSentence(party.name, p, money)}</div>
                <div className="owe-banner-math">
                  <div>
                    <span className="lbl">Received from {party.name}</span>
                    <span className="mono pos">{money(p?.received ?? 0)}</span>
                    <span className="faint">{p?.receivedCount ?? 0} payment{p?.receivedCount === 1 ? '' : 's'} in</span>
                  </div>
                  <div>
                    <span className="lbl">Paid to {party.name}</span>
                    <span className="mono neg">{money(p?.paid ?? 0)}</span>
                    <span className="faint">{p?.paidCount ?? 0} payment{p?.paidCount === 1 ? '' : 's'} out</span>
                  </div>
                  <div>
                    <span className="lbl">Balance now</span>
                    <span className="mono">{signed(ledger.balance)}</span>
                    <span className="faint">after the last entry below</span>
                  </div>
                </div>
              </div>
            );
          })()}

          {/* See only the receipts, only the payments, or only the trades on
              this statement. The running balance stays the TRUE balance at
              each line, so this is a selection from the real statement, not a
              recalculated one. */}
          <div className="quick-filters no-print" style={{ margin: '8px 0' }}>
            {([
              { id: 'all' as const, label: `All (${lineCounts.all})` },
              { id: 'receive' as const, label: `Received (${lineCounts.receive})` },
              { id: 'pay' as const, label: `Paid (${lineCounts.pay})` },
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
            {!party && (
              <div>
                <span className="lbl">{showCash ? 'Cash in Hand' : 'Balance'}</span>
                <span className={cx('val', ledger.balance > 0 ? 'pos' : ledger.balance < 0 ? 'neg' : '')}>
                  {formatMoney(ledger.balance, cur)}
                </span>
              </div>
            )}
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
                    {/* Where the money came from and where it went — for cash
                        exactly as for a cheque — so a statement line reads on
                        its own: "Javed → Cash in Hand", "Cash in Hand → Ali". */}
                    <th>From</th><th>To</th>
                    <th className="mid">Cheque #</th><th className="mid">Cheque Date</th>
                    <th>Description</th>
                    {/* On a bank account a debit is money IN and a credit is
                        money OUT, so name them the way a bank statement does. */}
                    <th className="num">{showCash ? 'Cash In' : account ? 'Deposits' : 'Paid / Sold'}</th>
                    <th className="num">{showCash ? 'Cash Out' : account ? 'Withdrawals' : 'Received / Bought'}</th>
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
                    <td data-label="From"><span className="faint">—</span></td>
                    <td data-label="To"><span className="faint">—</span></td>
                    <td data-label="Cheque #" className="mid"><span className="faint">—</span></td>
                    <td data-label="Cheque Date" className="mid"><span className="faint">—</span></td>
                    <td data-label="Description">
                      <strong>{showCash ? 'Opening Cash' : 'Opening Balance'}</strong>
                    </td>
                    <td data-label={showCash ? 'Cash In' : account ? 'Deposits' : 'Paid / Sold'} className="num mono pos">
                      {opening.amount > 0 ? formatMoney(opening.amount, cur) : '—'}
                    </td>
                    <td data-label={showCash ? 'Cash Out' : account ? 'Withdrawals' : 'Received / Bought'} className="num mono neg">
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
                  {statementRows.map(({ entry, txn, cheque, running, from, to }) => (
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
                      <td data-label="From">{from}</td>
                      <td data-label="To">{to}</td>
                      <td data-label="Cheque #" className="mono mid">{cheque?.chequeNumber || '—'}</td>
                      <td data-label="Cheque Date" className="mid">{cheque ? formatDate(cheque.chequeDate) : '—'}</td>
                      <td data-label="Description">{describe(entry, txn)}</td>
                      <td data-label={showCash ? 'Cash In' : account ? 'Deposits' : 'Paid / Sold'} className="num mono pos">{entry.debit ? formatMoney(entry.debit, cur) : '—'}</td>
                      <td data-label={showCash ? 'Cash Out' : account ? 'Withdrawals' : 'Received / Bought'} className="num mono neg">{entry.credit ? formatMoney(entry.credit, cur) : '—'}</td>
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
          {party && ledger.rows.length > 0 && (
            <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>
              Balance after every entry: <strong className="pos">+</strong> means the party has to give you ·{' '}
              <strong className="neg">−</strong> means you have to give the party
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
