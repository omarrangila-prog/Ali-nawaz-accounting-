import { create } from 'zustand';
import type {
  Party,
  BondType,
  Purchase,
  Sale,
  CashTransaction,
  MonthlyClosing,
  Settings,
  Period,
  PaymentMode,
  CashDirection,
  FileAccount,
  OpeningBalances,
  Expense,
  ExpenseCategory,
  StockAdjustment,
  PartyAdjustment,
} from '@/types';
import {
  subscribeCollection,
  upsertDoc,
  removeDoc,
  bulkUpsert,
  listOnce,
  type CollectionName,
} from '@/firebase/dataAccess';
import {
  type DataSet,
  computeStock,
  computePartyBalances,
  computeFinancials,
  avgCostFor,
  computeProfitLoss,
} from '@/lib/accounting';
import { uid, now, periodOf, todayISO, round2, monthName, normalizeDenomination, normalizeName, shiftDateToPeriod } from '@/lib/utils';
import { toast } from './toast';

const DEFAULT_SETTINGS: Settings = {
  businessName: 'Ali Nawaz',
  ownerName: 'Ali Nawaz',
  currency: 'Rs',
  smartEntryEnabled: true,
  settlementMode: 'pending', // default: balances stay pending until settled
  updatedAt: now(),
};

interface DataStore {
  uidRef: string | null;
  ready: boolean;
  online: boolean;

  parties: Party[];
  bondTypes: BondType[];
  purchases: Purchase[];
  sales: Sale[];
  cash: CashTransaction[];
  closings: MonthlyClosing[];
  fileAccounts: FileAccount[];
  expenses: Expense[];
  stockAdjustments: StockAdjustment[];
  partyAdjustments: PartyAdjustment[];
  opening: OpeningBalances | null;
  settings: Settings;

  period: Period;

  // lifecycle
  bind: (userUid: string) => void;
  unbind: () => void;
  setPeriod: (p: Period) => void;
  setOnline: (v: boolean) => void;

  // derived
  dataset: () => DataSet;
  isMonthLocked: (p?: Period) => boolean;
  isMonthClosed: (p?: Period) => boolean;

  // masters
  addParty: (p: Omit<Party, 'id' | 'createdAt' | 'updatedAt'>) => Promise<Party>;
  ensureParty: (name: string) => Promise<Party>;
  updateParty: (id: string, patch: Partial<Party>) => Promise<void>;
  deleteParty: (id: string) => Promise<void>;
  addBondType: (b: Omit<BondType, 'id' | 'createdAt' | 'updatedAt'>) => Promise<BondType>;
  ensureBondType: (name: string, faceValue?: number) => Promise<BondType>;
  updateBondType: (id: string, patch: Partial<BondType>) => Promise<void>;
  deleteBondType: (id: string) => Promise<void>;
  updateSettings: (s: Partial<Settings>) => Promise<void>;

  // transactions
  addPurchase: (input: PurchaseInput) => Promise<boolean>;
  addSale: (input: SaleInput) => Promise<boolean>;
  addCash: (input: CashInput) => Promise<boolean>;
  updatePurchase: (id: string, input: PurchaseInput) => Promise<boolean>;
  updateSale: (id: string, input: SaleInput) => Promise<boolean>;
  updateCash: (id: string, input: CashInput) => Promise<boolean>;
  addExpense: (input: ExpenseInput) => Promise<boolean>;
  updateExpense: (id: string, input: ExpenseInput) => Promise<boolean>;
  deleteExpense: (id: string) => Promise<void>;
  addStockAdjustment: (input: StockAdjustmentInput) => Promise<boolean>;
  deleteStockAdjustment: (id: string) => Promise<void>;
  addPartyAdjustment: (input: PartyAdjustmentInput) => Promise<boolean>;
  updatePartyAdjustment: (id: string, input: PartyAdjustmentInput) => Promise<boolean>;
  deletePartyAdjustment: (id: string) => Promise<void>;
  /** Settle every currently-outstanding party balance to zero (used when
   *  turning on Auto Settled Mode for existing data). Returns count settled. */
  settleAllOutstanding: (date: string) => Promise<number>;
  deleteRecord: (
    kind: 'purchases' | 'sales' | 'cashTransactions',
    id: string
  ) => Promise<void>;

  // closing
  closeMonth: (p: Period, closedBy: string) => Promise<MonthlyClosing | null>;
  /** If the given month was closed, silently refresh its snapshot after an edit. */
  resyncClosing: (p: Period) => Promise<void>;

  /** Count records in a period (for the Move Month preview). */
  countInPeriod: (p: Period) => { purchases: number; sales: number; cash: number; expenses: number; total: number };
  /** Move ALL records (purchases/sales/cash/expenses) from one month to another. */
  moveMonth: (from: Period, to: Period) => Promise<number>;
  /** DANGER: permanently delete every record. Optionally keep parties & bond types. */
  resetAllData: (opts?: { keepMasters?: boolean }) => Promise<void>;
  /** Delete any transaction/adjustment whose partyId no longer exists. Returns
   *  the number of orphan records removed. */
  cleanOrphans: () => Promise<number>;

  // migration
  importBulk: (payload: ImportPayload) => Promise<void>;
  importOpeningMigration: (bundle: MigrationImport) => Promise<boolean>;
  saveOpeningWizard: (input: OpeningWizardInput) => Promise<boolean>;
  /** Set the Cash Book opening cash for the current period (start-of-day cash). */
  setOpeningCash: (amount: number) => Promise<void>;
  clearOpeningMigration: () => Promise<void>;
}

