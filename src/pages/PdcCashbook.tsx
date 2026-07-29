/**
 * Ali Nawaz PDC — the PDC Cashbook (spec §1, §2, §3)
 *
 * The heart of the software. Summary bar, quick-entry buttons, one powerful
 * search, and the complete transaction register — all on one screen, fully
 * keyboard-driven, with every routine entry opening as a modal over this page
 * rather than navigating away.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '@/components/ui/PageHeader';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Combo } from '@/components/ui/Combo';
import { ConfirmDialog } from '@/components/ui/Modal';
import { PdcForm, type PdcFormKind } from '@/components/pdc/PdcForms';
import { ChequeActionDialog, type ChequeAction } from '@/components/pdc/ChequeActions';
import { DetailsDrawer } from '@/components/pdc/DetailsDrawer';
import { ChequePanel } from '@/components/pdc/ChequePanel';
import { usePdc } from '@/store/pdcStore';
import { computeSummary, bankAccountLabel } from '@/lib/pdcEngine';
import {
  applyFilters,
  buildAlerts,
  buildRegister,
  EMPTY_FILTERS,
  lowBalanceAccounts,
  type RegisterFilters,
} from '@/lib/pdcRegister';
import { bankBalances } from '@/lib/pdcEngine';
import type { PdcTxnType, RegisterRow, SummaryFilter } from '@/types/pdc';
import { formatMoney, formatDate, formatNumber, todayISO, cx } from '@/lib/utils';
import { toast } from '@/store/toast';
import './pdc.css';

const TXN_TYPES: Array<PdcTxnType | 'all'> = [
  'all', 'Sale', 'Purchase', 'Expense', 'Income',
  'PDC Received', 'PDC Issued', 'Cash Received', 'Cash Paid',
  'Debit Adjustment', 'Credit Adjustment', 'Party Transfer', 'Cheque Endorsement',
  'Bank Transfer', 'Cheque Deposited', 'Cheque Cleared', 'Cheque Bounced', 'Reversal',
];

const STATUSES = [
  'all', 'pending', 'transferred', 'deposited', 'presented',
  'cleared', 'bounced', 'returned', 'cancelled', 'replaced',
];

/**
 * Entry buttons grouped by purpose. `in` = money/value coming toward you,
 * `out` = going away — so the colour always means the same thing.
 */
interface EntryButton {
  kind: NonNullable<PdcFormKind>;
  label: string;
  icon: IconName;
  key?: string;
  variant: string;
  title: string;
}

const ENTRY_GROUPS: Array<{ label: string; buttons: EntryButton[] }> = [
  {
    label: 'Trading',
    buttons: [
      { kind: 'sale', label: 'Sale', icon: 'trend-up', key: 'F1', variant: 'in', title: 'Record goods or services sold' },
      { kind: 'purchase', label: 'Purchase', icon: 'trend-down', key: 'F2', variant: 'out', title: 'Record goods or services bought' },
    ],
  },
  {
    label: 'Cash',
    buttons: [
      { kind: 'cash-received', label: 'Received', icon: 'arrow-down', key: 'F3', variant: 'in', title: 'Money received from a party' },
      { kind: 'cash-paid', label: 'Paid', icon: 'arrow-up', key: 'F4', variant: 'out', title: 'Money paid to a party' },
    ],
  },
  {
    label: 'Cheques',
    buttons: [
      { kind: 'pdc-received', label: 'Cheque In', icon: 'cheque-in', key: 'F5', variant: 'in', title: 'Cheque received from a party' },
      { kind: 'pdc-issued', label: 'Cheque Out', icon: 'cheque-out', key: 'F6', variant: 'out', title: 'Cheque issued to a party' },
      { kind: 'cheque-transfer', label: 'Transfer', icon: 'transfer', key: 'F7', variant: 'accent-purple', title: 'Endorse a received cheque to another party' },
    ],
  },
  {
    label: 'Costs & Adjustments',
    buttons: [
      { kind: 'expense', label: 'Expense', icon: 'receipt', variant: 'accent-orange', title: 'Rent, salary, fuel and other running costs' },
      { kind: 'income', label: 'Income', icon: 'coins', variant: 'accent-orange', title: 'Money earned that is not a sale' },
      { kind: 'debit', label: 'Debit', icon: 'receivable', variant: 'accent-slate', title: 'Increase what a party owes you' },
      { kind: 'credit', label: 'Credit', icon: 'payable', variant: 'accent-slate', title: 'Increase what you owe a party' },
      { kind: 'party-transfer', label: 'Party Transfer', icon: 'transfer', variant: 'accent-blue', title: 'Move a balance between two parties' },
      { kind: 'bank-transfer', label: 'Bank Transfer', icon: 'bank', variant: 'accent-blue', title: 'Move money between your own accounts' },
    ],
  },
];

