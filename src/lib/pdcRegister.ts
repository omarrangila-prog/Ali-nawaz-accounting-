/**
 * Ali Nawaz PDC — Register projection, search and filters
 *
 * Pure read-side helpers that turn the raw dataset into the rows the Cashbook
 * shows. Every screen and report reads through here, so nothing can compute a
 * balance a different way (spec §31.11, §31.12).
 */

import type {
  Cheque,
  PdcDataSet,
  PdcLedgerEntry,
  PdcTransaction,
  PdcTxnType,
  RegisterRow,
  SummaryFilter,
} from '@/types/pdc';
import type { ISODate } from '@/types';
import { bankAccountLabel, holderLabel, isFundsAccount, partyName } from '@/lib/pdcEngine';
import { round2 } from '@/lib/utils';

/**
 * Signed effect of a transaction on combined cash + bank funds. Used for the
 * register's running balance column. A bank transfer nets to zero (money moves
 * between our own accounts), which is why it returns 0 despite being a money
 * type.
 */
export function fundsDelta(data: PdcDataSet, txn: PdcTransaction): number {
  if (txn.reversed) return 0;
  let delta = 0;
  for (const l of data.ledger) {
    if (l.txnId !== txn.id) continue;
    // Only real money counts — nominal (P&L) and cheque-custody accounts don't.
    if (isFundsAccount(l.account)) delta += l.debit - l.credit;
  }
  return round2(delta);
}

/** Debit / credit totals for a transaction, from its ledger lines. */
/**
 * Debit / credit shown on a register row.
 *
 * A balanced posting always has total debit === total credit, so summing every
 * line would print the same figure in both columns and tell the reader nothing.
 * Instead the register reports the entry's effect on the accounts the user
 * actually cares about:
 *
 *   • if the entry moves cash or bank, show that movement
 *     (money in → Debit, money out → Credit)
 *   • otherwise show its effect on the party's balance
 *     (party owes more → Debit, we owe more → Credit)
 *
 * That makes Debit and Credit mutually exclusive on a row, which is how a
 * cash book is read.
 */
export function txnTotals(
  data: PdcDataSet,
  txnId: string
): { debit: number; credit: number } {
  let funds = 0;
  let party = 0;
  for (const l of data.ledger) {
    if (l.txnId !== txnId) continue;
    if (isFundsAccount(l.account)) funds += l.debit - l.credit;
    else if (l.account.kind === 'party') party += l.debit - l.credit;
  }
  const net = funds !== 0 ? funds : party;
  return {
    debit: net > 0 ? round2(net) : 0,
    credit: net < 0 ? round2(-net) : 0,
  };
}

/**
 * Build the full register in DISPLAY order (newest first) with a running
 * cash+bank balance accumulated chronologically, so each row carries the
 * balance as at that row.
 */
