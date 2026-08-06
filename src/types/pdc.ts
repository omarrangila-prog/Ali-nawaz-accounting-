/**
 * Ali Nawaz PDC — Domain types
 *
 * A post-dated-cheque, party-ledger and payment management model kept fully
 * SEPARATE from the bond-trading types in `@/types`. Nothing here shares a
 * Firestore collection with the bond app, so both can live in one project
 * without either corrupting the other's balances.
 *
 * Accounting model (spec §6, §31): every financial action posts BALANCED
 * double-entry lines that all share one `txnId`. Balances are always derived by
 * replaying ledger entries — never stored as a mutable running total — so
 * reports and the Cashbook can never disagree.
 */

import type { ISODate } from '@/types';

// ---------------------------------------------------------------------------
// Accounts — the main-ledger / sub-ledger hierarchy (spec §4)
// ---------------------------------------------------------------------------

/** Main ledgers. Each sub-ledger (party, bank account, cash) hangs off one. */
export type MainLedger =
  | 'Parties'
  | 'Banks'
  | 'Cash'
  | 'Receivables'
  | 'Payables'
  | 'PDC Received'
  | 'PDC Issued'
  | 'Transfers'
  | 'Adjustments'
  /** Trading income — sales revenue. */
  | 'Sales'
  /** Trading cost — purchases. */
  | 'Purchases'
  /** Running costs (rent, salary, commission…). */
  | 'Expenses'
  /** Other income that isn't a sale. */
  | 'Income';

/**
 * An account reference used on a ledger line. `kind` picks the main ledger and
 * `id` names the sub-ledger (party id / bank account id). Cash is a singleton,
 * so its id is the constant CASH_ACCOUNT_ID.
 */
export type AccountKind = 'party' | 'bank' | 'cash' | 'ledger';

export interface AccountRef {
  kind: AccountKind;
  /** Party id, bank-account id, or CASH_ACCOUNT_ID. */
  id: string;
}

/** The single cash-in-hand account id (Cash is not a user-created record). */
export const CASH_ACCOUNT_ID = 'CASH';

// ---------------------------------------------------------------------------
// Parties (spec §20)
// ---------------------------------------------------------------------------

/**
 * A named ledger — typically a salesman or a book of business (Najeeb,
 * Kamran…). Two things roll into its balance:
 *
 *   1. entries posted DIRECTLY to the ledger (e.g. cash the salesman took)
 *   2. the balances of every party assigned to it (his customers)
 *
 * A party may be assigned to several ledgers, so ledger totals can legitimately
 * overlap — `sharedPartyIds` on the computed view makes that visible rather
 * than letting it quietly mislead.
 */