export function PdcCashbook() {
  const store = usePdc();
  const data = store.dataset();
  const cur = data.settings.currency;
  const navigate = useNavigate();
  const today = todayISO();

  const [form, setForm] = useState<PdcFormKind>(null);
  const [formParty, setFormParty] = useState('');
  const [formCheque, setFormCheque] = useState('');
  const [selParty, setSelParty] = useState('');
  const [filters, setFilters] = useState<RegisterFilters>(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [selected, setSelected] = useState(-1);
  const [detail, setDetail] = useState<RegisterRow | null>(null);
  const [chequeAction, setChequeAction] = useState<{ id: string; action: ChequeAction }>({ id: '', action: null });
  const [toReverse, setToReverse] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  const register = useMemo(() => buildRegister(data), [data]);
  const shown = useMemo(() => applyFilters(register, filters, today), [register, filters, today]);
  const summary = useMemo(() => computeSummary(data, today), [data, today]);
  const alerts = useMemo(() => buildAlerts(data, today), [data, today]);
  const lowBalance = useMemo(
    () => (data.settings.lowBalanceWarnings ? lowBalanceAccounts(data, bankBalances(data), today) : []),
    [data, today]
  );

  const openForm = (kind: PdcFormKind) => {
    setFormParty(selParty);
    setFormCheque('');
    setForm(kind);
  };

  // --- keyboard: F-keys + row navigation (spec §3, §25) --------------------
  useEffect(() => {
    const held = new Set<string>();

    const typingIn = (el: Element | null) => {
      const tag = (el as HTMLElement)?.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
        (el as HTMLElement)?.isContentEditable;
    };

    const onKey = (e: KeyboardEvent) => {
      const active = document.activeElement;
      const modalOpen = !!document.querySelector('.modal, .combo-pop');
      const mod = e.ctrlKey || e.metaKey;

      // Ctrl+F / Ctrl+K — focus search from anywhere.
      if (mod && (e.key.toLowerCase() === 'f' || e.key.toLowerCase() === 'k')) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }

      // Function keys open the entry forms (spec §2). Blocked while a modal is
      // open so the form's own keyboard flow is never hijacked.
      const fnMap: Record<string, () => void> = {
        F1: () => openForm('sale'),
        F2: () => openForm('purchase'),
        F3: () => openForm('cash-received'),
        F4: () => openForm('cash-paid'),
        F5: () => openForm('pdc-received'),
        F6: () => openForm('pdc-issued'),
        F7: () => openForm('cheque-transfer'),
        F8: () => navigate('/ledger'),
        F9: () => searchRef.current?.focus(),
        F10: () => navigate('/reports'),
      };
      if (e.key in fnMap) {
        e.preventDefault(); // block browser Help/find
        if (modalOpen && e.key !== 'F9') return;
        if (e.repeat || held.has(e.key)) return; // fire once per physical press
        held.add(e.key);
        fnMap[e.key]();
        return;
      }

      // Row navigation only when not typing and no dialog is open.
      if (modalOpen || typingIn(active)) return;
      if (shown.length === 0) return;
      const last = shown.length - 1;

      switch (e.key) {
        case 'ArrowDown': e.preventDefault(); setSelected((s) => Math.min(s < 0 ? 0 : s + 1, last)); break;
        case 'ArrowUp': e.preventDefault(); setSelected((s) => Math.max(s <= 0 ? 0 : s - 1, 0)); break;
        case 'PageDown': e.preventDefault(); setSelected((s) => Math.min((s < 0 ? 0 : s) + 10, last)); break;
        case 'PageUp': e.preventDefault(); setSelected((s) => Math.max((s < 0 ? 0 : s) - 10, 0)); break;
        case 'Home': e.preventDefault(); setSelected(0); break;
        case 'End': e.preventDefault(); setSelected(last); break;
        case 'Enter':
          if (selected >= 0) { e.preventDefault(); setDetail(shown[selected]); }
          break;
        // Delete removes the entry outright (for typos). Shift+Delete posts a
        // reversing entry instead, keeping both sides in history.
        case 'Delete':
        case 'Backspace':
          if (selected >= 0) {
            e.preventDefault();
            if (e.shiftKey) setToReverse(shown[selected].txn.id);
            else setToDelete(shown[selected].txn.id);
          }
          break;
      }
    };

    const onUp = (e: KeyboardEvent) => held.delete(e.key);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onUp);
    };
  }, [shown, selected, selParty, navigate]);

  // Keep the selected row in view (spec §3).
  useEffect(() => {
    if (selected < 0) return;
    tableRef.current?.querySelector('tr.row-selected')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  // Clamp the selection when filtering shrinks the list.
  useEffect(() => {
    setSelected((s) => (s >= shown.length ? shown.length - 1 : s));
  }, [shown.length]);

  const partyOptions = data.parties.filter((p) => p.active).map((p) => ({ id: p.id, label: p.name }));
  const accountOptions = data.bankAccounts
    .filter((a) => a.active)
    .map((a) => ({ id: a.id, label: bankAccountLabel(data.banks, data.bankAccounts, a.id) }));

  const setCard = (card: SummaryFilter) =>
    setFilters((f) => ({ ...f, card: f.card === card ? 'all' : card }));

  /**
   * The four numbers that matter day to day. Everything else (cheque ageing,
   * sales/purchase/expense splits) lives in Reports rather than cluttering the
   * working screen. Clicking a card filters the register below.
   */
  const cards: Array<{
    key: SummaryFilter; label: string; value: number; tone?: string; hint?: string;
  }> = [
    {
      key: 'all',
      label: 'Total Cheques',
      value: summary.totalCheques,
      tone: 'hero',
      hint: `${summary.totalChequeCount} outstanding`,
    },
    { key: 'expenses', label: 'Expenses', value: summary.totalExpenses, tone: 'neg' },
    { key: 'receivable', label: 'Receivable', value: summary.totalReceivable, tone: 'pos' },
    {
      key: 'all',
      label: summary.netProfit >= 0 ? 'Profit' : 'Loss',
      value: Math.abs(summary.netProfit),
      tone: summary.netProfit >= 0 ? 'pos' : 'neg',
    },
  ];

  const activeFilterCount =
    (filters.type !== 'all' ? 1 : 0) + (filters.status !== 'all' ? 1 : 0) +
    (filters.partyId ? 1 : 0) + (filters.bankAccountId ? 1 : 0) +
    (filters.from ? 1 : 0) + (filters.to ? 1 : 0) + (filters.card !== 'all' ? 1 : 0);

  const doReverse = async () => {
    const id = toReverse;
    setToReverse(null);
    if (!id) return;
    await store.reverse(id);
    setDetail(null);
  };

  const doDelete = async () => {
    const id = toDelete;
    setToDelete(null);
    if (!id) return;
    // The Firestore subscription pushes the removal straight back, so the row
    // disappears from the register as soon as the write lands.
    if (await store.deleteTransaction(id)) setDetail(null);
  };

  const printRow = (row: RegisterRow) => {
    // Printing a single voucher reuses the browser print of the details panel.
    toast.info(`Use Reports (F10) for full statements · ${row.txn.reference}`);
    window.print();
  };

  const activeCheque = data.cheques.find((c) => c.id === chequeAction.id) ?? null;

  return (
    <div className="pdc-page">
      <PageHeader
        title="Cash Book"
        subtitle="Sales, purchases, cheques, payments & ledgers — one screen"
      />

      {/* --- Alerts (spec §24) --- */}
      {(alerts.length > 0 || lowBalance.length > 0) && (
        <div className="pdc-alerts no-print">
          {alerts.map((a) => (
            <button
              key={a.kind}
              className={cx('pdc-alert', a.severity)}
              onClick={() => {
                if (a.kind === 'due-today') setCard('due-today');
                else if (a.kind === 'overdue') setCard('overdue');
                else if (a.kind === 'bounced') setCard('bounced');
              }}
            >
              <Icon name="alert-circle" size={14} />
              <span>{a.message}</span>
              <span className="mono">{formatMoney(a.amount, cur)}</span>
            </button>
          ))}
          {lowBalance.map((b) => (
            <div key={b.accountId} className="pdc-alert danger">
              <Icon name="alert-circle" size={14} />
              <span>{b.label}: balance {formatMoney(b.balance, cur)} below {formatMoney(b.upcoming, cur)} due</span>
            </div>
          ))}
        </div>
      )}

      {/* --- Summary bar: the four day-to-day numbers --- */}
      <div className="pdc-cards pdc-cards-main">
        {cards.map((c, ci) => (
          <button
            key={`${c.label}-${ci}`}
            className={cx('pdc-card', c.tone, c.key !== 'all' && filters.card === c.key && 'active')}
            onClick={() => c.key !== 'all' && setCard(c.key)}
            title={c.hint}
          >
            <span className="pdc-card-label">{c.label}</span>
            <span className="pdc-card-value mono">{formatMoney(c.value, cur)}</span>
            {c.hint && <span className="pdc-card-hint">{c.hint}</span>}
          </button>
        ))}
      </div>

      {/* --- Quick entry (spec §2) --- */}
      <div className="card pdc-entry no-print">
        <div className="pdc-entry-row">
          <div className="field pdc-entry-party">
            <label>Party <span className="faint">(pre-fills the form)</span></label>
            <Combo
              value={selParty}
              options={partyOptions}
              placeholder="Select or create a party"
              allowCreate
              onChange={setSelParty}
              onCreate={async (name) => (await store.saveParty({ name }))?.id ?? ''}
            />
          </div>
          {/* Entry buttons grouped by what they do, so the right one is easy
              to find: trading · cash · cheques · other. */}
          <div className="pdc-entry-groups">
            {ENTRY_GROUPS.map((g) => (
              <div key={g.label} className="pdc-btn-group">
                <span className="pdc-btn-group-label">{g.label}</span>
                <div className="pdc-btn-row">
                  {g.buttons.map((b) => (
                    <button
                      key={b.kind}
                      className={cx('pdc-btn', b.variant)}
                      onClick={() => openForm(b.kind)}
                      title={b.title}
                    >
                      <Icon name={b.icon} size={16} />
                      {b.label}
                      {b.key && <kbd>{b.key}</kbd>}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* --- Search & filters (spec §2) --- */}
      <div className="card pdc-search-card no-print">
        <div className="pdc-search-row">
          <div className="pdc-search-box">
            <Icon name="search" size={16} />
            <input
              ref={searchRef}
              className="input"
              placeholder="Search party, cheque no, bank, reference, amount, date, status…  (F9)"
              value={filters.search}
              onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { e.currentTarget.blur(); setFilters((f) => ({ ...f, search: '' })); }
                if (e.key === 'ArrowDown') { e.preventDefault(); e.currentTarget.blur(); setSelected(0); }
              }}
            />
          </div>
          <button
            className={cx('btn', activeFilterCount > 0 && 'btn-primary')}
            onClick={() => setShowFilters((v) => !v)}
          >
            <Icon name="filter" size={15} /> Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
          </button>
          {activeFilterCount > 0 && (
            <button className="btn btn-ghost" onClick={() => setFilters({ ...EMPTY_FILTERS, search: filters.search })}>
              Clear
            </button>
          )}
        </div>

        {showFilters && (
          <div className="pdc-filter-grid">
            <div className="field">
              <label>Type</label>
              <select
                className="input"
                value={filters.type}
                onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value as any }))}
              >
                {TXN_TYPES.map((t) => <option key={t} value={t}>{t === 'all' ? 'All types' : t}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Status</label>
              <select
                className="input"
                value={filters.status}
                onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}
              >
                {STATUSES.map((s) => <option key={s} value={s}>{s === 'all' ? 'All statuses' : s}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Party</label>
              <Combo
                value={filters.partyId}
                options={[{ id: '', label: 'All parties' }, ...partyOptions]}
                placeholder="All parties"
                onChange={(v) => setFilters((f) => ({ ...f, partyId: v }))}
              />
            </div>
            <div className="field">
              <label>Bank Account</label>
              <Combo
                value={filters.bankAccountId}
                options={[{ id: '', label: 'All accounts' }, ...accountOptions]}
                placeholder="All accounts"
                onChange={(v) => setFilters((f) => ({ ...f, bankAccountId: v }))}
              />
            </div>
            <div className="field">
              <label>From</label>
              <input className="input" type="date" value={filters.from}
                onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} />
            </div>
            <div className="field">
              <label>To</label>
              <input className="input" type="date" value={filters.to}
                onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} />
            </div>
          </div>
        )}
      </div>

      {/* --- Every cheque, in and out, visible without leaving this screen --- */}
      <ChequePanel
        today={today}
        onOpen={(chequeId) => {
          // Jump to the row that created this cheque so the drawer shows its
          // full accounting effect and movement timeline.
          const row = register.find((r) => r.cheque?.id === chequeId);
          if (row) setDetail(row);
        }}
      />

      {/* --- Transaction register (spec §3) --- */}
      <div className="card pdc-register-card">
        <div className="pdc-register-head">
          <div className="stmt-title" style={{ margin: 0 }}>
            Transactions · {formatNumber(shown.length)}
            {shown.length !== register.length && <span className="faint"> of {formatNumber(register.length)}</span>}
          </div>
          <div className="faint pdc-keyhint no-print">
            ↑↓ move · Enter details · Del delete · Shift+Del reverse
          </div>
        </div>

        {shown.length === 0 ? (
          <div className="empty">
            {register.length === 0
              ? <>No transactions yet. Press <strong>F1</strong> to record a received cheque, or <strong>F3</strong> for a cash receipt.</>
              : <>No transactions match the current search or filters.</>}
          </div>
        ) : (
          <div className="table-wrap pdc-table-wrap" ref={tableRef}>
            {/* stack-sm turns each row into a labelled card on phones, so the
                15-column register never forces horizontal page scrolling. */}
            <table className="grid pdc-grid stack-sm">
              <thead>
                <tr>
                  {/* Reading order: WHEN → WHAT → WHO → DETAILS → MONEY → STATUS.
                      Money columns sit together just before status, so the eye
                      lands on Debit / Credit / Balance as one block. */}
                  <th>Date</th><th>Reference</th><th>Type</th>
                  <th>From Party</th><th>To Party</th>
                  <th>Cheque #</th><th>Due Date</th><th>Bank</th>
                  <th>Description</th>
                  <th className="num">Debit</th><th className="num">Credit</th>
                  <th className="num">Balance</th>
                  <th>Status</th><th>Holder</th>
                  <th className="no-print"></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((row, idx) => {
                  const { txn, cheque } = row;
                  return (
                    <tr
                      key={txn.id}
                      className={cx(idx === selected && 'row-selected', txn.reversed && 'row-reversed')}
                      onClick={() => setSelected(idx)}
                      onDoubleClick={() => setDetail(row)}
                    >
                      <td data-label="Date">{formatDate(txn.date)}</td>
                      <td data-label="Reference" className="mono">{txn.reference}</td>
                      <td data-label="Type"><span className="pdc-type">{txn.type}</span></td>
                      <td data-label="From Party">{row.partyName || '—'}</td>
                      <td data-label="To Party">{row.toPartyName || '—'}</td>
                      <td data-label="Cheque #" className="mono">{cheque?.chequeNumber ?? '—'}</td>
                      <td data-label="Due Date">{cheque ? formatDate(cheque.chequeDate) : '—'}</td>
                      <td data-label="Bank">{row.bankLabel || '—'}</td>
                      <td data-label="Description">{txn.description || '—'}</td>
                      <td data-label="Debit" className="num mono pos">{row.debit ? formatMoney(row.debit, cur) : '—'}</td>
                      <td data-label="Credit" className="num mono neg">{row.credit ? formatMoney(row.credit, cur) : '—'}</td>
                      <td data-label="Balance" className={cx('num mono stmt-bal', row.running >= 0 ? 'pos' : 'neg')}>
                        {formatMoney(row.running, cur)}
                      </td>
                      <td data-label="Status">
                        {row.status
                          ? <span className={cx('pdc-status', `st-${row.status}`)}>{row.status}</span>
                          : <span className="faint">—</span>}
                      </td>
                      <td data-label="Holder">{row.holderLabel || '—'}</td>
                      <td className="no-print actions-cell">
                        <div className="row" style={{ gap: 2, justifyContent: 'flex-end' }}>
                          <button className="btn btn-ghost btn-icon btn-sm" title="Details (Enter)"
                            onClick={(e) => { e.stopPropagation(); setDetail(row); }}>
                            <Icon name="eye" size={14} />
                          </button>
                          {!txn.reversed && (
                            <button className="btn btn-ghost btn-icon btn-sm" title="Reverse — keeps both entries (Shift+Del)"
                              onClick={(e) => { e.stopPropagation(); setToReverse(txn.id); }}>
                              <Icon name="undo" size={14} />
                            </button>
                          )}
                          <button className="btn btn-ghost btn-icon btn-sm del-btn" title="Delete permanently (Del)"
                            onClick={(e) => { e.stopPropagation(); setToDelete(txn.id); }}>
                            <Icon name="trash" size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <PdcForm kind={form} defaultParty={formParty} defaultCheque={formCheque} onClose={() => setForm(null)} />

      <DetailsDrawer
        row={detail}
        onClose={() => setDetail(null)}
        onReverse={(id) => setToReverse(id)}
        onDelete={(id) => setToDelete(id)}
        onPrint={printRow}
        onChequeAction={(id, action) => setChequeAction({ id, action })}
      />

      <ChequeActionDialog
        action={chequeAction.action}
        cheque={activeCheque}
        onClose={() => setChequeAction({ id: '', action: null })}
      />

      <ConfirmDialog
        open={!!toReverse}
        title="Reverse this transaction?"
        message="A balanced reversing entry is posted. Both the original and the reversal stay visible in history, and all linked ledgers are corrected together."
        confirmLabel="Reverse"
        danger
        onConfirm={doReverse}
        onCancel={() => setToReverse(null)}
      />

      <ConfirmDialog
        open={!!toDelete}
        title="Delete this entry permanently?"
        message="The entry, its ledger effect and any cheque it created are removed completely — balances update immediately. Nothing is left in the register. The audit trail keeps a record of what was deleted. Use Reverse instead if the entry really happened and you only need to correct it."
        confirmLabel="Delete"
        danger
        onConfirm={doDelete}
        onCancel={() => setToDelete(null)}
      />
    </div>
  );
}