export interface MigrationImport {
  parties: Party[];
  bondTypes: BondType[];
  files: FileAccount[];
  opening: OpeningBalances;
}

export interface PurchaseInput {
  date: string;
  partyId: string;
  bondTypeId: string;
  quantity: number;
  rate: number;
  payment: PaymentMode;
  note?: string;
}
export interface SaleInput {
  date: string;
  partyId: string;
  bondTypeId: string;
  quantity: number;
  rate: number;
  receipt: PaymentMode;
  note?: string;
}
export interface CashInput {
  date: string;
  partyId: string;
  direction: CashDirection;
  amount: number;
  note?: string;
}
export interface ExpenseInput {
  date: string;
  kind: 'expense' | 'income';
  category: string;
  amount: number;
  description?: string;
}
export interface StockAdjustmentInput {
  date: string;
  bondTypeId: string;
  quantity: number;   // + add / - remove
  unitCost: number;
  reason: string;
}
export interface PartyAdjustmentInput {
  date: string;
  partyId: string;
  amount: number;   // +receivable / -payable
  reason: string;
  settlement?: boolean;
}

/** Input from the Opening Balance Import Wizard. */
export interface OpeningWizardInput {
  asOf: Period;
  openingCash: number;
  stock: { bondTypeName: string; qty: number; value: number }[];
  receivables: { name: string; amount: number }[]; // amount owed TO us (+)
  payables: { name: string; amount: number }[];     // amount we owe (+, stored −)
  banks: { name: string; balance: number }[];
}

export interface ImportPayload {
  parties?: Party[];
  bondTypes?: BondType[];
  purchases?: Purchase[];
  sales?: Sale[];
  cash?: CashTransaction[];
}

let unsubs: Array<() => void> = [];

