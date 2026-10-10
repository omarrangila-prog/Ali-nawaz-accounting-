/**
 * Ali Nawaz PDC — Register projection, search and filters
 *
 * Pure read-side helpers that turn the raw dataset into the rows the Cashbook
 * shows. Every screen and report reads through here, so nothing can compute a
 * balance a different way (spec §31.11, §31.12).
 */

import type {
  AccountRef,
  Cheque,
  PdcDataSet,
  PdcLedgerEntry,
  PdcTransaction,
  PdcTxnType,
  RegisterRow,
  SummaryFilter,
} from '@/types/pdc';
import { CASH_ACCOUNT_ID } from '@/types/pdc';
import type { ISODate } from '@/types';
import { bankAccountLabel, holderLabel, isFundsAccount, partyName } from '@/lib/pdcEngine';
import { round2 } from '@/lib/utils';

/**
 * Signed effect of a transaction on combined cash + bank funds. Used for the
 * register's running balance column. A bank transfer nets to zero (money moves
 * between our own accounts), which is why it returns 0 despite being a money
 * type.
 *
 * A REVERSED entry is deliberately NOT skipped. Its reversal is a real posting
 * with its own opposing lines, so the two already cancel; ignoring the original
 * as well would apply the correction twice and leave the running balance
 * showing minus the amount when the true figure is nil.
 */
export function fundsDelta(data: PdcDataSet, txn: PdcTransaction): number {
  let delta = 0;
  for (const l of data.ledger) {
    if (l.txnId !== txn.id) continue;
    // Only real money counts — nominal (P&L) and cheque-custody accounts don't.
    if (isFundsAccount(l.account)) delta += l.debit - l.credit;
  }
  return round2(delta);
}

// ---------------------------------------------------------------------------
// From → To: where the money (or goods) on a line came from and went to
// ---------------------------------------------------------------------------

/** Both ends of a movement, named the way the user thinks of them. */
export interface Flow {
  from: string;
  to: string;
}

/** The internal accounts, in plain words. */
const INTERNAL_LABEL: Record<string, string> = {
  [CASH_ACCOUNT_ID]: 'Cash in Hand',
  ADJ: 'Adjustment',
  'NOM:SALES': 'Sales',
  'NOM:PURCHASES': 'Purchases',
  'NOM:EXPENSES': 'Expenses',
  'NOM:INCOME': 'Income',
};

const accountKey = (a: AccountRef): string => `${a.kind}:${a.id}`;

/**
 * One account's name. A cheque's custody account is named after the person
 * the cheque belongs to — unless that person is already one end of the
 * movement, in which case "Cheque in Hand" says it without repeating them.
 */
function accountLabel(
  data: PdcDataSet,
  account: AccountRef,
  ctx: { cheques: Map<string, Cheque>; parties: Set<string>; txn?: PdcTransaction }
): string {
  if (account.kind === 'party') return partyName(data, account.id) || '—';
  if (account.kind === 'bank') return bankAccountLabel(data.banks, data.bankAccounts, account.id) || '—';
  if (account.kind === 'ledger') return data.ledgers.find((l) => l.id === account.id)?.name ?? '—';

  const custody = /^(PDCI?):(.+)$/.exec(account.id);
  if (custody) {
    const cheque = ctx.cheques.get(custody[2]);
    const issued = custody[1] === 'PDCI';
    if (cheque && !ctx.parties.has(cheque.partyId)) {
      return `${partyName(data, cheque.partyId) || '—'} (cheque)`;
    }
    if (issued) {
      const bank = bankAccountLabel(data.banks, data.bankAccounts, cheque?.bankAccountId);
      return bank ? `${bank} (cheque)` : 'Cheque Issued';
    }
    return 'Cheque in Hand';
  }
  if (account.id === 'NOM:EXPENSES' && ctx.txn?.category?.trim()) return ctx.txn.category.trim();
  return INTERNAL_LABEL[account.id] ?? account.id;
}

const joinNames = (names: string[]): string => [...new Set(names.filter(Boolean))].join(', ');

/** Every ledger line grouped by the transaction it belongs to. */
export function linesByTxn(data: PdcDataSet): Map<string, PdcLedgerEntry[]> {
  const out = new Map<string, PdcLedgerEntry[]>();
  for (const l of data.ledger) {
    const list = out.get(l.txnId);
    if (list) list.push(l);
    else out.set(l.txnId, [l]);
  }
  return out;
}

