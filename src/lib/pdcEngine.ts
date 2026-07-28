/**
 * Ali Nawaz PDC — Posting engine
 *
 * Pure functions only: they take a dataset plus an input and RETURN the records
 * to write. Nothing here touches Firestore, so every rule below is directly
 * unit-testable (see pdcEngine.test.ts).
 *
 * The non-negotiables from spec §31 are enforced here:
 *   • every posting is balanced (total debit === total credit)
 *   • linked entries share one txnId and one reference
 *   • balances are always REPLAYED from ledger entries, never stored
 *   • one physical cheque is ever only one cheque record
 */

import type {
  AccountRef,
  Bank,
  BankAccount,
  Cheque,
  ChequeDirection,
  ChequeHolder,
  ChequeMovement,
  LedgerView,
  MainLedger,
  PdcDataSet,
  PdcLedgerEntry,
  PdcSummary,
  PdcTransaction,
  PdcTxnType,
} from '@/types/pdc';
import { CASH_ACCOUNT_ID } from '@/types/pdc';
import type { ISODate } from '@/types';
import { round2, uid, now, periodOf } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Reference numbers
// ---------------------------------------------------------------------------

const REF_PREFIX: Record<PdcTxnType, string> = {
  Sale: 'SAL',
  Purchase: 'PUR',
  Expense: 'EXP',
  Income: 'INC',
  'PDC Received': 'PDCR',
  'PDC Issued': 'PDCI',
  'Cash Received': 'CRV',
  'Cash Paid': 'CPV',
  'Debit Adjustment': 'DR',
  'Credit Adjustment': 'CR',
  'Party Transfer': 'PT',
  'Cheque Endorsement': 'CE',
  'Bank Transfer': 'BT',
  'Cheque Deposited': 'DEP',
  'Cheque Cleared': 'CLR',
  'Cheque Bounced': 'BNC',
  'Cheque Returned': 'RET',
  'Cheque Replacement': 'RPL',
  Reversal: 'REV',
};

/**
 * Next sequential reference for a transaction type, e.g. "PDCR-000013".
 * Sequence is per-type and derived from existing data so it survives reloads.
 */