const PERIOD_KEY = 'bond.period';
/** Read the last-selected month from localStorage, else the current month. */
function loadPersistedPeriod(): Period {
  try {
    const raw = localStorage.getItem(PERIOD_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (
        typeof p?.month === 'number' && p.month >= 1 && p.month <= 12 &&
        typeof p?.year === 'number' && p.year >= 2000 && p.year <= 2100
      ) return { month: p.month, year: p.year };
    }
  } catch { /* fall through to current month */ }
  const d = new Date();
  return { month: d.getMonth() + 1, year: d.getFullYear() };
}
function savePersistedPeriod(p: Period): void {
  try { localStorage.setItem(PERIOD_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

export const useData = create<DataStore>((set, get) => ({
  uidRef: null,
  ready: false,
  online: navigator.onLine,

  parties: [],
  bondTypes: [],
  purchases: [],
  sales: [],
  cash: [],
  closings: [],
  fileAccounts: [],
  expenses: [],
  stockAdjustments: [],
  partyAdjustments: [],
  opening: null,
  settings: DEFAULT_SETTINGS,

  // Selected month persists across refreshes (localStorage), falling back to
  // the current month on first run or if the stored value is invalid.
  period: loadPersistedPeriod(),

  bind: (userUid) => {
    get().unbind();
    set({ uidRef: userUid, ready: false });

    // Gate `ready` on the FIRST snapshot of the core financial collections, so
    // the app never renders a false "empty" state before Firestore data arrives
    // (which previously looked like lost data next to a slow snapshot).
    const coreCollections = [
      'parties', 'bondTypes', 'purchases', 'sales',
      'cashTransactions', 'expenses', 'partyAdjustments',
    ];
    const pending = new Set(coreCollections);
    const markArrived = (name: string) => {
      if (pending.delete(name) && pending.size === 0) set({ ready: true });
    };

    const sub = <T,>(name: any, key: keyof DataStore) =>
      subscribeCollection<T>(userUid, name, (rows) => {
        set({ [key]: rows } as any);
        markArrived(name);
      });

    unsubs = [
      sub<Party>('parties', 'parties'),
      sub<BondType>('bondTypes', 'bondTypes'),
      sub<Purchase>('purchases', 'purchases'),
      sub<Sale>('sales', 'sales'),
      sub<CashTransaction>('cashTransactions', 'cash'),
      sub<MonthlyClosing>('monthlyClosings', 'closings'),
      sub<FileAccount>('fileAccounts', 'fileAccounts'),
      sub<Expense>('expenses', 'expenses'),
      sub<StockAdjustment>('stockAdjustments', 'stockAdjustments'),
      sub<PartyAdjustment>('partyAdjustments', 'partyAdjustments'),
      subscribeCollection<Settings & { id: string }>(userUid, 'settings', (rows) => {
        const s = rows.find((r) => r.id === 'app');
        if (s) set({ settings: { ...DEFAULT_SETTINGS, ...s } });
      }),
      subscribeCollection<OpeningBalances>(userUid, 'openingBalances', (rows) => {
        set({ opening: rows.find((r) => r.id === 'opening') ?? null });
      }),
    ];

    // Safety net: never hang on the splash if a collection is slow/offline —
    // reveal the app after 4s even if some first snapshots haven't landed.
    setTimeout(() => set({ ready: true }), 4000);
  },

  unbind: () => {
    unsubs.forEach((u) => u());
    unsubs = [];
    set({ ready: false });
  },

  setPeriod: (p) => { savePersistedPeriod(p); set({ period: p }); },
  setOnline: (v) => set({ online: v }),

  dataset: () => {
    const s = get();
    return {
      parties: s.parties,
      bondTypes: s.bondTypes,
      purchases: s.purchases,
      sales: s.sales,
      cash: s.cash,
      closings: s.closings,
      opening: s.opening,
      expenses: s.expenses,
      stockAdjustments: s.stockAdjustments,
      partyAdjustments: s.partyAdjustments,
    };
  },

  // Months are NEVER locked — every record stays editable in any month,
  // including closed ones. Closing only creates a summary snapshot + carries
  // balances forward; it does not prevent add/edit/delete. Use isMonthClosed()
  // for informational UI only.
  isMonthLocked: () => false,

  isMonthClosed: (p) => {
    const period = p ?? get().period;
    return get().closings.some(
      (c) => c.month === period.month && c.year === period.year
    );
  },

  addParty: async (p) => {
    const u = get().uidRef;
    if (!u) { toast.error('Not ready yet — try again in a moment.'); throw new Error('no workspace'); }
    const target = normalizeName(p.name);
    const dup = get().parties.find((x) => normalizeName(x.name) === target);
    if (dup) return dup;
    const party: Party = { id: uid(), createdAt: now(), updatedAt: now(), ...p, name: p.name.trim() };
    await upsertDoc(u, 'parties', party);
    toast.success(`Party ${party.name} created.`);
    return party;
  },

  ensureParty: async (name) => {
    const target = normalizeName(name);
    const existing = get().parties.find((p) => normalizeName(p.name) === target);
    if (existing) return existing;
    return get().addParty({ name: name.trim(), openingBalance: 0 });
  },

  updateParty: async (id, patch) => {
    const u = get().uidRef!;
    const cur = get().parties.find((p) => p.id === id);
    if (!cur) return;
    await upsertDoc(u, 'parties', { ...cur, ...patch, updatedAt: now() });
    toast.success('Party updated.');
  },

  deleteParty: async (id) => {
    const u = get().uidRef!;
    // Any party can be deleted. Existing transactions are KEPT (they simply lose
    // their party name and show as "Cash"/"—" in the ledger), so no financial
    // amounts are lost — only the party record is removed.
    await removeDoc(u, 'parties', id);
    toast.info('Party deleted.');
  },

  addBondType: async (b) => {
    const u = get().uidRef;
    if (!u) { toast.error('Not ready yet — try again in a moment.'); throw new Error('no workspace'); }
    // Prevent duplicate denominations (1,500 == 1500 == "1500").
    const target = normalizeDenomination(b.name);
    const dup = get().bondTypes.find((x) => normalizeDenomination(x.name) === target);
    if (dup) { toast.info(`Bond ${dup.name} already exists.`); return dup; }
    const bond: BondType = { id: uid(), createdAt: now(), updatedAt: now(), ...b, name: b.name.trim() };
    await upsertDoc(u, 'bondTypes', bond);
    toast.success(`Bond type ${bond.name} created.`);
    return bond;
  },

  ensureBondType: async (name, faceValue) => {
    const target = normalizeDenomination(name);
    const existing = get().bondTypes.find((b) => normalizeDenomination(b.name) === target);
    if (existing) return existing;
    const fv = faceValue ?? (Number(name.replace(/,/g, '')) || 0);
    return get().addBondType({ name: name.trim(), faceValue: fv });
  },

  updateBondType: async (id, patch) => {
    const u = get().uidRef!;
    const cur = get().bondTypes.find((b) => b.id === id);
    if (!cur) return;
    await upsertDoc(u, 'bondTypes', { ...cur, ...patch, updatedAt: now() });
    toast.success('Bond type updated.');
  },

  deleteBondType: async (id) => {
    const u = get().uidRef!;
    const s = get();
    const inUse = s.purchases.some((p) => p.bondTypeId === id) || s.sales.some((x) => x.bondTypeId === id);
    if (inUse) {
      toast.error('Bond type has transactions — cannot delete.');
      return;
    }
    await removeDoc(u, 'bondTypes', id);
    toast.info('Bond type deleted.');
  },

  updateSettings: async (s) => {
    const u = get().uidRef!;
    const merged = { ...get().settings, ...s, updatedAt: now() };
    await upsertDoc(u, 'settings', { id: 'app', ...merged } as any);
    set({ settings: merged });
  },

  addPurchase: async (input) => {
    const u = get().uidRef!;
    const { month, year } = periodOf(input.date);
    if (get().isMonthLocked({ month, year })) {
      toast.error(`${monthName(month)} ${year} is closed and locked.`);
      return false;
    }
    if (input.quantity <= 0 || input.rate <= 0) {
      toast.error('Quantity and rate must be positive.');
      return false;
    }
    // Reconciliation model: a NAMED party => credit (builds that party's
    // outstanding payable, no immediate cash effect). No party => cash (flows
    // straight into Cash in Hand). This keeps daily reconciliation accurate.
    const partyId = input.partyId || '';
    const payment: PaymentMode = partyId ? 'credit' : 'cash';
    const amount = round2(input.quantity * input.rate);
    const rec: Purchase = {
      id: uid(),
      date: input.date,
      month,
      year,
      partyId,
      bondTypeId: input.bondTypeId,
      quantity: input.quantity,
      rate: input.rate,
      amount,
      payment,
      note: input.note,
      createdAt: now(),
      updatedAt: now(),
    };
    await upsertDoc(u, 'purchases', rec);
    await get().resyncClosing({ month: rec.month, year: rec.year });
    toast.success(`Purchase saved · ${amount.toLocaleString()}`);
    return true;
  },

  addSale: async (input) => {
    const u = get().uidRef!;
    const { month, year } = periodOf(input.date);
    const period = { month, year };
    if (get().isMonthLocked(period)) {
      toast.error(`${monthName(month)} ${year} is closed and locked.`);
      return false;
    }
    if (input.quantity <= 0 || input.rate <= 0) {
      toast.error('Quantity and rate must be positive.');
      return false;
    }
    // UNLIMITED STOCK: a sale is NEVER blocked or interrupted by stock. The app
    // just records the quantity sold; net stock may go negative and that's fine.
    // Reconciliation model: a NAMED party => credit (builds that party's
    // outstanding receivable, no immediate cash effect). No party => cash
    // (flows straight into Cash in Hand).
    const partyId = input.partyId || '';
    const receipt: PaymentMode = partyId ? 'credit' : 'cash';
    const amount = round2(input.quantity * input.rate);
    const unitCost = avgCostFor(get().dataset(), input.bondTypeId, period);
    const costOfGoods = round2(unitCost * input.quantity);
    const rec: Sale = {
      id: uid(),
      date: input.date,
      month,
      year,
      partyId,
      bondTypeId: input.bondTypeId,
      quantity: input.quantity,
      rate: input.rate,
      amount,
      receipt,
      costOfGoods,
      profit: round2(amount - costOfGoods),
      note: input.note,
      createdAt: now(),
      updatedAt: now(),
    };
    await upsertDoc(u, 'sales', rec);
    await get().resyncClosing({ month: rec.month, year: rec.year });
    toast.success(`Sale saved · profit ${rec.profit.toLocaleString()}`);
    return true;
  },

  addCash: async (input) => {
    const u = get().uidRef!;
    const { month, year } = periodOf(input.date);
    if (get().isMonthLocked({ month, year })) {
      toast.error(`${monthName(month)} ${year} is closed and locked.`);
      return false;
    }
    if (input.amount <= 0) {
      toast.error('Amount must be positive.');
      return false;
    }
    // Party optional: a no-party cash entry just moves cash-in-hand, without
    // settling anyone's balance.
    const rec: CashTransaction = {
      id: uid(),
      date: input.date,
      month,
      year,
      partyId: input.partyId || '',
      direction: input.direction,
      amount: round2(input.amount),
      note: input.note,
      createdAt: now(),
      updatedAt: now(),
    };
    await upsertDoc(u, 'cashTransactions', rec);
    await get().resyncClosing({ month: rec.month, year: rec.year });
    toast.success(
      `Cash ${input.direction} · ${rec.amount.toLocaleString()}`
    );
    return true;
  },

  updatePurchase: async (id, input) => {
    const u = get().uidRef!;
    const cur = get().purchases.find((p) => p.id === id);
    if (!cur) return false;
    const { month, year } = periodOf(input.date);
    if (get().isMonthLocked({ month, year })) { toast.error('Month is locked.'); return false; }
    if (input.quantity <= 0 || input.rate <= 0) { toast.error('Quantity and rate must be positive.'); return false; }
    const amount = round2(input.quantity * input.rate);
    const partyId = input.partyId || '';
    const rec: Purchase = {
      ...cur, date: input.date, month, year, partyId, bondTypeId: input.bondTypeId,
      quantity: input.quantity, rate: input.rate, amount, payment: partyId ? 'credit' : 'cash', note: input.note, updatedAt: now(),
    };
    await upsertDoc(u, 'purchases', rec);
    await get().resyncClosing({ month: rec.month, year: rec.year });
    toast.success('Purchase updated.');
    return true;
  },

  updateSale: async (id, input) => {
    const u = get().uidRef!;
    const cur = get().sales.find((s) => s.id === id);
    if (!cur) return false;
    const { month, year } = periodOf(input.date);
    const period = { month, year };
    if (get().isMonthLocked(period)) { toast.error('Month is locked.'); return false; }
    if (input.quantity <= 0 || input.rate <= 0) { toast.error('Quantity and rate must be positive.'); return false; }
    // Unlimited stock — no oversell check.
    const amount = round2(input.quantity * input.rate);
    const unitCost = avgCostFor(get().dataset(), input.bondTypeId, period);
    const costOfGoods = round2(unitCost * input.quantity);
    const partyId = input.partyId || '';
    const rec: Sale = {
      ...cur, date: input.date, month, year, partyId, bondTypeId: input.bondTypeId,
      quantity: input.quantity, rate: input.rate, amount, receipt: partyId ? 'credit' : 'cash',
      costOfGoods, profit: round2(amount - costOfGoods), note: input.note, updatedAt: now(),
    };
    await upsertDoc(u, 'sales', rec);
    await get().resyncClosing({ month: rec.month, year: rec.year });
    toast.success('Sale updated.');
    return true;
  },

  updateCash: async (id, input) => {
    const u = get().uidRef!;
    const cur = get().cash.find((c) => c.id === id);
    if (!cur) return false;
    const { month, year } = periodOf(input.date);
    if (get().isMonthLocked({ month, year })) { toast.error('Month is locked.'); return false; }
    if (input.amount <= 0) { toast.error('Amount must be positive.'); return false; }
    const rec: CashTransaction = {
      ...cur, date: input.date, month, year, partyId: input.partyId,
      direction: input.direction, amount: round2(input.amount), note: input.note, updatedAt: now(),
    };
    await upsertDoc(u, 'cashTransactions', rec);
    await get().resyncClosing({ month: rec.month, year: rec.year });
    toast.success('Cash entry updated.');
    return true;
  },

  addExpense: async (input) => {
    const u = get().uidRef;
    if (!u) { toast.error('Not ready yet.'); return false; }
    const { month, year } = periodOf(input.date);
    if (get().isMonthLocked({ month, year })) { toast.error(`${monthName(month)} ${year} is locked.`); return false; }
    if (input.amount <= 0) { toast.error('Amount must be positive.'); return false; }
    if (!input.category.trim()) { toast.error('Enter a category.'); return false; }
    const rec: Expense = {
      id: uid(), date: input.date, month, year, kind: input.kind,
      category: input.category.trim(), amount: round2(input.amount),
      description: input.description, createdAt: now(), updatedAt: now(),
    };
    await upsertDoc(u, 'expenses', rec);
    await get().resyncClosing({ month: rec.month, year: rec.year });
    toast.success(`${input.kind === 'income' ? 'Income' : 'Expense'} saved · ${rec.amount.toLocaleString()}`);
    return true;
  },

  updateExpense: async (id, input) => {
    const u = get().uidRef!;
    const cur = get().expenses.find((e) => e.id === id);
    if (!cur) return false;
    const { month, year } = periodOf(input.date);
    if (get().isMonthLocked({ month, year })) { toast.error('Month is locked.'); return false; }
    if (input.amount <= 0) { toast.error('Amount must be positive.'); return false; }
    const rec: Expense = {
      ...cur, date: input.date, month, year, kind: input.kind,
      category: input.category.trim(), amount: round2(input.amount),
      description: input.description, updatedAt: now(),
    };
    await upsertDoc(u, 'expenses', rec);
    await get().resyncClosing({ month: rec.month, year: rec.year });
    toast.success('Entry updated.');
    return true;
  },

  deleteExpense: async (id) => {
    const u = get().uidRef!;
    const rec = get().expenses.find((e) => e.id === id);
    await removeDoc(u, 'expenses', id);
    if (rec) await get().resyncClosing({ month: rec.month, year: rec.year });
    toast.info('Entry deleted.');
  },

  addStockAdjustment: async (input) => {
    const u = get().uidRef;
    if (!u) { toast.error('Not ready yet.'); return false; }
    const { month, year } = periodOf(input.date);
    if (input.quantity === 0) { toast.error('Enter a quantity to add or remove.'); return false; }
    if (input.unitCost < 0) { toast.error('Cost cannot be negative.'); return false; }
    if (!input.bondTypeId) { toast.error('Select a bond type.'); return false; }
    // Unlimited stock — allow any adjustment (net qty may go negative).
    const rec: StockAdjustment = {
      id: uid(), date: input.date, month, year,
      bondTypeId: input.bondTypeId, quantity: input.quantity,
      unitCost: round2(input.unitCost), reason: input.reason.trim() || 'Adjustment',
      createdAt: now(), updatedAt: now(),
    };
    await upsertDoc(u, 'stockAdjustments', rec);
    await get().resyncClosing({ month, year });
    toast.success(`Stock ${input.quantity > 0 ? 'added' : 'removed'}: ${Math.abs(input.quantity)} bonds.`);
    return true;
  },

  deleteStockAdjustment: async (id) => {
    const u = get().uidRef!;
    const rec = get().stockAdjustments.find((a) => a.id === id);
    await removeDoc(u, 'stockAdjustments', id);
    if (rec) await get().resyncClosing({ month: rec.month, year: rec.year });
    toast.info('Adjustment deleted.');
  },

  addPartyAdjustment: async (input) => {
    const u = get().uidRef;
    if (!u) { toast.error('Not ready yet.'); return false; }
    const { month, year } = periodOf(input.date);
    if (!input.partyId) { toast.error('Select a party.'); return false; }
    if (input.amount === 0) { toast.error('Enter an amount.'); return false; }
    const rec: PartyAdjustment = {
      id: uid(), date: input.date, month, year,
      partyId: input.partyId, amount: round2(input.amount),
      reason: input.reason.trim() || (input.amount > 0 ? 'Receivable' : 'Payable'),
      settlement: input.settlement || false,
      createdAt: now(), updatedAt: now(),
    };
    await upsertDoc(u, 'partyAdjustments', rec);

    // Auto Settled Mode (Easy-Khata style): a NEW manual receivable/payable
    // immediately gets a matching Received/Paid settlement so the party nets to
    // zero. Only for genuine new entries (never for settlements themselves).
    const autoMode = get().settings.settlementMode === 'auto';
    if (autoMode && !rec.settlement) {
      const settle: PartyAdjustment = {
        id: uid(), date: rec.date, month, year,
        partyId: rec.partyId, amount: -rec.amount,          // opposite sign clears it
        reason: rec.amount > 0 ? 'Received (auto-settled)' : 'Paid (auto-settled)',
        settlement: true,
        createdAt: now(), updatedAt: now(),
      };
      await upsertDoc(u, 'partyAdjustments', settle);
    }

    await get().resyncClosing({ month, year });
    toast.success(
      input.settlement
        ? `Settled · ${Math.abs(rec.amount).toLocaleString()}`
        : autoMode
          ? `${input.amount > 0 ? 'Receivable' : 'Payable'} recorded & ${input.amount > 0 ? 'received' : 'paid'} · ${Math.abs(rec.amount).toLocaleString()}`
          : `${input.amount > 0 ? 'Receivable' : 'Payable'} recorded · ${Math.abs(rec.amount).toLocaleString()}`
    );
    return true;
  },

  updatePartyAdjustment: async (id, input) => {
    const u = get().uidRef;
    if (!u) { toast.error('Not ready yet.'); return false; }
    const cur = get().partyAdjustments.find((a) => a.id === id);
    if (!cur) return false;
    if (!input.partyId) { toast.error('Select a party.'); return false; }
    if (input.amount === 0) { toast.error('Enter an amount.'); return false; }
    const { month, year } = periodOf(input.date);
    const rec: PartyAdjustment = {
      ...cur,
      date: input.date, month, year,
      partyId: input.partyId, amount: round2(input.amount),
      reason: input.reason.trim() || (input.amount > 0 ? 'Receivable' : 'Payable'),
      settlement: input.settlement ?? cur.settlement ?? false,
      updatedAt: now(),
    };
    await upsertDoc(u, 'partyAdjustments', rec);
    // Resync the old month too, in case the date moved to a different period.
    if (cur.month !== month || cur.year !== year) {
      await get().resyncClosing({ month: cur.month, year: cur.year });
    }
    await get().resyncClosing({ month, year });
    toast.success('Entry updated.');
    return true;
  },

  deletePartyAdjustment: async (id) => {
    const u = get().uidRef!;
    const rec = get().partyAdjustments.find((a) => a.id === id);
    await removeDoc(u, 'partyAdjustments', id);
    if (rec) await get().resyncClosing({ month: rec.month, year: rec.year });
    toast.info('Entry deleted.');
  },

  settleAllOutstanding: async (date) => {
    const u = get().uidRef;
    if (!u) { toast.error('Not ready yet.'); return 0; }
    const { month, year } = periodOf(date);
    const data = get().dataset();
    // One settlement per party whose current net balance is non-zero. Additive:
    // it does NOT delete any existing entry — the original receivable/payable
    // rows stay in the ledger; a settlement row nets each party to zero.
    const balances = computePartyBalances(data, get().period)
      .filter((b) => Math.abs(b.balance) > 0.005);
    for (const b of balances) {
      const settle: PartyAdjustment = {
        id: uid(), date, month, year,
        partyId: b.partyId, amount: -round2(b.balance), // opposite of the net
        reason: b.balance > 0 ? 'Received (settled)' : 'Paid (settled)',
        settlement: true,
        createdAt: now(), updatedAt: now(),
      };
      await upsertDoc(u, 'partyAdjustments', settle);
    }
    await get().resyncClosing({ month, year });
    if (balances.length) toast.success(`Settled ${balances.length} outstanding balance${balances.length === 1 ? '' : 's'}.`);
    return balances.length;
  },

  deleteRecord: async (kind, id) => {
    const u = get().uidRef!;
    // Find the record's period before removing, to refresh a closed month.
    const all = kind === 'purchases' ? get().purchases : kind === 'sales' ? get().sales : get().cash;
    const rec = all.find((r) => r.id === id);
    await removeDoc(u, kind, id);
    if (rec) await get().resyncClosing({ month: rec.month, year: rec.year });
    toast.info('Record deleted.');
  },

  closeMonth: async (p, closedBy) => {
    const u = get().uidRef!;
    // Re-closing is allowed and simply refreshes the summary/snapshot — useful
    // after editing records in an already-closed month.
    const reclosing = get().isMonthClosed(p);
    const data = get().dataset();
    const stock = computeStock(data, p);
    const balances = computePartyBalances(data, p);

    const totalPurchase = data.purchases
      .filter((r) => r.month === p.month && r.year === p.year)
      .reduce((a, r) => a + r.amount, 0);
    const totalSale = data.sales
      .filter((r) => r.month === p.month && r.year === p.year)
      .reduce((a, r) => a + r.amount, 0);
    // Profit including expenses & income for this period.
    const profit = computeProfitLoss(data, p);
    // Cash / receivable / payable ALL from the shared Financial Engine so the
    // snapshot matches the dashboard & reports exactly.
    const fin = computeFinancials(data, p);
    const receivable = fin.netReceivable;
    const payable = fin.netPayable;
    const closingStockValue = stock.reduce((a, s) => a + s.closingValue, 0);
    const closingStockQty = stock.reduce((a, s) => a + s.closingQty, 0);

    const closing: MonthlyClosing = {
      id: `${p.year}-${String(p.month).padStart(2, '0')}`,
      month: p.month,
      year: p.year,
      closedAt: now(),
      closedBy,
      stockSnapshot: stock,
      partyBalances: balances.map((b) => ({ partyId: b.partyId, balance: b.balance })),
      summary: {
        totalPurchase: round2(totalPurchase),
        totalSale: round2(totalSale),
        closingStockQty,
        closingStockValue: round2(closingStockValue),
        cashReceivable: round2(receivable),
        cashPayable: round2(payable),
        cashInHand: fin.cashInHand,
        netBalance: round2(fin.cashInHand + closingStockValue),
        profitLoss: round2(profit),
        trialBalanced: true,
      },
    };
    await upsertDoc(u, 'monthlyClosings', closing as any);
    toast.success(
      reclosing
        ? `${monthName(p.month)} ${p.year} summary refreshed.`
        : `${monthName(p.month)} ${p.year} closed. Balances carried forward.`
    );
    return closing;
  },

  resyncClosing: async (p) => {
    const u = get().uidRef;
    if (!u || !get().isMonthClosed(p)) return;
    const data = get().dataset();
    const stock = computeStock(data, p);
    const balances = computePartyBalances(data, p);
    const inP = (r: { month: number; year: number }) => r.month === p.month && r.year === p.year;
    const totalPurchase = data.purchases.filter(inP).reduce((a, r) => a + r.amount, 0);
    const totalSale = data.sales.filter(inP).reduce((a, r) => a + r.amount, 0);
    // Same shared Financial Engine as closeMonth / dashboard / reports.
    const fin = computeFinancials(data, p);
    const closingStockValue = stock.reduce((a, s) => a + s.closingValue, 0);
    const existing = get().closings.find((c) => c.month === p.month && c.year === p.year)!;
    const closing: MonthlyClosing = {
      ...existing,
      stockSnapshot: stock,
      partyBalances: balances.map((b) => ({ partyId: b.partyId, balance: b.balance })),
      summary: {
        totalPurchase: round2(totalPurchase),
        totalSale: round2(totalSale),
        closingStockQty: stock.reduce((a, s) => a + s.closingQty, 0),
        closingStockValue: round2(closingStockValue),
        cashReceivable: fin.netReceivable,
        cashPayable: fin.netPayable,
        cashInHand: fin.cashInHand,
        netBalance: round2(fin.cashInHand + closingStockValue),
        profitLoss: computeProfitLoss(data, p),
        trialBalanced: true,
      },
    };
    await upsertDoc(u, 'monthlyClosings', closing as any);
  },

  countInPeriod: (p) => {
    const s = get();
    const inP = (r: { month: number; year: number }) => r.month === p.month && r.year === p.year;
    const purchases = s.purchases.filter(inP).length;
    const sales = s.sales.filter(inP).length;
    const cash = s.cash.filter(inP).length;
    const expenses = s.expenses.filter(inP).length;
    return { purchases, sales, cash, expenses, total: purchases + sales + cash + expenses };
  },

  /**
   * Move every record from one month to another by re-dating it (day kept,
   * month/year changed). Purchases, sales, cash and expenses all move. Closing
   * snapshots for both months are refreshed so carry-forward stays correct.
   */
  moveMonth: async (from, to) => {
    const u = get().uidRef;
    if (!u) { toast.error('Not ready yet.'); return 0; }
    const s = get();
    const inFrom = (r: { month: number; year: number }) => r.month === from.month && r.year === from.year;
    let moved = 0;

    const reDate = async <T extends { id: string; date: string; month: number; year: number; updatedAt: number }>(
      rows: T[], coll: any
    ) => {
      for (const r of rows.filter(inFrom)) {
        const date = shiftDateToPeriod(r.date, to);
        await upsertDoc(u, coll, { ...r, date, month: to.month, year: to.year, updatedAt: now() });
        moved++;
      }
    };

    await reDate(s.purchases, 'purchases');
    await reDate(s.sales, 'sales');
    await reDate(s.cash, 'cashTransactions');
    await reDate(s.expenses, 'expenses');

    // Refresh closings for both months (source is now emptier, target fuller).
    await get().resyncClosing(from);
    await get().resyncClosing(to);

    if (moved > 0) {
      toast.success(`Moved ${moved} record${moved === 1 ? '' : 's'} from ${monthName(from.month)} ${from.year} to ${monthName(to.month)} ${to.year}.`);
      // Jump the view to the target month so the user sees the result.
      set({ period: to });
    } else {
      toast.info(`No records found in ${monthName(from.month)} ${from.year}.`);
    }
    return moved;
  },

  /**
   * DANGER: permanently delete all records. Enumerates each collection from the
   * backend (not just in-memory state) and removes every document. When
   * keepMasters is true, parties + bond types are preserved.
   */
  resetAllData: async (opts) => {
    const u = get().uidRef;
    if (!u) { toast.error('Not ready yet.'); return; }
    // Every accounting/transaction collection the app writes to — nothing left
    // orphaned. partyAdjustments & stockAdjustments were previously missed and
    // silently corrupted balances after a reset.
    const collections: CollectionName[] = [
      'purchases', 'sales', 'cashTransactions', 'partyAdjustments',
      'stockAdjustments', 'expenses', 'ledgerEntries', 'monthlyClosings',
      'openingBalances', 'fileAccounts', 'expenseCategories',
    ];
    if (!opts?.keepMasters) {
      collections.push('parties', 'bondTypes');
    }
    let deleted = 0;
    for (const coll of collections) {
      const rows = await listOnce<{ id: string }>(u, coll);
      for (const r of rows) {
        await removeDoc(u, coll, r.id);
        deleted++;
      }
    }
    // Clear the in-memory opening snapshot immediately.
    set({ opening: null });
    toast.success(`All data cleared${opts?.keepMasters ? ' (parties & bonds kept)' : ''}. ${deleted} records removed.`);
    // A full reset can't leave orphans, but a keepMasters reset shouldn't either.
    if (opts?.keepMasters) await get().cleanOrphans();
  },

  /**
   * Maintenance: delete any party-linked record whose partyId no longer exists
   * in the Parties collection. Keeps the DB tidy and prevents stale
   * receivable/payable adjustments from lingering after a party is removed.
   * Reads live from the backend so it also catches records not yet in memory.
   */
  cleanOrphans: async () => {
    const u = get().uidRef;
    if (!u) { toast.error('Not ready yet.'); return 0; }
    const parties = await listOnce<{ id: string }>(u, 'parties');
    const alive = new Set(parties.map((p) => p.id));
    // Collections whose rows carry a partyId. A blank partyId ('') is a valid
    // cash/no-party record and must NOT be treated as an orphan.
    const linked: CollectionName[] = ['purchases', 'sales', 'cashTransactions', 'partyAdjustments'];
    let removed = 0;
    for (const coll of linked) {
      const rows = await listOnce<{ id: string; partyId?: string }>(u, coll);
      for (const r of rows) {
        if (r.partyId && !alive.has(r.partyId)) {
          await removeDoc(u, coll, r.id);
          removed++;
        }
      }
    }
    if (removed > 0) toast.success(`Cleaned ${removed} orphan record${removed === 1 ? '' : 's'}.`);
    return removed;
  },

  importBulk: async (payload) => {
    const u = get().uidRef!;
    if (payload.parties?.length) await bulkUpsert(u, 'parties', payload.parties);
    if (payload.bondTypes?.length) await bulkUpsert(u, 'bondTypes', payload.bondTypes);
    if (payload.purchases?.length) await bulkUpsert(u, 'purchases', payload.purchases);
    if (payload.sales?.length) await bulkUpsert(u, 'sales', payload.sales);
    if (payload.cash?.length) await bulkUpsert(u, 'cashTransactions', payload.cash);
    toast.success('Old data imported successfully.');
  },

  /**
   * One-time old-Excel migration. Creates parties, bond types, file accounts
   * and a singleton opening-balances doc. Refuses to run twice (duplicate
   * guard) — the opening doc's presence is the lock.
   */
  importOpeningMigration: async (bundle) => {
    const u = get().uidRef!;
    if (get().opening) {
      toast.error('Old data was already imported. Reset it first to re-import.');
      return false;
    }
    if (bundle.parties.length) await bulkUpsert(u, 'parties', bundle.parties);
    if (bundle.bondTypes.length) await bulkUpsert(u, 'bondTypes', bundle.bondTypes);
    if (bundle.files.length) await bulkUpsert(u, 'fileAccounts', bundle.files);
    await upsertDoc(u, 'openingBalances', bundle.opening as any);
    // Jump the app to the opening period so the imported figures are visible.
    set({ period: bundle.opening.asOf });
    toast.success('Old Excel data imported as opening balances.');
    return true;
  },

  saveOpeningWizard: async (input) => {
    const u = get().uidRef;
    if (!u) { toast.error('Not ready yet.'); return false; }
    if (get().opening) {
      toast.error('Opening balances already exist. Reset data first to re-import.');
      return false;
    }
    const nowTs = now();

    // 1. Ensure every party (receivable + payable) exists, get its id.
    const partyLines: { partyId: string; balance: number }[] = [];
    for (const r of input.receivables) {
      if (!r.name.trim() || !r.amount) continue;
      const p = await get().ensureParty(r.name.trim());
      partyLines.push({ partyId: p.id, balance: round2(Math.abs(r.amount)) });   // +receivable
    }
    for (const p0 of input.payables) {
      if (!p0.name.trim() || !p0.amount) continue;
      const p = await get().ensureParty(p0.name.trim());
      partyLines.push({ partyId: p.id, balance: -round2(Math.abs(p0.amount)) });  // −payable
    }

    // 2. Ensure bond types + build opening stock lines.
    const stockLines = [] as OpeningBalances['stock'];
    for (const s of input.stock) {
      if (!s.bondTypeName.trim() || (s.qty === 0 && s.value === 0)) continue;
      const bt = await get().ensureBondType(s.bondTypeName.trim());
      const qty = round2(s.qty);
      const value = round2(s.value);
      stockLines.push({
        bondTypeId: bt.id, bondTypeName: bt.name,
        qty, value, avgCost: qty ? round2(value / qty) : 0,
      });
    }

    // 3. Bank / file accounts.
    const fileLines: { fileAccountId: string; balance: number }[] = [];
    for (const b of input.banks) {
      if (!b.name.trim()) continue;
      const acc: FileAccount = { id: uid(), name: b.name.trim(), balance: round2(b.balance), createdAt: nowTs, updatedAt: nowTs };
      await upsertDoc(u, 'fileAccounts', acc);
      fileLines.push({ fileAccountId: acc.id, balance: acc.balance });
    }

    // 4. ONE opening snapshot — no historical transactions. importedProfit = 0
    //    so profit starts fresh from the migration date.
    const opening: OpeningBalances = {
      id: 'opening', asOf: input.asOf,
      stock: stockLines, parties: partyLines, files: fileLines,
      openingCash: round2(input.openingCash),
      importedProfit: 0, source: 'opening_wizard', createdAt: nowTs,
    };
    await upsertDoc(u, 'openingBalances', opening as any);
    set({ period: input.asOf });
    toast.success('Opening balances saved. You can start recording from today.');
    return true;
  },

  setOpeningCash: async (amount) => {
    const u = get().uidRef;
    if (!u) { toast.error('Not ready yet.'); return; }
    const cur = get().opening;
    const opening: OpeningBalances = cur
      ? { ...cur, openingCash: round2(amount) }
      : {
          id: 'opening', asOf: get().period,
          stock: [], parties: [], files: [],
          openingCash: round2(amount), importedProfit: 0,
          source: 'cashbook_opening', createdAt: now(),
        };
    await upsertDoc(u, 'openingBalances', opening as any);
    await get().resyncClosing(get().period);
  },

  clearOpeningMigration: async () => {
    const u = get().uidRef!;
    const op = get().opening;
    if (!op) return;
    // Remove the opening doc + the migration-tagged file accounts.
    await removeDoc(u, 'openingBalances', 'opening');
    for (const f of get().fileAccounts.filter((f) => f.source === 'old_excel_migration')) {
      await removeDoc(u, 'fileAccounts', f.id);
    }
    set({ opening: null });
    toast.info('Old-data import reset. You can import again.');
  },
}));

// Expose the store on window in dev so automated QA can drive real actions.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as any).__bondStore = useData;
}

// Track connectivity for the offline banner + auto-sync UX.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    useData.getState().setOnline(true);
    toast.success('Back online — syncing…');
  });
  window.addEventListener('offline', () => {
    useData.getState().setOnline(false);
    toast.warning('Offline — changes saved locally and will sync.');
  });
}

export { todayISO };