/**
 * From → To for ONE ledger line, read off the other side of the same posting.
 *
 * In a double entry the value leaves the credited account and arrives in the
 * debited one, so a debit on this line means it came FROM the lines credited
 * alongside it, and a credit means it went TO the lines debited alongside it.
 * Reading the posting itself — rather than a stored "related party" field that
 * older entries never had — names both ends of cash, bank, cheque, sale and
 * transfer lines alike.
 */
export function lineFlow(
  data: PdcDataSet,
  entry: PdcLedgerEntry,
  siblings: PdcLedgerEntry[],
  cheques: Map<string, Cheque>,
  txn?: PdcTransaction
): Flow {
  const self = accountKey(entry.account);
  const inbound = entry.debit > 0;
  const others = siblings.filter(
    (l) => accountKey(l.account) !== self && (inbound ? l.credit > 0 : l.debit > 0)
  );
  const parties = new Set<string>();
  for (const l of [entry, ...others]) if (l.account.kind === 'party') parties.add(l.account.id);
  const ctx = { cheques, parties, txn };

  const selfName = accountLabel(data, entry.account, ctx);
  const other =
    joinNames(others.map((l) => accountLabel(data, l.account, ctx))) ||
    partyName(data, entry.relatedPartyId) ||
    bankAccountLabel(data.banks, data.bankAccounts, entry.relatedBankAccountId) ||
    '—';
  return inbound ? { from: other, to: selfName } : { from: selfName, to: other };
}

/**
 * From → To for a WHOLE transaction: every account it took value out of, and
 * every account it put value into. An account that nets to nothing (in and
 * straight back out) is neither end.
 */
export function txnFlow(
  data: PdcDataSet,
  txn: PdcTransaction,
  lines: PdcLedgerEntry[],
  cheques: Map<string, Cheque>
): Flow {
  const net = new Map<string, { account: AccountRef; n: number }>();
  const parties = new Set<string>();
  for (const l of lines) {
    const k = accountKey(l.account);
    const cur = net.get(k) ?? { account: l.account, n: 0 };
    cur.n += l.debit - l.credit;
    net.set(k, cur);
    if (l.account.kind === 'party') parties.add(l.account.id);
  }
  const ctx = { cheques, parties, txn };
  const ends = (sign: 1 | -1) =>
    joinNames([...net.values()]
      .filter((v) => v.n * sign > 0.005)
      .map((v) => accountLabel(data, v.account, ctx)));
  return { from: ends(-1) || '—', to: ends(1) || '—' };
}

/** Debit / credit totals for a transaction, from its ledger lines. */
/**
 * How a transaction was paid, in plain words — with the bank named when one was
 * involved. Derived once here so the register, the details drawer, every ledger
 * and the reports all say the same thing.
 */
export function paymentMethodOf(
  data: PdcDataSet,
  txn: PdcTransaction
): { method: string; bankName: string } {
  const accId = txn.fromBankAccountId || txn.toBankAccountId;
  const bankName = accId
    ? bankAccountLabel(data.banks, data.bankAccounts, accId)
    : '';

  // A cheque entry is a cheque, whatever else is set.
  if (txn.chequeId) {
    const cheque = data.cheques.find((c) => c.id === txn.chequeId);
    const drawer = cheque
      ? data.banks.find((b) => b.id === cheque.bankId)?.name ?? ''
      : '';
    return { method: 'Cheque', bankName: bankName || drawer };
  }

  // Explicitly recorded on newer entries.
  if (txn.paymentMethod) {
    const label = txn.paymentMethod.charAt(0).toUpperCase() + txn.paymentMethod.slice(1);
    return { method: label, bankName };
  }

  // Older entries predate paymentMethod — infer it so history still reads well.
  if (accId) return { method: 'Bank', bankName };
  switch (txn.type) {
    case 'Sale':
    case 'Purchase':
      return { method: txn.settlement === 'cash' ? 'Cash' : 'Credit', bankName };
    case 'Cash Received':
    case 'Cash Paid':
    case 'Expense':
    case 'Income':
      return { method: 'Cash', bankName };
    case 'Debit Adjustment':
      return { method: 'Debit', bankName };
    case 'Credit Adjustment':
      return { method: 'Credit', bankName };
    case 'Bank Transfer':
      return { method: 'Bank', bankName };
    default:
      return { method: '—', bankName };
  }
}

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
  const byTxn = linesByTxn(data);

  // Start from the money that already existed before any transaction — the
  // bank accounts' opening balances. Starting at zero would make the Balance
  // column disagree with the "Total Money" card by exactly that amount.
  let running = data.bankAccounts.reduce((sum, a) => sum + a.openingBalance, 0);
  const rows: RegisterRow[] = chrono.map((txn) => {
    running += fundsDelta(data, txn);
    const { debit, credit } = txnTotals(data, txn.id);
    const cheque = txn.chequeId ? chequeById.get(txn.chequeId) : undefined;
    const flow = txnFlow(data, txn, byTxn.get(txn.id) ?? [], chequeById);
    return {
      txn,
      debit,
      credit,
      running: round2(running),
      cheque,
      partyName: partyName(data, txn.partyId),
      toPartyName: partyName(data, txn.toPartyId),
      fromName: flow.from,
      toName: flow.to,
      bankLabel: bankAccountLabel(
        data.banks,
        data.bankAccounts,
        txn.fromBankAccountId || txn.toBankAccountId
      ),
      status: cheque?.status,
      holderLabel: cheque ? holderLabel(data, cheque.holder) : '',
      ...paymentMethodOf(data, txn),
    };
  });

  return rows.reverse();
}