export interface NamedLedger {
  id: string;
  name: string;
  /** Optional label, e.g. "Salesman — North zone". */
  description?: string;
  /**
   * Parent ledger this one sits under, making it a SUB-LEDGER.
   *
   * Example: parent "Yameen" with sub-ledgers "Jeeb" and "Kamran". A parent's
   * total rolls up its own entries, its own parties, and every sub-ledger
   * beneath it. Undefined means this is a top-level (parent) ledger.
   *
   * Only ONE level of nesting is supported: a sub-ledger cannot itself have
   * children. That keeps the roll-up unambiguous and makes cycles impossible.
   */
  parentId?: string;
  /**
   * Opening balance for the ledger's OWN account (not its parties').
   * Positive => receivable, negative => payable.
   */
  openingBalance: number;
  active: boolean;
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PdcParty {
  id: string;
  name: string;
  /**
   * Main ledgers this party belongs to. A party may sit under several
   * (e.g. a customer served by two salesmen); an empty list means the party
   * is unassigned and appears only in the global party list.
   */
  ledgerIds?: string[];
  phone?: string;
  address?: string;
  /** CNIC or business registration number. */
  cnic?: string;
  /**
   * Opening balance. Positive => receivable (they owe us).
   * Negative => payable (we owe them).
   */
  openingBalance: number;
  /** Optional credit ceiling; 0 / undefined means no limit enforced. */
  creditLimit?: number;
  /** Free-text terms e.g. "30 days". */
  paymentTerms?: string;
  notes?: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Banks & bank accounts (spec §21)
// ---------------------------------------------------------------------------

/** A bank. One bank may hold many accounts. */
export interface Bank {
  id: string;
  name: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface BankAccount {
  id: string;
  bankId: string;
  /** Account title, e.g. "Main Account". */
  title: string;
  accountNumber?: string;
  iban?: string;
  branch?: string;
  openingBalance: number;
  active: boolean;
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Cheques (spec §17, §18)
// ---------------------------------------------------------------------------

/** Which direction a cheque flows relative to the business. */
export type ChequeDirection = 'received' | 'issued';

/**
 * Statuses for a RECEIVED cheque (spec §17). `transferred` means the cheque was
 * endorsed to another party and is no longer in our custody.
 */
export type ReceivedChequeStatus =
  | 'pending'
  | 'transferred'
  | 'deposited'
  | 'cleared'
  | 'bounced'
  | 'returned'
  | 'cancelled'
  | 'replaced';

/** Statuses for an ISSUED cheque (spec §17). */
export type IssuedChequeStatus =
  | 'pending'
  | 'presented'
  | 'cleared'
  | 'bounced'
  | 'returned'
  | 'cancelled'
  | 'replaced';

export type ChequeStatus = ReceivedChequeStatus | IssuedChequeStatus;

/**
 * A physical cheque. There is exactly ONE record per physical cheque for its
 * entire life (spec §31.4) — transferring it to another party updates
 * `holder` and appends a movement, and never clones the record.
 */
export interface Cheque {
  id: string;
  direction: ChequeDirection;
  /** Cheque serial number as printed. */
  chequeNumber: string;
  /** Bank the cheque is drawn on. */
  bankId: string;
  /**
   * For an ISSUED cheque, the account it is drawn from (ours). For a RECEIVED
   * cheque this is undefined until the cheque is deposited into one of our
   * accounts.
   */
  bankAccountId?: string;
  /** Cheque (due) date — the date it may be presented. */
  chequeDate: ISODate;
  /** Date the cheque entered our books. */
  date: ISODate;
  amount: number;
  /** The party the cheque was originally received from / issued to. */
  partyId: string;
  status: ChequeStatus;
  /**
   * Who currently holds the cheque. `kind: 'business'` means it is in our
   * custody; `kind: 'party'` means it has been endorsed to that party;
   * `kind: 'bank'` means it has been deposited and is with the bank.
   */
  holder: ChequeHolder;
  /** Amount already allocated to payables via transfer (spec §14). */
  allocatedAmount: number;
  drawerName?: string;
  accountNumber?: string;
  branch?: string;
  description?: string;
  reference?: string;
  notes?: string;
  /** Set when this cheque replaces a bounced one (spec §19). */
  replacesChequeId?: string;
  /** Set on the bounced cheque, pointing at its replacement. */
  replacedByChequeId?: string;
  /** Bounce details, when status is 'bounced'. */
  bouncedOn?: ISODate;
  bounceReason?: string;
  createdAt: number;
  updatedAt: number;
}

export type ChequeHolder =
  | { kind: 'business' }
  | { kind: 'party'; partyId: string }
  | { kind: 'bank'; bankAccountId: string };

// ---------------------------------------------------------------------------
// Transactions (spec §3)
// ---------------------------------------------------------------------------

/** Every kind of entry that can appear in the Cash Book register. */
export type PdcTxnType =
  // --- everyday trading & running costs ---
  | 'Sale'
  | 'Purchase'
  | 'Expense'
  | 'Income'
  // --- cheques ---
  | 'PDC Received'
  | 'PDC Issued'
  // --- money in / out ---
  | 'Cash Received'
  | 'Cash Paid'
  | 'Debit Adjustment'
  | 'Credit Adjustment'
  | 'Party Transfer'
  | 'Cheque Endorsement'
  | 'Bank Transfer'
  | 'Cheque Deposited'
  | 'Cheque Cleared'
  | 'Cheque Bounced'
  | 'Cheque Returned'
  | 'Cheque Replacement'
  | 'Reversal';

/**
 * The header record for one financial event. Its balanced ledger lines live in
 * `PdcLedgerEntry` rows sharing this record's `id` as their `txnId`.
 */
export interface PdcTransaction {
  id: string;
  /** Human-facing sequential reference, e.g. "PDCR-000012". */
  reference: string;
  type: PdcTxnType;
  date: ISODate;
  /** 1-12, derived from `date` — lets the app filter by accounting period. */
  month: number;
  year: number;
  amount: number;
  description?: string;
  /** Primary party this entry belongs to (the "from" side for transfers). */
  partyId?: string;
  /** Counterparty for party-to-party transfers. */
  toPartyId?: string;
  /** Bank account moved FROM (bank transfers, deposits, issued cheques). */
  fromBankAccountId?: string;
  /** Bank account moved TO (bank transfers, deposits). */
  toBankAccountId?: string;
  /** The cheque this entry acts on, when applicable. */
  chequeId?: string;
  /**
   * How a Sale / Purchase / Expense / Income was settled.
   * 'cash'   → money moved immediately (cash or bank)
   * 'credit' → left on the party's account as receivable / payable
   */
  settlement?: 'cash' | 'credit';
  /** Free-text category for Expense / Income rows (Rent, Salary, …). */
  category?: string;
  /** Optional quantity / rate detail for trading rows. */
  quantity?: number;
  rate?: number;
  /**
   * How the money moved, as the user chose it on the form. `settlement` only
   * records cash-vs-credit for the accounting; this keeps the finer answer so
   * the register and details can say "Bank" rather than just "Cash".
   */
  paymentMethod?: 'cash' | 'bank' | 'credit' | 'debit' | 'cheque';
  /** What was sold or bought, for trading rows. */
  itemName?: string;
  /** Set when this transaction reverses another (spec §26). */
  reversesTxnId?: string;
  /** Set on the original once it has been reversed. */
  reversedByTxnId?: string;
  /** True once reversed — the row stays visible but is struck through. */
  reversed?: boolean;
  createdAt: number;
  updatedAt: number;
  createdBy?: string;
}

/**
 * One side of a double-entry posting. Every `txnId` group MUST sum to zero
 * (total debit === total credit) — enforced by `assertBalanced` in pdcEngine
 * and covered by tests.
 */
export interface PdcLedgerEntry {
  id: string;
  txnId: string;
  /** Copied from the parent transaction for fast filtering. */
  date: ISODate;
  month: number;
  year: number;
  /** Which sub-ledger this line posts to. */
  account: AccountRef;
  /** Main ledger this line rolls up into, for report grouping. */
  mainLedger: MainLedger;
  type: PdcTxnType;
  description: string;
  /** Debit increases receivable / cash / bank. */
  debit: number;
  /** Credit increases payable, or decreases cash / bank. */
  credit: number;
  /** Denormalised for ledger display. */
  chequeId?: string;
  /** The other party involved, shown as "Related Party" in the ledger. */
  relatedPartyId?: string;
  relatedBankAccountId?: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Cheque movement timeline (spec §18)
// ---------------------------------------------------------------------------

/**
 * An append-only audit of everything that ever happened to a cheque. Never
 * updated or deleted once written (spec §18: "must never be overwritten").
 */
export interface ChequeMovement {
  id: string;
  chequeId: string;
  /** Wall-clock time of the action. */
  at: number;
  date: ISODate;
  action: string;
  fromStatus?: ChequeStatus;
  toStatus?: ChequeStatus;
  fromHolder?: ChequeHolder;
  toHolder?: ChequeHolder;
  fromPartyId?: string;
  toPartyId?: string;
  bankAccountId?: string;
  /** The transaction that caused this movement. */
  txnId?: string;
  reference?: string;
  description?: string;
  user?: string;
}

/** A slice of a cheque applied against a party's payable (spec §14). */
export interface ChequeAllocation {
  id: string;
  chequeId: string;
  partyId: string;
  amount: number;
  date: ISODate;
  txnId: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Audit log (spec §27)
// ---------------------------------------------------------------------------

export type AuditAction =
  | 'create'
  | 'edit'
  | 'delete'
  | 'reverse'
  | 'status-change'
  | 'cheque-transfer'
  | 'party-transfer'
  | 'bank-transfer'
  | 'cheque-clear'
  | 'cheque-bounce'
  | 'cheque-replace'
  | 'party-rename'
  | 'bank-change';

export interface PdcAuditLog {
  id: string;
  at: number;
  date: ISODate;
  user: string;
  action: AuditAction;
  /** What kind of record changed, e.g. "cheque" / "transaction" / "party". */
  entity: string;
  entityId: string;
  /** Connected transaction, when the change was financial. */
  txnId?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  reason?: string;
  description?: string;
}

// ---------------------------------------------------------------------------
// Settings (spec §14 configurability)
// ---------------------------------------------------------------------------

export interface PdcSettings {
  id: 'pdcSettings';
  businessName: string;
  currency: string;
  /**
   * Spec §14: physical endorsement usually requires a cheque to have exactly
   * one holder, so partial allocation is OFF by default and a full transfer is
   * required. Turn on to split one cheque across several payables.
   */
  allowPartialAllocation: boolean;
  /** Warn when a bank account can't cover its upcoming issued cheques (§24). */
  lowBalanceWarnings: boolean;
  updatedAt: number;
}

export const DEFAULT_PDC_SETTINGS: Omit<PdcSettings, 'updatedAt'> = {
  id: 'pdcSettings',
  businessName: 'Ali Nawaz',
  currency: 'Rs',
  allowPartialAllocation: false,
  lowBalanceWarnings: true,
};

// ---------------------------------------------------------------------------
// Derived / view models
// ---------------------------------------------------------------------------

/** Everything the PDC engine reads from. Passed to every pure compute fn. */
export interface PdcDataSet {
  parties: PdcParty[];
  /** Named ledgers (Najeeb, Kamran…). */
  ledgers: NamedLedger[];
  banks: Bank[];
  bankAccounts: BankAccount[];
  cheques: Cheque[];
  transactions: PdcTransaction[];
  ledger: PdcLedgerEntry[];
  movements: ChequeMovement[];
  allocations: ChequeAllocation[];
  audit: PdcAuditLog[];
  settings: PdcSettings;
}

/**
 * A ledger with everything rolled up: its own balance, each assigned party's
 * balance, and the combined total.
 */
export interface LedgerView {
  ledger: NamedLedger;
  /** Balance of entries posted directly to the ledger itself. */
  ownBalance: number;
  /** One row per assigned party, with that party's balance. */
  parties: Array<{
    party: PdcParty;
    balance: number;
    /** True when this party also belongs to another ledger. */
    shared: boolean;
    /** Names of the other ledgers sharing this party. */
    sharedWith: string[];
  }>;
  /** Sum of every assigned party's balance. */
  partiesTotal: number;
  /**
   * Sub-ledgers sitting under this one (empty for a sub-ledger itself).
   * Example: parent "Yameen" listing "Jeeb" and "Kamran".
   */
  subLedgers: Array<{ ledger: NamedLedger; total: number }>;
  /** Combined total of every sub-ledger. */
  subLedgersTotal: number;
  /** ownBalance + partiesTotal + subLedgersTotal — the headline figure. */
  total: number;
  /** Positive portion of `total` across parties (money owed to you). */
  receivable: number;
  /** Negative portion (money you owe). */
  payable: number;
  /**
   * Ids of parties that also sit under another ledger. Their balances appear
   * in more than one ledger total, so those totals legitimately overlap.
   */
  sharedPartyIds: string[];
}

/** A row in the main transaction register (spec §3). */
export interface RegisterRow {
  txn: PdcTransaction;
  /** Net effect on the row's primary account, for the Debit/Credit columns. */
  debit: number;
  credit: number;
  /** Running cash+bank balance through this row, in date order. */
  running: number;
  cheque?: Cheque;
  partyName: string;
  toPartyName: string;
  bankLabel: string;
  status?: ChequeStatus;
  holderLabel: string;
  /** "Cash" / "Bank" / "Credit" / "Debit" / "Cheque". */
  method: string;
  /** Bank name when the entry touched one, else empty. */
  bankName: string;
}

/** Live totals for the summary bar (spec §2). */
export interface PdcSummary {
  totalReceivable: number;
  totalPayable: number;
  pendingReceivedCheques: number;
  pendingIssuedCheques: number;
  dueToday: number;
  overdue: number;
  cleared: number;
  bounced: number;
  cashBalance: number;
  bankBalance: number;
  /** cash + all banks — the one "money we actually have" figure. */
  totalFunds: number;
  /**
   * Value of every cheque still outstanding, in or out — the headline
   * "Total Cheques" figure on the Cash Book.
   */
  totalCheques: number;
  /** Count of those outstanding cheques. */
  totalChequeCount: number;
  totalSales: number;
  totalPurchases: number;
  totalExpenses: number;
  otherIncome: number;
  /** (Sales + Other Income) − (Purchases + Expenses) */
  netProfit: number;
}

/** Which summary card is filtering the register. */
export type SummaryFilter =
  | 'all'
  | 'receivable'
  | 'payable'
  | 'pending-received'
  | 'pending-issued'
  | 'due-today'
  | 'overdue'
  | 'cleared'
  | 'bounced'
  | 'cash'
  | 'bank'
  | 'sales'
  | 'purchases'
  | 'expenses';