export function nextReference(data: PdcDataSet, type: PdcTxnType): string {
  const prefix = REF_PREFIX[type];
  let max = 0;
  for (const t of data.transactions) {
    if (!t.reference?.startsWith(prefix + '-')) continue;
    const n = Number(t.reference.slice(prefix.length + 1));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${prefix}-${String(max + 1).padStart(6, '0')}`;
}

// ---------------------------------------------------------------------------
// Ledger line helpers
// ---------------------------------------------------------------------------

export const partyAcc = (id: string): AccountRef => ({ kind: 'party', id });
/** An entry posted directly to a named ledger (Najeeb), not to one of its parties. */
export const ledgerAcc = (id: string): AccountRef => ({ kind: 'ledger', id });
export const bankAcc = (id: string): AccountRef => ({ kind: 'bank', id });
export const cashAcc = (): AccountRef => ({ kind: 'cash', id: CASH_ACCOUNT_ID });

/**
 * The custody account for one physical cheque. A received cheque is an ASSET
 * held here until it clears/transfers; an issued cheque is a LIABILITY carried
 * here until it clears. Keeping each cheque in its own account means the
 * outstanding-cheque totals reconcile per cheque and never touch cash until
 * the cheque actually settles.
 */
export const chequeAcc = (chequeId: string, dir: ChequeDirection): AccountRef => ({
  kind: 'cash',
  id: `${dir === 'received' ? 'PDC' : 'PDCI'}:${chequeId}`,
});

/** The pseudo-account adjustments post against. */
export const adjustmentAcc = (): AccountRef => ({ kind: 'cash', id: 'ADJ' });

/**
 * Nominal (profit & loss) accounts. They are not cash and not a party — they
 * exist so trading and running costs post a real double entry instead of a
 * one-sided amount. Profit is then simply:
 *   (Sales + Income) − (Purchases + Expenses)
 */
export const revenueAcc = (): AccountRef => ({ kind: 'cash', id: 'NOM:SALES' });
export const costAcc = (): AccountRef => ({ kind: 'cash', id: 'NOM:PURCHASES' });
export const expenseAcc = (): AccountRef => ({ kind: 'cash', id: 'NOM:EXPENSES' });
export const incomeAcc = (): AccountRef => ({ kind: 'cash', id: 'NOM:INCOME' });

/** Account ids that are nominal (P&L), i.e. never part of cash in hand. */
export const NOMINAL_IDS = ['NOM:SALES', 'NOM:PURCHASES', 'NOM:EXPENSES', 'NOM:INCOME', 'ADJ'];

/** True when a ledger line represents real spendable money (cash or bank). */
export function isFundsAccount(account: AccountRef): boolean {
  if (account.kind === 'bank') return true;
  return account.kind === 'cash' && account.id === CASH_ACCOUNT_ID;
}

function mainLedgerFor(account: AccountRef): MainLedger {
  switch (account.kind) {
    case 'party': return 'Parties';
    case 'bank': return 'Banks';
    case 'cash': return 'Cash';
    // A named ledger (Najeeb) rolls up under Parties for report grouping —
    // it behaves like a party account: positive = receivable.
    case 'ledger': return 'Parties';
  }
}

export interface LineInput {
  account: AccountRef;
  debit?: number;
  credit?: number;
  description: string;
  chequeId?: string;
  relatedPartyId?: string;
  relatedBankAccountId?: string;
  /** Override the rolled-up main ledger (e.g. post to 'PDC Received'). */
  mainLedger?: MainLedger;
}

/**
 * Build the ledger rows for a transaction and assert they balance.
 * Throws if debit !== credit — a bug here would silently corrupt every report,
 * so it must fail loudly rather than write unbalanced data.
 */
export function buildLines(
  txn: Pick<PdcTransaction, 'id' | 'date' | 'month' | 'year' | 'type'>,
  lines: LineInput[]
): PdcLedgerEntry[] {
  const rows: PdcLedgerEntry[] = lines.map((l) => ({
    id: uid(),
    txnId: txn.id,
    date: txn.date,
    month: txn.month,
    year: txn.year,
    account: l.account,
    mainLedger: l.mainLedger ?? mainLedgerFor(l.account),
    type: txn.type,
    description: l.description,
    debit: round2(l.debit ?? 0),
    credit: round2(l.credit ?? 0),
    chequeId: l.chequeId,
    relatedPartyId: l.relatedPartyId,
    relatedBankAccountId: l.relatedBankAccountId,
    createdAt: now(),
  }));
  assertBalanced(rows);
  return rows;
}

/** Throws unless the lines form a balanced double-entry posting. */
export function assertBalanced(rows: PdcLedgerEntry[]): void {
  const debit = round2(rows.reduce((s, r) => s + r.debit, 0));
  const credit = round2(rows.reduce((s, r) => s + r.credit, 0));
  if (Math.abs(debit - credit) > 0.005) {
    throw new Error(
      `Unbalanced posting: debit ${debit} !== credit ${credit} (txn ${rows[0]?.txnId ?? '?'})`
    );
  }
}

/** True when every txnId group in the dataset balances. Used by tests + audit. */
export function ledgerIsBalanced(data: PdcDataSet): boolean {
  const byTxn = new Map<string, PdcLedgerEntry[]>();
  for (const e of data.ledger) {
    const list = byTxn.get(e.txnId);
    if (list) list.push(e);
    else byTxn.set(e.txnId, [e]);
  }
  for (const rows of byTxn.values()) {
    const d = round2(rows.reduce((s, r) => s + r.debit, 0));
    const c = round2(rows.reduce((s, r) => s + r.credit, 0));
    if (Math.abs(d - c) > 0.005) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Balances — always replayed from ledger entries (spec §31.9, §31.10)
// ---------------------------------------------------------------------------

function sameAccount(a: AccountRef, b: AccountRef): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/**
 * Balance of one account = opening + Σ(debit − credit).
 * For a party: positive => receivable (they owe us), negative => payable.
 * For cash/bank: positive => funds available.
 */
export function accountBalance(data: PdcDataSet, account: AccountRef): number {
  let bal = 0;
  if (account.kind === 'party') {
    bal = data.parties.find((p) => p.id === account.id)?.openingBalance ?? 0;
  } else if (account.kind === 'bank') {
    bal = data.bankAccounts.find((a) => a.id === account.id)?.openingBalance ?? 0;
  } else if (account.kind === 'ledger') {
    bal = data.ledgers.find((l) => l.id === account.id)?.openingBalance ?? 0;
  }
  for (const e of data.ledger) {
    if (sameAccount(e.account, account)) bal += e.debit - e.credit;
  }
  return round2(bal);
}

/** Every party's balance in one pass (positive = receivable). */
export function partyBalances(data: PdcDataSet): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of data.parties) out.set(p.id, p.openingBalance);
  for (const e of data.ledger) {
    if (e.account.kind !== 'party') continue;
    out.set(e.account.id, (out.get(e.account.id) ?? 0) + e.debit - e.credit);
  }
  for (const [k, v] of out) out.set(k, round2(v));
  return out;
}

/** Balance of every named ledger's OWN account (excluding its parties). */
export function ledgerOwnBalances(data: PdcDataSet): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of data.ledgers) out.set(l.id, l.openingBalance);
  for (const e of data.ledger) {
    if (e.account.kind !== 'ledger') continue;
    out.set(e.account.id, (out.get(e.account.id) ?? 0) + e.debit - e.credit);
  }
  for (const [k, v] of out) out.set(k, round2(v));
  return out;
}

/**
 * Roll a named ledger up: its own entries plus every party assigned to it.
 *
 * A party may belong to several ledgers, so the same balance can appear in more
 * than one ledger's total. Rather than hide that, each party row is marked
 * `shared` and names the other ledgers involved.
 */
export function buildLedgerView(data: PdcDataSet, ledgerId: string): LedgerView | null {
  const ledger = data.ledgers.find((l) => l.id === ledgerId);
  if (!ledger) return null;

  const balances = partyBalances(data);
  const ownBalance = accountBalance(data, ledgerAcc(ledgerId));

  const members = data.parties
    .filter((p) => (p.ledgerIds ?? []).includes(ledgerId))
    .sort((a, b) => a.name.localeCompare(b.name));

  const parties = members.map((party) => {
    const others = (party.ledgerIds ?? []).filter((id) => id !== ledgerId);
    return {
      party,
      balance: balances.get(party.id) ?? 0,
      shared: others.length > 0,
      sharedWith: others
        .map((id) => data.ledgers.find((l) => l.id === id)?.name)
        .filter((n): n is string => !!n),
    };
  });

  const partiesTotal = round2(parties.reduce((s, r) => s + r.balance, 0));

  // Receivable / payable count the ledger's own balance as well as its parties'.
  let receivable = 0;
  let payable = 0;
  for (const v of [...parties.map((r) => r.balance), ownBalance]) {
    if (v > 0) receivable += v;
    else if (v < 0) payable += -v;
  }

  return {
    ledger,
    ownBalance,
    parties,
    partiesTotal,
    total: round2(ownBalance + partiesTotal),
    receivable: round2(receivable),
    payable: round2(payable),
    sharedPartyIds: parties.filter((r) => r.shared).map((r) => r.party.id),
  };
}

/** Every ledger rolled up, name-sorted. */
export function buildAllLedgerViews(data: PdcDataSet): LedgerView[] {
  return data.ledgers
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((l) => buildLedgerView(data, l.id))
    .filter((v): v is LedgerView => v !== null);
}

/** Display name for a named ledger. */
export function ledgerName(data: PdcDataSet, id?: string): string {
  if (!id) return '';
  return data.ledgers.find((l) => l.id === id)?.name ?? '—';
}

/** Every bank account's balance in one pass. */
export function bankBalances(data: PdcDataSet): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of data.bankAccounts) out.set(a.id, a.openingBalance);
  for (const e of data.ledger) {
    if (e.account.kind !== 'bank') continue;
    out.set(e.account.id, (out.get(e.account.id) ?? 0) + e.debit - e.credit);
  }
  for (const [k, v] of out) out.set(k, round2(v));
  return out;
}

export function cashBalance(data: PdcDataSet): number {
  return accountBalance(data, cashAcc());
}

/**
 * Total spendable money = physical cash + every bank account.
 * Nominal accounts (Sales/Purchases/Expenses/Income) and cheque-custody
 * accounts are deliberately excluded — an uncleared cheque is not cash.
 */
export function totalFunds(data: PdcDataSet): number {
  let total = cashBalance(data);
  for (const v of bankBalances(data).values()) total += v;
  return round2(total);
}

/** Sum of the debit−credit movement on one nominal account. */
function nominalTotal(data: PdcDataSet, id: string, sign: 1 | -1): number {
  let total = 0;
  for (const e of data.ledger) {
    if (e.account.kind === 'cash' && e.account.id === id) {
      total += sign * (e.credit - e.debit);
    }
  }
  return round2(total);
}

export interface ProfitBreakdown {
  sales: number;
  purchases: number;
  expenses: number;
  otherIncome: number;
  /** (Sales + Other Income) − (Purchases + Expenses) */
  netProfit: number;
}

/**
 * Profit & loss for the whole dataset. ONE definition used by the Cash Book
 * and every report, so the figures can never disagree.
 */
export function computeProfit(data: PdcDataSet): ProfitBreakdown {
  const sales = nominalTotal(data, 'NOM:SALES', 1);          // credited → +
  const otherIncome = nominalTotal(data, 'NOM:INCOME', 1);   // credited → +
  const purchases = nominalTotal(data, 'NOM:PURCHASES', -1); // debited  → +
  const expenses = nominalTotal(data, 'NOM:EXPENSES', -1);   // debited  → +
  return {
    sales,
    purchases,
    expenses,
    otherIncome,
    netProfit: round2(sales + otherIncome - purchases - expenses),
  };
}

// ---------------------------------------------------------------------------
// Summary bar (spec §2)
// ---------------------------------------------------------------------------

export function computeSummary(data: PdcDataSet, today: ISODate): PdcSummary {
  const balances = partyBalances(data);
  let totalReceivable = 0;
  let totalPayable = 0;
  for (const bal of balances.values()) {
    if (bal > 0) totalReceivable += bal;
    else if (bal < 0) totalPayable += -bal;
  }

  let pendingReceivedCheques = 0;
  let pendingIssuedCheques = 0;
  let dueToday = 0;
  let overdue = 0;
  let cleared = 0;
  let bounced = 0;

  for (const c of data.cheques) {
    const live = c.status === 'pending' || c.status === 'deposited' || c.status === 'presented';
    if (live) {
      if (c.direction === 'received') pendingReceivedCheques += c.amount;
      else pendingIssuedCheques += c.amount;
      if (c.chequeDate === today) dueToday += c.amount;
      else if (c.chequeDate < today) overdue += c.amount;
    }
    if (c.status === 'cleared') cleared += c.amount;
    if (c.status === 'bounced') bounced += c.amount;
  }

  let bank = 0;
  for (const v of bankBalances(data).values()) bank += v;

  const pl = computeProfit(data);
  const cash = cashBalance(data);

  return {
    totalReceivable: round2(totalReceivable),
    totalPayable: round2(totalPayable),
    pendingReceivedCheques: round2(pendingReceivedCheques),
    pendingIssuedCheques: round2(pendingIssuedCheques),
    dueToday: round2(dueToday),
    overdue: round2(overdue),
    cleared: round2(cleared),
    bounced: round2(bounced),
    cashBalance: cash,
    bankBalance: round2(bank),
    totalFunds: round2(cash + bank),
    // Every cheque still in play, whichever direction it flows.
    totalCheques: round2(pendingReceivedCheques + pendingIssuedCheques),
    totalChequeCount: data.cheques.filter(
      (c) => c.status === 'pending' || c.status === 'deposited' || c.status === 'presented'
    ).length,
    totalSales: pl.sales,
    totalPurchases: pl.purchases,
    totalExpenses: pl.expenses,
    otherIncome: pl.otherIncome,
    netProfit: pl.netProfit,
  };
}

// ---------------------------------------------------------------------------
// Transaction builders — each returns a complete, balanced posting
// ---------------------------------------------------------------------------

/** What a builder produces: the header, its lines, and any cheque side-effects. */
export interface Posting {
  txn: PdcTransaction;
  lines: PdcLedgerEntry[];
  cheque?: Cheque;
  movements: ChequeMovement[];
}

function makeTxn(
  data: PdcDataSet,
  type: PdcTxnType,
  date: ISODate,
  amount: number,
  extra: Partial<PdcTransaction> = {}
): PdcTransaction {
  const { month, year } = periodOf(date);
  const t = now();
  return {
    id: uid(),
    reference: nextReference(data, type),
    type,
    date,
    month,
    year,
    amount: round2(amount),
    createdAt: t,
    updatedAt: t,
    ...extra,
  };
}

function movement(
  chequeId: string,
  date: ISODate,
  action: string,
  extra: Partial<ChequeMovement> = {}
): ChequeMovement {
  return { id: uid(), chequeId, at: now(), date, action, ...extra };
}

// --- PDC Received (spec §7) -------------------------------------------------

export interface PdcReceivedInput {
  partyId: string;
  bankId: string;
  chequeNumber: string;
  chequeDate: ISODate;
  amount: number;
  date: ISODate;
  description?: string;
  reference?: string;
  branch?: string;
  drawerName?: string;
  accountNumber?: string;
  notes?: string;
}

/**
 * Receiving a PDC from a party SETTLES part of what they owe us:
 *   Dr PDC Received (asset — cheque in hand)
 *   Cr Party        (reduces their receivable)
 */
export function buildPdcReceived(data: PdcDataSet, input: PdcReceivedInput): Posting {
  const amount = round2(input.amount);
  const txn = makeTxn(data, 'PDC Received', input.date, amount, {
    partyId: input.partyId,
    description: input.description,
  });
  const cheque: Cheque = {
    id: uid(),
    direction: 'received',
    chequeNumber: input.chequeNumber.trim(),
    bankId: input.bankId,
    chequeDate: input.chequeDate,
    date: input.date,
    amount,
    partyId: input.partyId,
    status: 'pending',
    holder: { kind: 'business' },
    allocatedAmount: 0,
    drawerName: input.drawerName,
    accountNumber: input.accountNumber,
    branch: input.branch,
    description: input.description,
    reference: input.reference,
    notes: input.notes,
    createdAt: now(),
    updatedAt: now(),
  };
  txn.chequeId = cheque.id;

  const desc = input.description || `PDC received — cheque ${cheque.chequeNumber}`;
  // The asset side belongs to the CHEQUE, not to the party — posting both legs
  // to the party sub-ledger would cancel out and leave their balance unchanged.
  const lines = buildLines(txn, [
    {
      account: chequeAcc(cheque.id, 'received'),
      debit: amount,
      description: desc,
      chequeId: cheque.id,
      mainLedger: 'PDC Received',
      relatedPartyId: input.partyId,
    },
    {
      account: partyAcc(input.partyId),
      credit: amount,
      description: desc,
      chequeId: cheque.id,
      mainLedger: 'Parties',
    },
  ]);

  return {
    txn,
    lines,
    cheque,
    movements: [
      movement(cheque.id, input.date, 'Created — received from party', {
        toStatus: 'pending',
        toHolder: { kind: 'business' },
        fromPartyId: input.partyId,
        txnId: txn.id,
        reference: txn.reference,
        description: desc,
      }),
    ],
  };
}

// --- PDC Issued (spec §8) ---------------------------------------------------

export interface PdcIssuedInput {
  partyId: string;
  bankAccountId: string;
  chequeNumber: string;
  chequeDate: ISODate;
  amount: number;
  date: ISODate;
  description?: string;
  reference?: string;
  notes?: string;
}

/**
 * Issuing a cheque to a party settles part of what we owe:
 *   Dr Party        (reduces payable)
 *   Cr PDC Issued   (liability — cheque outstanding, not yet cleared)
 * The bank account is only touched when the cheque actually clears.
 */
export function buildPdcIssued(data: PdcDataSet, input: PdcIssuedInput): Posting {
  const amount = round2(input.amount);
  const account = data.bankAccounts.find((a) => a.id === input.bankAccountId);
  const txn = makeTxn(data, 'PDC Issued', input.date, amount, {
    partyId: input.partyId,
    fromBankAccountId: input.bankAccountId,
    description: input.description,
  });
  const cheque: Cheque = {
    id: uid(),
    direction: 'issued',
    chequeNumber: input.chequeNumber.trim(),
    bankId: account?.bankId ?? '',
    bankAccountId: input.bankAccountId,
    chequeDate: input.chequeDate,
    date: input.date,
    amount,
    partyId: input.partyId,
    status: 'pending',
    holder: { kind: 'party', partyId: input.partyId },
    allocatedAmount: 0,
    description: input.description,
    reference: input.reference,
    notes: input.notes,
    createdAt: now(),
    updatedAt: now(),
  };
  txn.chequeId = cheque.id;

  const desc = input.description || `PDC issued — cheque ${cheque.chequeNumber}`;
  const lines = buildLines(txn, [
    {
      account: partyAcc(input.partyId),
      debit: amount,
      description: desc,
      chequeId: cheque.id,
      relatedBankAccountId: input.bankAccountId,
    },
    {
      account: chequeAcc(cheque.id, 'issued'),
      credit: amount,
      description: desc,
      chequeId: cheque.id,
      mainLedger: 'PDC Issued',
      relatedPartyId: input.partyId,
    },
  ]);

  return {
    txn,
    lines,
    cheque,
    movements: [
      movement(cheque.id, input.date, 'Created — issued to party', {
        toStatus: 'pending',
        toHolder: { kind: 'party', partyId: input.partyId },
        toPartyId: input.partyId,
        bankAccountId: input.bankAccountId,
        txnId: txn.id,
        reference: txn.reference,
        description: desc,
      }),
    ],
  };
}

// --- Cash received / paid (spec §9, §10) ------------------------------------

export interface CashInput {
  partyId: string;
  amount: number;
  date: ISODate;
  description?: string;
  /** Deposit into a bank account instead of physical cash. */
  bankAccountId?: string;
}

/** Cash received: Dr Cash/Bank, Cr Party (their receivable drops). */
export function buildCashReceived(data: PdcDataSet, input: CashInput): Posting {
  const amount = round2(input.amount);
  const txn = makeTxn(data, 'Cash Received', input.date, amount, {
    partyId: input.partyId,
    toBankAccountId: input.bankAccountId,
    description: input.description,
  });
  const desc = input.description || 'Cash received';
  const target = input.bankAccountId ? bankAcc(input.bankAccountId) : cashAcc();
  return {
    txn,
    movements: [],
    lines: buildLines(txn, [
      { account: target, debit: amount, description: desc, relatedPartyId: input.partyId },
      { account: partyAcc(input.partyId), credit: amount, description: desc, relatedBankAccountId: input.bankAccountId },
    ]),
  };
}

/** Cash paid: Dr Party (payable drops), Cr Cash/Bank. */
export function buildCashPaid(data: PdcDataSet, input: CashInput): Posting {
  const amount = round2(input.amount);
  const txn = makeTxn(data, 'Cash Paid', input.date, amount, {
    partyId: input.partyId,
    fromBankAccountId: input.bankAccountId,
    description: input.description,
  });
  const desc = input.description || 'Cash paid';
  const source = input.bankAccountId ? bankAcc(input.bankAccountId) : cashAcc();
  return {
    txn,
    movements: [],
    lines: buildLines(txn, [
      { account: partyAcc(input.partyId), debit: amount, description: desc, relatedBankAccountId: input.bankAccountId },
      { account: source, credit: amount, description: desc, relatedPartyId: input.partyId },
    ]),
  };
}

// --- Debit / credit adjustments -------------------------------------------

export interface AdjustmentInput {
  partyId: string;
  amount: number;
  date: ISODate;
  description?: string;
}

/** Debit adjustment: increases what the party owes us. */
export function buildDebitAdjustment(data: PdcDataSet, input: AdjustmentInput): Posting {
  const amount = round2(input.amount);
  const txn = makeTxn(data, 'Debit Adjustment', input.date, amount, {
    partyId: input.partyId,
    description: input.description,
  });
  const desc = input.description || 'Debit adjustment';
  return {
    txn,
    movements: [],
    lines: buildLines(txn, [
      { account: partyAcc(input.partyId), debit: amount, description: desc },
      { account: adjustmentAcc(), credit: amount, description: desc, mainLedger: 'Adjustments', relatedPartyId: input.partyId },
    ]),
  };
}

/** Credit adjustment: increases what we owe the party. */
export function buildCreditAdjustment(data: PdcDataSet, input: AdjustmentInput): Posting {
  const amount = round2(input.amount);
  const txn = makeTxn(data, 'Credit Adjustment', input.date, amount, {
    partyId: input.partyId,
    description: input.description,
  });
  const desc = input.description || 'Credit adjustment';
  return {
    txn,
    movements: [],
    lines: buildLines(txn, [
      { account: adjustmentAcc(), debit: amount, description: desc, mainLedger: 'Adjustments', relatedPartyId: input.partyId },
      { account: partyAcc(input.partyId), credit: amount, description: desc },
    ]),
  };
}

// --- Sale / Purchase (everyday trading) ------------------------------------

export interface TradeInput {
  partyId: string;
  amount: number;
  date: ISODate;
  /** 'cash' settles immediately; 'credit' leaves it on the party's account. */
  settlement: 'cash' | 'credit';
  /** Bank account when settled through a bank rather than physical cash. */
  bankAccountId?: string;
  description?: string;
  quantity?: number;
  rate?: number;
}

/**
 * A SALE earns revenue.
 *   Credit sale: Dr Party (they owe us) , Cr Sales
 *   Cash sale:   Dr Cash/Bank           , Cr Sales
 * Either way Sales is credited, so revenue is counted exactly once and the
 * party balance only moves when the sale was actually on credit.
 */
export function buildSale(data: PdcDataSet, input: TradeInput): Posting {
  const amount = round2(input.amount);
  const txn = makeTxn(data, 'Sale', input.date, amount, {
    partyId: input.partyId,
    settlement: input.settlement,
    description: input.description,
    quantity: input.quantity,
    rate: input.rate,
    toBankAccountId: input.settlement === 'cash' ? input.bankAccountId : undefined,
  });
  const desc = input.description || 'Sale';
  const debitSide =
    input.settlement === 'credit'
      ? partyAcc(input.partyId)
      : input.bankAccountId
        ? bankAcc(input.bankAccountId)
        : cashAcc();

  return {
    txn,
    movements: [],
    lines: buildLines(txn, [
      { account: debitSide, debit: amount, description: desc, relatedPartyId: input.partyId },
      { account: revenueAcc(), credit: amount, description: desc, mainLedger: 'Sales', relatedPartyId: input.partyId },
    ]),
  };
}

/**
 * A PURCHASE incurs cost.
 *   Credit purchase: Dr Purchases , Cr Party (we owe them)
 *   Cash purchase:   Dr Purchases , Cr Cash/Bank
 */
export function buildPurchase(data: PdcDataSet, input: TradeInput): Posting {
  const amount = round2(input.amount);
  const txn = makeTxn(data, 'Purchase', input.date, amount, {
    partyId: input.partyId,
    settlement: input.settlement,
    description: input.description,
    quantity: input.quantity,
    rate: input.rate,
    fromBankAccountId: input.settlement === 'cash' ? input.bankAccountId : undefined,
  });
  const desc = input.description || 'Purchase';
  const creditSide =
    input.settlement === 'credit'
      ? partyAcc(input.partyId)
      : input.bankAccountId
        ? bankAcc(input.bankAccountId)
        : cashAcc();

  return {
    txn,
    movements: [],
    lines: buildLines(txn, [
      { account: costAcc(), debit: amount, description: desc, mainLedger: 'Purchases', relatedPartyId: input.partyId },
      { account: creditSide, credit: amount, description: desc, relatedPartyId: input.partyId },
    ]),
  };
}

// --- Expense / Income -------------------------------------------------------

export interface ExpenseInput {
  amount: number;
  date: ISODate;
  category: string;
  description?: string;
  /** Paid from / received into a bank account instead of cash. */
  bankAccountId?: string;
  /** Optional party the expense relates to. */
  partyId?: string;
}

/** An expense reduces cash/bank and reduces profit: Dr Expenses, Cr Cash/Bank. */
export function buildExpense(data: PdcDataSet, input: ExpenseInput): Posting {
  const amount = round2(input.amount);
  const txn = makeTxn(data, 'Expense', input.date, amount, {
    description: input.description,
    category: input.category,
    partyId: input.partyId,
    fromBankAccountId: input.bankAccountId,
  });
  const desc = input.description || input.category || 'Expense';
  const source = input.bankAccountId ? bankAcc(input.bankAccountId) : cashAcc();
  return {
    txn,
    movements: [],
    lines: buildLines(txn, [
      { account: expenseAcc(), debit: amount, description: desc, mainLedger: 'Expenses' },
      { account: source, credit: amount, description: desc },
    ]),
  };
}

/** Other income increases cash/bank and profit: Dr Cash/Bank, Cr Income. */
export function buildIncome(data: PdcDataSet, input: ExpenseInput): Posting {
  const amount = round2(input.amount);
  const txn = makeTxn(data, 'Income', input.date, amount, {
    description: input.description,
    category: input.category,
    partyId: input.partyId,
    toBankAccountId: input.bankAccountId,
  });
  const desc = input.description || input.category || 'Income';
  const target = input.bankAccountId ? bankAcc(input.bankAccountId) : cashAcc();
  return {
    txn,
    movements: [],
    lines: buildLines(txn, [
      { account: target, debit: amount, description: desc },
      { account: incomeAcc(), credit: amount, description: desc, mainLedger: 'Income' },
    ]),
  };
}

// --- Party-to-party balance transfer (spec §15) -----------------------------

export interface PartyTransferInput {
  fromPartyId: string;
  toPartyId: string;
  amount: number;
  date: ISODate;
  description?: string;
}

/**
 * Moves a balance between two parties with NO cash/bank effect and no P&L
 * impact (spec §15). Both sides share one txnId and reference.
 */
export function buildPartyTransfer(data: PdcDataSet, input: PartyTransferInput): Posting {
  const amount = round2(input.amount);
  const txn = makeTxn(data, 'Party Transfer', input.date, amount, {
    partyId: input.fromPartyId,
    toPartyId: input.toPartyId,
    description: input.description,
  });
  const from = data.parties.find((p) => p.id === input.fromPartyId)?.name ?? 'party';
  const to = data.parties.find((p) => p.id === input.toPartyId)?.name ?? 'party';
  const desc = input.description || `Balance transfer ${from} → ${to}`;
  return {
    txn,
    movements: [],
    lines: buildLines(txn, [
      { account: partyAcc(input.toPartyId), debit: amount, description: desc, relatedPartyId: input.fromPartyId, mainLedger: 'Transfers' },
      { account: partyAcc(input.fromPartyId), credit: amount, description: desc, relatedPartyId: input.toPartyId, mainLedger: 'Transfers' },
    ]),
  };
}

// --- Bank-to-bank transfer (spec §16) ---------------------------------------

export interface BankTransferInput {
  fromBankAccountId: string;
  toBankAccountId: string;
  amount: number;
  date: ISODate;
  reference?: string;
  description?: string;
}

export function buildBankTransfer(data: PdcDataSet, input: BankTransferInput): Posting {
  const amount = round2(input.amount);
  const txn = makeTxn(data, 'Bank Transfer', input.date, amount, {
    fromBankAccountId: input.fromBankAccountId,
    toBankAccountId: input.toBankAccountId,
    description: input.description,
  });
  const desc = input.description || 'Bank transfer';
  return {
    txn,
    movements: [],
    lines: buildLines(txn, [
      { account: bankAcc(input.toBankAccountId), debit: amount, description: desc, relatedBankAccountId: input.fromBankAccountId, mainLedger: 'Transfers' },
      { account: bankAcc(input.fromBankAccountId), credit: amount, description: desc, relatedBankAccountId: input.toBankAccountId, mainLedger: 'Transfers' },
    ]),
  };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export function partyName(data: PdcDataSet, id?: string): string {
  if (!id) return '';
  return data.parties.find((p) => p.id === id)?.name ?? '—';
}

export function bankAccountLabel(
  banks: Bank[],
  accounts: BankAccount[],
  accountId?: string
): string {
  if (!accountId) return '';
  const acc = accounts.find((a) => a.id === accountId);
  if (!acc) return '—';
  const bank = banks.find((b) => b.id === acc.bankId);
  return bank ? `${bank.name} — ${acc.title}` : acc.title;
}

export function holderLabel(data: PdcDataSet, holder: ChequeHolder): string {
  switch (holder.kind) {
    case 'business': return data.settings.businessName || 'Business';
    case 'party': return partyName(data, holder.partyId);
    case 'bank': return bankAccountLabel(data.banks, data.bankAccounts, holder.bankAccountId);
  }
}

/** A party's balance stated as receivable / payable / settled (spec §5). */
export function balanceLabel(bal: number): 'Receivable' | 'Payable' | 'Settled' {
  if (bal > 0) return 'Receivable';
  if (bal < 0) return 'Payable';
  return 'Settled';
}