/**
 * For a money entry, whether the money has ACTUALLY moved yet — in the plain
 * words the user asks the question in.
 *
 *   'paid'        cash or bank has left, or the cheque has cleared
 *   'need to pay' a cheque was issued but has not cleared, so the money is
 *                 still owed despite the entry existing
 *   'received'    money has come in
 *   'due in'      a cheque was received but has not cleared yet
 *
 * A cheque entry is the whole reason this is not simply the entry's type: the
 * payment is recorded, but nothing has left the account until it clears.
 */
export function settledState(
  row: RegisterRow
): { label: string; tone: 'done' | 'waiting' } | null {
  const t = row.txn;
  const out = t.type === 'Cash Paid' || t.type === 'PDC Issued' || t.type === 'Purchase';
  const inn = t.type === 'Cash Received' || t.type === 'PDC Received' || t.type === 'Sale';
  if (!out && !inn) return null;

  const c = row.cheque;
  if (c) {
    // Only a cleared cheque has actually moved money.
    if (c.status === 'cleared') return { label: out ? 'Paid' : 'Received', tone: 'done' };
    if (['bounced', 'returned', 'cancelled'].includes(c.status)) {
      return { label: out ? 'Need to Pay' : 'Not Received', tone: 'waiting' };
    }
    return { label: out ? 'Need to Pay' : 'Due In', tone: 'waiting' };
  }
  // A credit trade moves no money; the party settles it later.
  if (t.type === 'Purchase') return { label: 'Need to Pay', tone: 'waiting' };
  if (t.type === 'Sale') return { label: t.settlement === 'cash' ? 'Received' : 'Due In',
                                  tone: t.settlement === 'cash' ? 'done' : 'waiting' };
  return { label: out ? 'Paid' : 'Received', tone: 'done' };
}

/**
 * Totals for a set of register rows — what the Cash Book prints in its totals
 * row and its Total Quantity card.
 *
 * Both sides of a cancellation are excluded: the REVERSED entry and the
 * REVERSAL that undid it. Skipping only the reversed one would leave the
 * reversal's own amount and quantity in the figures, so a cancelled sale would
 * still appear to have sold something.
 */