export function buildRegister(data: PdcDataSet): RegisterRow[] {
  const chrono = [...data.transactions].sort(
    (a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt
  );
  const chequeById = new Map(data.cheques.map((c) => [c.id, c]));

  // Start from the money that already existed before any transaction — the
  // bank accounts' opening balances. Starting at zero would make the Balance
  // column disagree with the "Total Money" card by exactly that amount.
  let running = data.bankAccounts.reduce((sum, a) => sum + a.openingBalance, 0);
  const rows: RegisterRow[] = chrono.map((txn) => {
    running += fundsDelta(data, txn);
    const { debit, credit } = txnTotals(data, txn.id);
    const cheque = txn.chequeId ? chequeById.get(txn.chequeId) : undefined;
    return {
      txn,
      debit,
      credit,
      running: round2(running),
      cheque,
      partyName: partyName(data, txn.partyId),
      toPartyName: partyName(data, txn.toPartyId),
      bankLabel: bankAccountLabel(
        data.banks,
        data.bankAccounts,
        txn.fromBankAccountId || txn.toBankAccountId
      ),
      status: cheque?.status,
      holderLabel: cheque ? holderLabel(data, cheque.holder) : '',
    };
  });

  return rows.reverse();
}

// ---------------------------------------------------------------------------
// Search (spec §2)
// ---------------------------------------------------------------------------

/**
 * One search box across every field an accountant might recall: party, cheque
 * number, bank, reference, amount, dates, description, status and type.
 */
export function matchesSearch(row: RegisterRow, raw: string): boolean {
  const q = raw.trim().toLowerCase();
  if (!q) return true;
  const c = row.cheque;
  const haystack = [
    row.txn.reference,
    row.txn.type,
    row.txn.description,
    row.txn.date,
    row.partyName,
    row.toPartyName,
    row.bankLabel,
    row.holderLabel,
    row.status,
    c?.chequeNumber,
    c?.chequeDate,
    c?.drawerName,
    c?.accountNumber,
    c?.branch,
    String(row.txn.amount),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  // Every whitespace-separated term must appear, so "ahmed 1001" narrows.
  return q.split(/\s+/).every((term) => haystack.includes(term));
}

// ---------------------------------------------------------------------------
// Filters (spec §2)
// ---------------------------------------------------------------------------

export interface RegisterFilters {
  search: string;
  /** Summary-card filter. */
  card: SummaryFilter;
  /** Transaction type, or 'all'. */
  type: PdcTxnType | 'all';
  status: string;
  partyId: string;
  bankAccountId: string;
  from: string;
  to: string;
}

export const EMPTY_FILTERS: RegisterFilters = {
  search: '',
  card: 'all',
  type: 'all',
  status: 'all',
  partyId: '',
  bankAccountId: '',
  from: '',
  to: '',
};

/** Does a cheque count as still outstanding? */
function isLive(c: Cheque): boolean {
  return c.status === 'pending' || c.status === 'deposited' || c.status === 'presented';
}

function matchesCard(row: RegisterRow, card: SummaryFilter, today: ISODate): boolean {
  const c = row.cheque;
  switch (card) {
    case 'all': return true;
    case 'receivable': return row.txn.type === 'PDC Received' || row.txn.type === 'Debit Adjustment';
    case 'payable': return row.txn.type === 'PDC Issued' || row.txn.type === 'Credit Adjustment';
    case 'pending-received': return !!c && c.direction === 'received' && isLive(c);
    case 'pending-issued': return !!c && c.direction === 'issued' && isLive(c);
    case 'due-today': return !!c && isLive(c) && c.chequeDate === today;
    case 'overdue': return !!c && isLive(c) && c.chequeDate < today;
    case 'cleared': return c?.status === 'cleared';
    case 'bounced': return c?.status === 'bounced';
    case 'cash': return row.txn.type === 'Cash Received' || row.txn.type === 'Cash Paid';
    case 'bank': return row.txn.type === 'Bank Transfer' || !!row.txn.fromBankAccountId || !!row.txn.toBankAccountId;
    case 'sales': return row.txn.type === 'Sale';
    case 'purchases': return row.txn.type === 'Purchase';
    case 'expenses': return row.txn.type === 'Expense' || row.txn.type === 'Income';
  }
}

export function applyFilters(
  rows: RegisterRow[],
  f: RegisterFilters,
  today: ISODate
): RegisterRow[] {
  return rows.filter((row) => {
    if (!matchesCard(row, f.card, today)) return false;
    if (f.type !== 'all' && row.txn.type !== f.type) return false;
    if (f.status !== 'all' && row.status !== f.status) return false;
    if (f.partyId && row.txn.partyId !== f.partyId && row.txn.toPartyId !== f.partyId) return false;
    if (
      f.bankAccountId &&
      row.txn.fromBankAccountId !== f.bankAccountId &&
      row.txn.toBankAccountId !== f.bankAccountId &&
      row.cheque?.bankAccountId !== f.bankAccountId
    ) return false;
    if (f.from && row.txn.date < f.from) return false;
    if (f.to && row.txn.date > f.to) return false;
    if (!matchesSearch(row, f.search)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Party ledger (spec §5)
// ---------------------------------------------------------------------------

export interface PartyLedgerRow {
  entry: PdcLedgerEntry;
  txn?: PdcTransaction;
  cheque?: Cheque;
  running: number;
  relatedName: string;
  bankLabel: string;
}

/**
 * A party's ledger with a running receivable(+)/payable(−) balance, oldest
 * first for accumulation then reversed for display.
 */
export function buildPartyLedger(
  data: PdcDataSet,
  partyId: string
): { rows: PartyLedgerRow[]; balance: number } {
  const party = data.parties.find((p) => p.id === partyId);
  const entries = data.ledger
    .filter((l) => l.account.kind === 'party' && l.account.id === partyId)
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt);

  const txnById = new Map(data.transactions.map((t) => [t.id, t]));
  const chequeById = new Map(data.cheques.map((c) => [c.id, c]));

  let running = party?.openingBalance ?? 0;
  const rows: PartyLedgerRow[] = entries.map((entry) => {
    running += entry.debit - entry.credit;
    return {
      entry,
      txn: txnById.get(entry.txnId),
      cheque: entry.chequeId ? chequeById.get(entry.chequeId) : undefined,
      running: round2(running),
      relatedName: partyName(data, entry.relatedPartyId),
      bankLabel: bankAccountLabel(data.banks, data.bankAccounts, entry.relatedBankAccountId),
    };
  });

  return { rows: rows.reverse(), balance: round2(running) };
}

/** A bank account's ledger, same shape as the party ledger. */
export function buildBankLedger(
  data: PdcDataSet,
  bankAccountId: string
): { rows: PartyLedgerRow[]; balance: number } {
  const account = data.bankAccounts.find((a) => a.id === bankAccountId);
  const entries = data.ledger
    .filter((l) => l.account.kind === 'bank' && l.account.id === bankAccountId)
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt);

  const txnById = new Map(data.transactions.map((t) => [t.id, t]));
  const chequeById = new Map(data.cheques.map((c) => [c.id, c]));

  let running = account?.openingBalance ?? 0;
  const rows: PartyLedgerRow[] = entries.map((entry) => {
    running += entry.debit - entry.credit;
    return {
      entry,
      txn: txnById.get(entry.txnId),
      cheque: entry.chequeId ? chequeById.get(entry.chequeId) : undefined,
      running: round2(running),
      relatedName: partyName(data, entry.relatedPartyId),
      bankLabel: '',
    };
  });

  return { rows: rows.reverse(), balance: round2(running) };
}

// ---------------------------------------------------------------------------
// Receivable / payable views (spec §11, §12)
// ---------------------------------------------------------------------------

export interface ChequeRow {
  cheque: Cheque;
  partyName: string;
  bankName: string;
  holderLabel: string;
  /** Days until the cheque date; negative when overdue. */
  daysToDue: number;
  remaining: number;
}

function daysBetween(a: ISODate, b: ISODate): number {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Math.round(ms / 86400000);
}

export function buildChequeRows(
  data: PdcDataSet,
  direction: 'received' | 'issued',
  today: ISODate
): ChequeRow[] {
  return data.cheques
    .filter((c) => c.direction === direction)
    .sort((a, b) => a.chequeDate.localeCompare(b.chequeDate))
    .map((cheque) => ({
      cheque,
      partyName: partyName(data, cheque.partyId),
      bankName: data.banks.find((b) => b.id === cheque.bankId)?.name ?? '—',
      holderLabel: holderLabel(data, cheque.holder),
      daysToDue: daysBetween(today, cheque.chequeDate),
      remaining: round2(cheque.amount - (cheque.allocatedAmount || 0)),
    }));
}

// ---------------------------------------------------------------------------
// Dashboard alerts (spec §24)
// ---------------------------------------------------------------------------

export interface PdcAlert {
  kind: 'due-today' | 'due-tomorrow' | 'overdue' | 'due-week' | 'bounced' | 'unallocated' | 'low-balance';
  severity: 'info' | 'warn' | 'danger';
  message: string;
  count: number;
  amount: number;
}

export function buildAlerts(data: PdcDataSet, today: ISODate): PdcAlert[] {
  const alerts: PdcAlert[] = [];
  const live = data.cheques.filter(isLive);

  const bucket = (test: (c: Cheque) => boolean) => {
    const list = live.filter(test);
    return { count: list.length, amount: round2(list.reduce((s, c) => s + c.amount, 0)) };
  };

  const overdue = bucket((c) => c.chequeDate < today);
  if (overdue.count) {
    alerts.push({ kind: 'overdue', severity: 'danger', count: overdue.count, amount: overdue.amount,
      message: `${overdue.count} overdue cheque${overdue.count > 1 ? 's' : ''}` });
  }

  const dueToday = bucket((c) => c.chequeDate === today);
  if (dueToday.count) {
    alerts.push({ kind: 'due-today', severity: 'warn', count: dueToday.count, amount: dueToday.amount,
      message: `${dueToday.count} cheque${dueToday.count > 1 ? 's' : ''} due today` });
  }

  const tomorrow = new Date(new Date(today).getTime() + 86400000).toISOString().slice(0, 10);
  const dueTomorrow = bucket((c) => c.chequeDate === tomorrow);
  if (dueTomorrow.count) {
    alerts.push({ kind: 'due-tomorrow', severity: 'info', count: dueTomorrow.count, amount: dueTomorrow.amount,
      message: `${dueTomorrow.count} cheque${dueTomorrow.count > 1 ? 's' : ''} due tomorrow` });
  }

  const week = new Date(new Date(today).getTime() + 7 * 86400000).toISOString().slice(0, 10);
  const dueWeek = bucket((c) => c.chequeDate > tomorrow && c.chequeDate <= week);
  if (dueWeek.count) {
    alerts.push({ kind: 'due-week', severity: 'info', count: dueWeek.count, amount: dueWeek.amount,
      message: `${dueWeek.count} cheque${dueWeek.count > 1 ? 's' : ''} due within 7 days` });
  }

  const bounced = data.cheques.filter((c) => c.status === 'bounced' && !c.replacedByChequeId);
  if (bounced.length) {
    alerts.push({ kind: 'bounced', severity: 'danger', count: bounced.length,
      amount: round2(bounced.reduce((s, c) => s + c.amount, 0)),
      message: `${bounced.length} bounced cheque${bounced.length > 1 ? 's' : ''} need action` });
  }

  const unallocated = data.cheques.filter(
    (c) => c.direction === 'received' && c.status === 'pending' && (c.allocatedAmount || 0) === 0
  );
  if (unallocated.length) {
    alerts.push({ kind: 'unallocated', severity: 'info', count: unallocated.length,
      amount: round2(unallocated.reduce((s, c) => s + c.amount, 0)),
      message: `${unallocated.length} received cheque${unallocated.length > 1 ? 's' : ''} not yet allocated` });
  }

  return alerts;
}

/**
 * Bank accounts whose balance can't cover the issued cheques due against them
 * in the next 7 days (spec §24).
 */
export function lowBalanceAccounts(
  data: PdcDataSet,
  balances: Map<string, number>,
  today: ISODate
): Array<{ accountId: string; label: string; balance: number; upcoming: number }> {
  const week = new Date(new Date(today).getTime() + 7 * 86400000).toISOString().slice(0, 10);
  const out: Array<{ accountId: string; label: string; balance: number; upcoming: number }> = [];

  for (const acc of data.bankAccounts) {
    const upcoming = data.cheques
      .filter(
        (c) =>
          c.direction === 'issued' &&
          c.bankAccountId === acc.id &&
          isLive(c) &&
          c.chequeDate <= week
      )
      .reduce((s, c) => s + c.amount, 0);
    const balance = balances.get(acc.id) ?? 0;
    if (upcoming > 0 && balance < upcoming) {
      out.push({
        accountId: acc.id,
        label: bankAccountLabel(data.banks, data.bankAccounts, acc.id),
        balance: round2(balance),
        upcoming: round2(upcoming),
      });
    }
  }
  return out;
}