export function rowTotals(rows: RegisterRow[]): {
  qty: number; amount: number; debit: number; credit: number; count: number;
} {
  let qty = 0, amount = 0, debit = 0, credit = 0, count = 0;
  for (const r of rows) {
    if (r.txn.reversed || r.txn.type === 'Reversal') continue;
    count++;
    if (r.txn.quantity !== undefined) qty += r.txn.quantity;
    amount += r.txn.amount;
    debit += r.debit;
    credit += r.credit;
  }
  return {
    qty: round2(qty), amount: round2(amount),
    debit: round2(debit), credit: round2(credit), count,
  };
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
    row.txn.itemName,
    row.txn.category,
    row.txn.date,
    row.partyName,
    row.toPartyName,
    row.fromName,
    row.toName,
    row.bankLabel,
    row.method,
    row.bankName,
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
  /** 'all' or a payment method: Cash / Bank / Credit / Debit / Cheque. */
  method: string;
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
  method: 'all',
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
    if (f.method !== 'all' && row.method.toLowerCase() !== f.method.toLowerCase()) return false;
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
  /** Where the value on this line came from, and where it went. */
  from: string;
  to: string;
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
  const byTxn = linesByTxn(data);

  let running = party?.openingBalance ?? 0;
  const rows: PartyLedgerRow[] = entries.map((entry) => {
    running += entry.debit - entry.credit;
    const txn = txnById.get(entry.txnId);
    return {
      entry,
      txn,
      cheque: entry.chequeId ? chequeById.get(entry.chequeId) : undefined,
      running: round2(running),
      ...lineFlow(data, entry, byTxn.get(entry.txnId) ?? [], chequeById, txn),
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
  const byTxn = linesByTxn(data);

  let running = account?.openingBalance ?? 0;
  const rows: PartyLedgerRow[] = entries.map((entry) => {
    running += entry.debit - entry.credit;
    const txn = txnById.get(entry.txnId);
    return {
      entry,
      txn,
      cheque: entry.chequeId ? chequeById.get(entry.chequeId) : undefined,
      running: round2(running),
      ...lineFlow(data, entry, byTxn.get(entry.txnId) ?? [], chequeById, txn),
      relatedName: partyName(data, entry.relatedPartyId),
      bankLabel: '',
    };
  });

  return { rows: rows.reverse(), balance: round2(running) };
}

/**
 * Cash in hand, broken down by where it came from and what it went on.
 *
 * Every entry touching physical cash lands here automatically: it reads the
 * same ledger lines the balance itself is replayed from, so there is no second
 * list that could fall out of step.
 */
export interface CashLedgerView {
  /** Every cash movement, newest first for the screen. */
  rows: PartyLedgerRow[];
  /** Cash in hand right now. */
  balance: number;
  /** Everything that came in. */
  totalIn: number;
  /** Everything that went out. */
  totalOut: number;
  breakdown: {
    fromSales: number;
    fromReceive: number;
    fromOther: number;
    forPurchases: number;
    forPay: number;
    forExpenses: number;
    forOther: number;
  };
}

/** The cash account's ledger, with totals in and out. */
export function buildCashLedger(data: PdcDataSet): CashLedgerView {
  const entries = data.ledger
    .filter((l) => l.account.kind === 'cash' && l.account.id === CASH_ACCOUNT_ID)
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt);

  const txnById = new Map(data.transactions.map((t) => [t.id, t]));
  const chequeById = new Map(data.cheques.map((c) => [c.id, c]));
  const byTxn = linesByTxn(data);

  let running = 0;
  let totalIn = 0;
  let totalOut = 0;
  const b = {
    fromSales: 0, fromReceive: 0, fromOther: 0,
    forPurchases: 0, forPay: 0, forExpenses: 0, forOther: 0,
  };

  const rows: PartyLedgerRow[] = entries.map((entry) => {
    // On the cash account a debit is money IN and a credit is money OUT.
    running += entry.debit - entry.credit;
    totalIn += entry.debit;
    totalOut += entry.credit;

    const txn = txnById.get(entry.txnId);
    const type = txn?.type;
    if (entry.debit > 0) {
      if (type === 'Sale') b.fromSales += entry.debit;
      else if (type === 'Cash Received') b.fromReceive += entry.debit;
      else b.fromOther += entry.debit;
    }
    if (entry.credit > 0) {
      if (type === 'Purchase') b.forPurchases += entry.credit;
      else if (type === 'Cash Paid') b.forPay += entry.credit;
      else if (type === 'Expense') b.forExpenses += entry.credit;
      else b.forOther += entry.credit;
    }

    return {
      entry,
      txn,
      cheque: entry.chequeId ? chequeById.get(entry.chequeId) : undefined,
      running: round2(running),
      ...lineFlow(data, entry, byTxn.get(entry.txnId) ?? [], chequeById, txn),
      relatedName: partyName(data, entry.relatedPartyId),
      bankLabel: bankAccountLabel(data.banks, data.bankAccounts, entry.relatedBankAccountId),
    };
  });

  return {
    rows: rows.reverse(),
    balance: round2(running),
    totalIn: round2(totalIn),
    totalOut: round2(totalOut),
    breakdown: {
      fromSales: round2(b.fromSales),
      fromReceive: round2(b.fromReceive),
      fromOther: round2(b.fromOther),
      forPurchases: round2(b.forPurchases),
      forPay: round2(b.forPay),
      forExpenses: round2(b.forExpenses),
      forOther: round2(b.forOther),
    },
  };
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
