/**
 * Ali Nawaz PDC — report builders (spec §23)
 *
 * Every report is assembled from the SAME projection helpers the Cashbook uses
 * (pdcRegister / pdcEngine), so a report can never disagree with the screen
 * (spec §31.11, §31.12).
 */

import type jsPDF from 'jspdf';
import type { Cheque, PdcDataSet, PdcTxnType } from '@/types/pdc';
import { money } from './exportPdf';
import {
  buildDesignedPdf,
  compact,
  T,
  type ChartSpec,
  type DesignSection,
  type Kpi,
  type RGB,
} from './pdfDesign';
import {
  bankAccountLabel,
  bankBalances,
  cashBalance,
  computeProfit,
  computeSummary,
  holderLabel,
  partyBalances,
  partyName,
  balanceLabel,
} from './pdcEngine';
import { buildBankLedger, buildPartyLedger, buildRegister, fundsDelta } from './pdcRegister';
import { formatDate, todayISO } from './utils';

/** Every report the module can produce (spec §23). */
export type PdcReportId =
  | 'cashbook'
  | 'profit-loss'
  | 'sales'
  | 'purchases'
  | 'expenses'
  | 'balance-sheet'
  | 'pdc-received'
  | 'pdc-issued'
  | 'receivable'
  | 'payable'
  | 'due-today'
  | 'upcoming'
  | 'overdue'
  | 'deposited'
  | 'cleared'
  | 'bounced'
  | 'returned'
  | 'cancelled'
  | 'cheque-transfers'
  | 'party-transfers'
  | 'bank-transfers'
  | 'party-ledger'
  | 'party-statement'
  | 'bank-ledger'
  | 'cash-ledger'
  | 'debit-credit'
  | 'daily'
  | 'monthly'
  | 'audit';

/** Visual grouping on the Reports page. */
export type PdcReportGroup =
  | 'Financial'
  | 'Trading'
  | 'Cheques'
  | 'Ledgers'
  | 'Activity';

/** Colour token driving each card's icon tile. */
export type PdcReportTone =
  | 'blue' | 'green' | 'red' | 'orange' | 'purple' | 'slate';

export interface PdcReportMeta {
  id: PdcReportId;
  title: string;
  description: string;
  group: PdcReportGroup;
  /** Icon name from the shared Icon set. */
  icon: string;
  tone: PdcReportTone;
  /** Highlighted as a headline report on the page. */
  featured?: boolean;
  /** Needs a party chosen before it can run. */
  needsParty?: boolean;
  /** Needs a bank account chosen. */
  needsAccount?: boolean;
}

export const PDC_REPORTS: PdcReportMeta[] = [
  // --- Financial ---
  { id: 'cashbook', title: 'Complete Cash Book', description: 'Every transaction with running balance', group: 'Financial', icon: 'book', tone: 'blue', featured: true },
  { id: 'profit-loss', title: 'Profit & Loss', description: 'Income less purchases and expenses', group: 'Financial', icon: 'trend-up', tone: 'green', featured: true },
  { id: 'balance-sheet', title: 'Balance Sheet', description: 'What you own and what you owe', group: 'Financial', icon: 'scale', tone: 'purple', featured: true },
  { id: 'receivable', title: 'Receivable Report', description: 'Outstanding amounts owed to you', group: 'Financial', icon: 'receivable', tone: 'green' },
  { id: 'payable', title: 'Payable Report', description: 'Outstanding amounts you owe', group: 'Financial', icon: 'payable', tone: 'red' },
  { id: 'debit-credit', title: 'Debit & Credit', description: 'All manual adjustments', group: 'Financial', icon: 'scale', tone: 'slate' },

  // --- Trading ---
  { id: 'sales', title: 'Sales Report', description: 'All sales, cash and credit', group: 'Trading', icon: 'trend-up', tone: 'green' },
  { id: 'purchases', title: 'Purchase Report', description: 'All purchases, cash and credit', group: 'Trading', icon: 'trend-down', tone: 'red' },
  { id: 'expenses', title: 'Expense Report', description: 'Running costs by category', group: 'Trading', icon: 'receipt', tone: 'orange' },

  // --- Cheques ---
  { id: 'pdc-received', title: 'Cheques Received', description: 'All cheques received from parties', group: 'Cheques', icon: 'cheque-in', tone: 'green' },
  { id: 'pdc-issued', title: 'Cheques Issued', description: 'All cheques issued to parties', group: 'Cheques', icon: 'cheque-out', tone: 'red' },
  { id: 'due-today', title: 'Due Today', description: 'Cheques dated today', group: 'Cheques', icon: 'clock', tone: 'orange' },
  { id: 'upcoming', title: 'Upcoming Cheques', description: 'Due in the next 30 days', group: 'Cheques', icon: 'calendar', tone: 'blue' },
  { id: 'overdue', title: 'Overdue Cheques', description: 'Past due and still unsettled', group: 'Cheques', icon: 'alert-circle', tone: 'red' },
  { id: 'deposited', title: 'Deposited Cheques', description: 'Cheques lodged with a bank', group: 'Cheques', icon: 'bank', tone: 'blue' },
  { id: 'cleared', title: 'Cleared Cheques', description: 'Cheques that have cleared', group: 'Cheques', icon: 'check-circle', tone: 'green' },
  { id: 'bounced', title: 'Bounced Cheques', description: 'Bounced cheques and reasons', group: 'Cheques', icon: 'x-circle', tone: 'red' },
  { id: 'returned', title: 'Returned Cheques', description: 'Cheques returned unpaid', group: 'Cheques', icon: 'undo', tone: 'orange' },
  { id: 'cancelled', title: 'Cancelled Cheques', description: 'Cheques cancelled before use', group: 'Cheques', icon: 'close', tone: 'slate' },
  { id: 'cheque-transfers', title: 'Cheque Transfers', description: 'Every cheque endorsement', group: 'Cheques', icon: 'transfer', tone: 'purple' },

  // --- Ledgers ---
  { id: 'party-ledger', title: 'Party Ledger', description: 'One party, full ledger', group: 'Ledgers', icon: 'ledger', tone: 'blue', needsParty: true },
  { id: 'party-statement', title: 'Party Statement', description: 'Statement to share with a party', group: 'Ledgers', icon: 'clipboard', tone: 'purple', needsParty: true },
  { id: 'bank-ledger', title: 'Bank Ledger', description: 'One bank account, full ledger', group: 'Ledgers', icon: 'bank', tone: 'blue', needsAccount: true },
  { id: 'cash-ledger', title: 'Cash Ledger', description: 'Physical cash movements', group: 'Ledgers', icon: 'coins', tone: 'green' },
  { id: 'party-transfers', title: 'Party Transfers', description: 'Balances moved between parties', group: 'Ledgers', icon: 'transfer', tone: 'purple' },
  { id: 'bank-transfers', title: 'Bank Transfers', description: 'Movements between your accounts', group: 'Ledgers', icon: 'transfer', tone: 'blue' },

  // --- Activity ---
  { id: 'daily', title: 'Daily Summary', description: 'Transactions grouped by day', group: 'Activity', icon: 'calendar', tone: 'blue' },
  { id: 'monthly', title: 'Monthly Summary', description: 'Totals by month', group: 'Activity', icon: 'list', tone: 'slate' },
  { id: 'audit', title: 'Audit Trail', description: 'Every change ever made', group: 'Activity', icon: 'shield', tone: 'slate' },
];

/** Report groups in display order. */
export const PDC_REPORT_GROUPS: PdcReportGroup[] =
  ['Financial', 'Trading', 'Cheques', 'Ledgers', 'Activity'];

/** Filters a report run can apply (spec §23). */
export interface PdcReportFilters {
  from?: string;
  to?: string;
  partyId?: string;
  bankAccountId?: string;
  status?: string;
  search?: string;
}

export function pdcFileName(base: string): string {
  return `${base.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${todayISO()}.pdf`;
}

function inRange(date: string, f: PdcReportFilters): boolean {
  if (f.from && date < f.from) return false;
  if (f.to && date > f.to) return false;
  return true;
}

const M = (data: PdcDataSet) => (n: number) => money(n, data.settings.currency);

/** Rotating palette for category charts. */
const SERIES_TONES: RGB[] = [T.orange, T.blue, T.purple, T.green, T.red, T.slate];

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

function chequeSection(
  data: PdcDataSet,
  title: string,
  cheques: Cheque[]
): DesignSection {
  const m = M(data);
  return {
    title,
    subtitle: `${cheques.length} cheque${cheques.length === 1 ? '' : 's'}`,
    // WHEN → WHAT → WHO → MONEY → STATUS, matching the on-screen tables.
    head: ['Date', 'Due Date', 'Cheque #', 'Party', 'Bank', 'Amount', 'Status', 'Holder'],
    numericCols: [5],
    statusCol: 6,
    emptyText: 'No cheques match this selection.',
    rows: cheques.map((c) => [
      formatDate(c.date),
      formatDate(c.chequeDate),
      c.chequeNumber,
      partyName(data, c.partyId),
      data.banks.find((b) => b.id === c.bankId)?.name ?? '—',
      m(c.amount),
      c.status,
      holderLabel(data, c.holder),
    ]),
    foot: ['', '', '', '', 'Total', m(cheques.reduce((s, c) => s + c.amount, 0)), '', ''],
  };
}

/** Group cheques by status for a composition chart. */
function chequeStatusChart(cheques: Cheque[], title: string): ChartSpec {
  const by = new Map<string, number>();
  for (const c of cheques) by.set(c.status, (by.get(c.status) ?? 0) + c.amount);
  const tone: Record<string, RGB> = {
    pending: T.orange, cleared: T.green, bounced: T.red, transferred: T.purple,
    deposited: T.blue, presented: T.blue, returned: T.red, cancelled: T.slate, replaced: T.slate,
  };
  const total = cheques.reduce((s, c) => s + c.amount, 0);
  return {
    kind: 'donut',
    title,
    centerValue: compact(total),
    centerLabel: 'total',
    data: [...by.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, value]) => ({ label, value, color: tone[label] ?? T.slate })),
  };
}

/** Top parties by cheque value, as a bar chart. */
function topPartiesChart(
  data: PdcDataSet, cheques: Cheque[], title: string, color: RGB
): ChartSpec {
  const by = new Map<string, number>();
  for (const c of cheques) {
    const name = partyName(data, c.partyId);
    by.set(name, (by.get(name) ?? 0) + c.amount);
  }
  const cur = data.settings.currency;
  return {
    kind: 'bar',
    title,
    formatValue: (n) => money(n, cur),
    data: [...by.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([label, value]) => ({ label, value, color })),
  };
}

function txnSection(
  data: PdcDataSet,
  title: string,
  types: PdcTxnType[] | null,
  f: PdcReportFilters
): DesignSection {
  const m = M(data);
  const rows = buildRegister(data)
    .filter((r) => (!types || types.includes(r.txn.type)) && inRange(r.txn.date, f))
    .filter((r) => !f.partyId || r.txn.partyId === f.partyId || r.txn.toPartyId === f.partyId);

  return {
    title,
    subtitle: `${rows.length} transaction${rows.length === 1 ? '' : 's'}`,
    emptyText: 'No transactions match this selection.',
    head: ['Date', 'Reference', 'Type', 'Party', 'Cheque #', 'Debit', 'Credit', 'Balance'],
    numericCols: [5, 6, 7],
    rows: rows.map((r) => [
      formatDate(r.txn.date),
      r.txn.reference,
      r.txn.type,
      // Show the counterparty inline rather than as its own column, so the
      // remaining columns stay wide enough not to truncate. Plain ASCII "->"
      // because jsPDF's built-in Helvetica has no arrow glyph.
      r.toPartyName ? `${r.partyName} -> ${r.toPartyName}` : (r.partyName || '—'),
      r.cheque?.chequeNumber ?? '—',
      r.debit ? m(r.debit) : '—',
      r.credit ? m(r.credit) : '—',
      m(r.running),
    ]),
  };
}

/**
 * Net cash+bank movement per day, for the trend line.
 *
 * Delegates to `fundsDelta` — the SAME function the Cashbook register uses for
 * its running balance — so the chart and the register can never disagree about
 * what counts as money.
 */
function dailyTrend(data: PdcDataSet, f: PdcReportFilters): Array<{ label: string; value: number }> {
  const by = new Map<string, number>();
  for (const t of data.transactions) {
    if (!inRange(t.date, f)) continue;
    by.set(t.date, (by.get(t.date) ?? 0) + fundsDelta(data, t));
  }
  return [...by.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, value]) => ({ label: date.slice(5), value }));
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function buildPdcReport(
  data: PdcDataSet,
  id: PdcReportId,
  f: PdcReportFilters = {}
): jsPDF {
  const m = M(data);
  const today = todayISO();
  const meta = PDC_REPORTS.find((r) => r.id === id)!;
  const sections: DesignSection[] = [];
  let kpis: Kpi[] | undefined;
  let charts: ChartSpec[] | undefined;

  const live = (c: Cheque) => c.status === 'pending' || c.status === 'deposited' || c.status === 'presented';
  const dated = (c: Cheque) => inRange(c.date, f);

  switch (id) {
    case 'cashbook': {
      const s = computeSummary(data, today);
      kpis = [
        { label: 'Total Money', value: m(s.totalFunds), hint: 'cash + all banks', tone: 'blue' },
        { label: 'Receivable', value: m(s.totalReceivable), hint: 'owed to you', tone: 'green' },
        { label: 'Payable', value: m(s.totalPayable), hint: 'you owe', tone: 'red' },
        {
          label: s.netProfit >= 0 ? 'Net Profit' : 'Net Loss',
          value: m(Math.abs(s.netProfit)),
          tone: s.netProfit >= 0 ? 'green' : 'red',
        },
      ];
      charts = [
        {
          kind: 'donut',
          title: 'Where your money is',
          centerValue: compact(s.totalFunds),
          centerLabel: 'total',
          data: [
            { label: 'Cash in Hand', value: Math.max(0, s.cashBalance), color: T.green },
            { label: 'In Bank', value: Math.max(0, s.bankBalance), color: T.blue },
          ],
        },
        {
          kind: 'compare',
          title: 'Receivable vs Payable',
          left: { label: 'Receivable', value: s.totalReceivable, color: T.green },
          right: { label: 'Payable', value: s.totalPayable, color: T.red },
          formatValue: (n) => money(n, data.settings.currency),
        },
        ...(dailyTrend(data, f).length > 1
          ? [{
              kind: 'line' as const,
              title: 'Daily money movement',
              data: dailyTrend(data, f),
              formatValue: compact,
            }]
          : []),
      ];
      sections.push(txnSection(data, 'All Transactions', null, f));
      break;
    }

    case 'profit-loss': {
      const pl = computeProfit(data);
      kpis = [
        { label: 'Sales', value: m(pl.sales), tone: 'green' },
        { label: 'Purchases', value: m(pl.purchases), tone: 'red' },
        { label: 'Expenses', value: m(pl.expenses), tone: 'orange' },
        {
          label: pl.netProfit >= 0 ? 'Net Profit' : 'Net Loss',
          value: m(Math.abs(pl.netProfit)),
          hint: pl.sales > 0 ? `${Math.round((pl.netProfit / pl.sales) * 100)}% margin` : undefined,
          tone: pl.netProfit >= 0 ? 'green' : 'red',
        },
      ];
      charts = [
        {
          kind: 'compare',
          title: 'Income vs Costs',
          left: { label: 'Total Income', value: pl.sales + pl.otherIncome, color: T.green },
          right: { label: 'Total Costs', value: pl.purchases + pl.expenses, color: T.red },
          formatValue: (n) => money(n, data.settings.currency),
        },
        {
          kind: 'donut',
          title: 'What costs are made of',
          centerValue: compact(pl.purchases + pl.expenses),
          centerLabel: 'total costs',
          data: [
            { label: 'Purchases', value: pl.purchases, color: T.red },
            { label: 'Expenses', value: pl.expenses, color: T.orange },
          ],
        },
      ];
      sections.push({
        title: 'Profit & Loss Statement',
        head: ['Item', 'Amount'],
        numericCols: [1],
        rows: [
          ['Sales', m(pl.sales)],
          ['Other Income', m(pl.otherIncome)],
          ['Total Income', m(pl.sales + pl.otherIncome)],
          ['Purchases', m(pl.purchases)],
          ['Expenses', m(pl.expenses)],
          ['Total Costs', m(pl.purchases + pl.expenses)],
        ],
        foot: [pl.netProfit >= 0 ? 'NET PROFIT' : 'NET LOSS', m(Math.abs(pl.netProfit))],
      });
      // Expense detail so the total is never a black box.
      const byCat = new Map<string, number>();
      for (const t of data.transactions) {
        if (t.type !== 'Expense' || !inRange(t.date, f) || t.reversed) continue;
        const key = t.category || 'Uncategorised';
        byCat.set(key, (byCat.get(key) ?? 0) + t.amount);
      }
      if (byCat.size) {
        sections.push({
          title: 'Expenses by Category',
          head: ['Category', 'Amount'],
          numericCols: [1],
          rows: [...byCat.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, m(v)]),
          foot: ['Total', m([...byCat.values()].reduce((s, v) => s + v, 0))],
        });
      }
      break;
    }

    case 'balance-sheet': {
      const balances = partyBalances(data);
      let receivable = 0, payable = 0;
      for (const v of balances.values()) {
        if (v > 0) receivable += v; else payable += -v;
      }
      const cash = cashBalance(data);
      const banks = [...bankBalances(data).entries()];
      const bankTotal = banks.reduce((s, [, v]) => s + v, 0);
      const pl = computeProfit(data);
      const assets = cash + bankTotal + receivable;

      kpis = [
        { label: 'Total Assets', value: m(assets), hint: 'cash, bank & receivable', tone: 'blue' },
        { label: 'Liabilities', value: m(payable), hint: 'owed to parties', tone: 'red' },
        {
          label: 'Net Worth',
          value: m(assets - payable),
          tone: assets - payable >= 0 ? 'green' : 'red',
        },
        {
          label: pl.netProfit >= 0 ? 'Profit to Date' : 'Loss to Date',
          value: m(Math.abs(pl.netProfit)),
          tone: pl.netProfit >= 0 ? 'green' : 'red',
        },
      ];
      charts = [
        {
          kind: 'donut',
          title: 'What makes up your assets',
          centerValue: compact(assets),
          centerLabel: 'assets',
          data: [
            { label: 'Cash in Hand', value: Math.max(0, cash), color: T.green },
            { label: 'Bank Accounts', value: Math.max(0, bankTotal), color: T.blue },
            { label: 'Receivable', value: receivable, color: T.purple },
          ],
        },
        {
          kind: 'compare',
          title: 'Assets vs Liabilities',
          left: { label: 'Assets', value: assets, color: T.blue },
          right: { label: 'Liabilities', value: payable, color: T.red },
          formatValue: (n) => money(n, data.settings.currency),
        },
      ];
      sections.push({
        title: 'Assets — what you own',
        head: ['Item', 'Amount'],
        numericCols: [1],
        rows: [
          ['Cash in Hand', m(cash)],
          ...banks.map(([id, v]) => [bankAccountLabel(data.banks, data.bankAccounts, id), m(v)] as (string | number)[]),
          ['Receivable from parties', m(receivable)],
        ],
        foot: ['Total Assets', m(assets)],
      });
      sections.push({
        title: 'Liabilities — what you owe',
        head: ['Item', 'Amount'],
        numericCols: [1],
        rows: [['Payable to parties', m(payable)]],
        foot: ['Total Liabilities', m(payable)],
      });
      sections.push({
        title: 'Summary',
        head: ['', 'Amount'],
        numericCols: [1],
        rows: [
          ['Total Assets', m(assets)],
          ['Less: Liabilities', m(payable)],
          ['Profit / (Loss) to date', m(pl.netProfit)],
        ],
        foot: ['NET WORTH', m(assets - payable)],
      });
      break;
    }

    case 'sales':
    case 'purchases': {
      const type = id === 'sales' ? 'Sale' : 'Purchase';
      const rows = data.transactions
        .filter((t) => t.type === type && inRange(t.date, f) && (!f.partyId || t.partyId === f.partyId))
        .sort((a, b) => a.date.localeCompare(b.date));

      const total = rows.reduce((s, t) => s + t.amount, 0);
      const cashPart = rows.filter((t) => t.settlement === 'cash').reduce((s, t) => s + t.amount, 0);
      const creditPart = total - cashPart;
      const tone: 'green' | 'red' = id === 'sales' ? 'green' : 'red';
      const color = id === 'sales' ? T.green : T.red;

      // Value per party, for the top-parties bar chart.
      const byParty = new Map<string, number>();
      for (const t of rows) {
        const name = partyName(data, t.partyId);
        byParty.set(name, (byParty.get(name) ?? 0) + t.amount);
      }

      kpis = [
        { label: id === 'sales' ? 'Total Sales' : 'Total Purchases', value: m(total), tone },
        { label: 'Entries', value: String(rows.length), tone: 'slate' },
        { label: 'Cash / Bank', value: m(cashPart), tone: 'blue' },
        { label: 'On Credit', value: m(creditPart), tone: 'orange' },
      ];
      charts = [
        {
          kind: 'donut',
          title: 'Cash vs Credit',
          centerValue: compact(total),
          centerLabel: 'total',
          data: [
            { label: 'Cash / Bank', value: cashPart, color: T.blue },
            { label: 'On Credit', value: creditPart, color: T.orange },
          ],
        },
        {
          kind: 'bar',
          title: id === 'sales' ? 'Top customers' : 'Top suppliers',
          formatValue: (n) => money(n, data.settings.currency),
          data: [...byParty.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([label, value]) => ({ label, value, color })),
        },
      ];

      sections.push({
        title: id === 'sales' ? 'Sales' : 'Purchases',
        subtitle: `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}`,
        emptyText: id === 'sales' ? 'No sales in this period.' : 'No purchases in this period.',
        head: ['Date', 'Reference', 'Party', 'Payment', 'Description', 'Amount'],
        numericCols: [5],
        statusCol: 3,
        rows: rows.map((t) => [
          formatDate(t.date),
          t.reference,
          partyName(data, t.partyId),
          t.settlement === 'cash' ? 'Cash / Bank' : 'Credit',
          t.description ?? '—',
          m(t.amount),
        ]),
        foot: ['', '', '', '', 'Total', m(rows.reduce((s, t) => s + t.amount, 0))],
      });
      break;
    }

    case 'expenses': {
      const rows = data.transactions
        .filter((t) => (t.type === 'Expense' || t.type === 'Income') && inRange(t.date, f))
        .sort((a, b) => a.date.localeCompare(b.date));

      const expTotal = rows.filter((t) => t.type === 'Expense').reduce((s, t) => s + t.amount, 0);
      const incTotal = rows.filter((t) => t.type === 'Income').reduce((s, t) => s + t.amount, 0);
      const byCategory = new Map<string, number>();
      for (const t of rows) {
        if (t.type !== 'Expense') continue;
        const key = t.category || 'Uncategorised';
        byCategory.set(key, (byCategory.get(key) ?? 0) + t.amount);
      }
      const topCat = [...byCategory.entries()].sort((a, b) => b[1] - a[1])[0];

      kpis = [
        { label: 'Total Expenses', value: m(expTotal), tone: 'orange' },
        { label: 'Other Income', value: m(incTotal), tone: 'green' },
        { label: 'Net Effect', value: m(incTotal - expTotal), tone: incTotal - expTotal >= 0 ? 'green' : 'red' },
        {
          label: 'Biggest Category',
          value: topCat ? m(topCat[1]) : m(0),
          hint: topCat ? topCat[0] : undefined,
          tone: 'slate',
        },
      ];
      charts = [
        {
          kind: 'donut',
          title: 'Expenses by category',
          centerValue: compact(expTotal),
          centerLabel: 'expenses',
          data: [...byCategory.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([label, value], i) => ({ label, value, color: SERIES_TONES[i % SERIES_TONES.length] })),
        },
        {
          kind: 'bar',
          title: 'Top spending categories',
          formatValue: (n) => money(n, data.settings.currency),
          data: [...byCategory.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([label, value]) => ({ label, value, color: T.orange })),
        },
      ];

      sections.push({
        title: 'Expenses & Other Income',
        subtitle: `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}`,
        emptyText: 'No expenses or income recorded in this period.',
        head: ['Date', 'Reference', 'Type', 'Category', 'Description', 'Amount'],
        numericCols: [5],
        rows: rows.map((t) => [
          formatDate(t.date),
          t.reference,
          t.type,
          t.category ?? '—',
          t.description ?? '—',
          m(t.amount),
        ]),
      });
      break;
    }

    case 'pdc-received':
    case 'pdc-issued': {
      const dir = id === 'pdc-received' ? 'received' : 'issued';
      const list = data.cheques.filter((c) => c.direction === dir && dated(c));
      const tone: 'green' | 'red' = dir === 'received' ? 'green' : 'red';
      const color = dir === 'received' ? T.green : T.red;
      const liveList = list.filter(live);
      kpis = [
        { label: 'Total Value', value: m(list.reduce((s, c) => s + c.amount, 0)), tone },
        { label: 'Cheques', value: String(list.length), tone: 'slate' },
        { label: 'Still Outstanding', value: m(liveList.reduce((s, c) => s + c.amount, 0)), tone: 'orange' },
        {
          label: 'Cleared',
          value: m(list.filter((c) => c.status === 'cleared').reduce((s, c) => s + c.amount, 0)),
          tone: 'green',
        },
      ];
      charts = [
        chequeStatusChart(list, 'By status'),
        topPartiesChart(data, list, dir === 'received' ? 'Top parties (received)' : 'Top parties (issued)', color),
      ];
      sections.push(chequeSection(
        data, dir === 'received' ? 'Cheques Received' : 'Cheques Issued', list
      ));
      break;
    }

    case 'receivable': {
      const balances = partyBalances(data);
      const rows = data.parties
        .map((p) => ({ p, bal: balances.get(p.id) ?? 0 }))
        .filter((x) => x.bal > 0)
        .sort((a, b) => b.bal - a.bal);
      const total = rows.reduce((s, x) => s + x.bal, 0);
      kpis = [
        { label: 'Total Receivable', value: m(total), tone: 'green' },
        { label: 'Parties Owing', value: String(rows.length), tone: 'slate' },
        {
          label: 'Largest Balance',
          value: rows.length ? m(rows[0].bal) : m(0),
          hint: rows.length ? rows[0].p.name : undefined,
          tone: 'orange',
        },
      ];
      charts = [{
        kind: 'bar',
        title: 'Who owes you most',
        formatValue: (n) => money(n, data.settings.currency),
        data: rows.slice(0, 6).map((x) => ({ label: x.p.name, value: x.bal, color: T.green })),
      }];
      sections.push({
        title: 'Receivable by Party',
        subtitle: 'Largest balances first',
        emptyText: 'Nobody owes you anything right now.',
        head: ['Party', 'Amount Receivable'],
        numericCols: [1],
        rows: rows.map((x) => [x.p.name, m(x.bal)]),
        foot: ['Total', m(total)],
      });
      break;
    }

    case 'payable': {
      const balances = partyBalances(data);
      const rows = data.parties
        .map((p) => ({ p, bal: balances.get(p.id) ?? 0 }))
        .filter((x) => x.bal < 0)
        .sort((a, b) => a.bal - b.bal);
      const total = rows.reduce((s, x) => s - x.bal, 0);
      kpis = [
        { label: 'Total Payable', value: m(total), tone: 'red' },
        { label: 'Parties Owed', value: String(rows.length), tone: 'slate' },
        {
          label: 'Largest Balance',
          value: rows.length ? m(-rows[0].bal) : m(0),
          hint: rows.length ? rows[0].p.name : undefined,
          tone: 'orange',
        },
      ];
      charts = [{
        kind: 'bar',
        title: 'Who you owe most',
        formatValue: (n) => money(n, data.settings.currency),
        data: rows.slice(0, 6).map((x) => ({ label: x.p.name, value: -x.bal, color: T.red })),
      }];
      sections.push({
        title: 'Payable by Party',
        subtitle: 'Largest balances first',
        emptyText: 'You do not owe anybody right now.',
        head: ['Party', 'Amount Payable'],
        numericCols: [1],
        rows: rows.map((x) => [x.p.name, m(-x.bal)]),
        foot: ['Total', m(total)],
      });
      break;
    }

    case 'due-today':
    case 'upcoming':
    case 'overdue': {
      const in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
      const list = data.cheques.filter((c) => {
        if (!live(c)) return false;
        if (id === 'due-today') return c.chequeDate === today;
        if (id === 'upcoming') return c.chequeDate > today && c.chequeDate <= in30;
        return c.chequeDate < today;
      });
      const inbound = list.filter((c) => c.direction === 'received');
      const outbound = list.filter((c) => c.direction === 'issued');
      const sum = (cs: Cheque[]) => cs.reduce((s, c) => s + c.amount, 0);

      kpis = [
        { label: 'Cheques', value: String(list.length), tone: 'slate' },
        { label: 'Coming In', value: m(sum(inbound)), tone: 'green' },
        { label: 'Going Out', value: m(sum(outbound)), tone: 'red' },
        {
          label: 'Net Effect',
          value: m(sum(inbound) - sum(outbound)),
          tone: sum(inbound) - sum(outbound) >= 0 ? 'green' : 'red',
        },
      ];
      charts = [{
        kind: 'compare',
        title: 'Money in vs money out',
        left: { label: 'Coming In', value: sum(inbound), color: T.green },
        right: { label: 'Going Out', value: sum(outbound), color: T.red },
        formatValue: (n) => money(n, data.settings.currency),
      }];

      const title =
        id === 'due-today' ? `Cheques Due ${formatDate(today)}`
        : id === 'upcoming' ? 'Upcoming Cheques (next 30 days)'
        : 'Overdue Cheques';
      sections.push(chequeSection(data, title, list));
      break;
    }

    case 'deposited':
      sections.push(chequeSection(data, 'Deposited Cheques',
        data.cheques.filter((c) => c.status === 'deposited')));
      break;

    case 'cleared':
      sections.push(chequeSection(data, 'Cleared Cheques',
        data.cheques.filter((c) => c.status === 'cleared' && dated(c))));
      break;

    case 'bounced': {
      const bounced = data.cheques.filter((c) => c.status === 'bounced' || c.bouncedOn);
      sections.push({
        title: 'Bounced Cheques',
        head: ['Bounced On', 'Cheque Date', 'Cheque #', 'Party', 'Amount', 'Reason', 'Replaced By'],
        numericCols: [4],
        rows: bounced.map((c) => [
          c.bouncedOn ? formatDate(c.bouncedOn) : '—',
          formatDate(c.chequeDate),
          c.chequeNumber,
          partyName(data, c.partyId),
          m(c.amount),
          c.bounceReason ?? '—',
          c.replacedByChequeId
            ? data.cheques.find((x) => x.id === c.replacedByChequeId)?.chequeNumber ?? '—'
            : '—',
        ]),
        foot: ['', '', '', 'Total', m(bounced.reduce((s, c) => s + c.amount, 0)), '', ''],
      });
      break;
    }

    case 'returned':
      sections.push(chequeSection(data, 'Returned Cheques',
        data.cheques.filter((c) => c.status === 'returned')));
      break;

    case 'cancelled':
      sections.push(chequeSection(data, 'Cancelled Cheques',
        data.cheques.filter((c) => c.status === 'cancelled')));
      break;

    case 'cheque-transfers': {
      const moves = data.movements
        .filter((mv) => mv.action === 'Transferred to party' && inRange(mv.date, f))
        .sort((a, b) => a.at - b.at);
      sections.push({
        title: 'Cheque Transfers',
        head: ['Date', 'Reference', 'Cheque #', 'From Party', 'To Party', 'Amount'],
        numericCols: [5],
        rows: moves.map((mv) => {
          const c = data.cheques.find((x) => x.id === mv.chequeId);
          return [
            formatDate(mv.date),
            mv.reference ?? '—',
            c?.chequeNumber ?? '—',
            partyName(data, mv.fromPartyId),
            partyName(data, mv.toPartyId),
            c ? m(c.amount) : '—',
          ];
        }),
      });
      break;
    }

    case 'party-transfers':
      sections.push(txnSection(data, 'Party-to-Party Transfers', ['Party Transfer'], f));
      break;

    case 'bank-transfers': {
      const rows = data.transactions
        .filter((t) => t.type === 'Bank Transfer' && inRange(t.date, f))
        .sort((a, b) => a.date.localeCompare(b.date));
      sections.push({
        title: 'Bank Transfers',
        head: ['Date', 'Reference', 'From Account', 'To Account', 'Description', 'Amount'],
        numericCols: [5],
        rows: rows.map((t) => [
          formatDate(t.date),
          t.reference,
          bankAccountLabel(data.banks, data.bankAccounts, t.fromBankAccountId),
          bankAccountLabel(data.banks, data.bankAccounts, t.toBankAccountId),
          t.description ?? '—',
          m(t.amount),
        ]),
        foot: ['', '', '', '', 'Total', m(rows.reduce((s, t) => s + t.amount, 0))],
      });
      break;
    }

    case 'party-ledger':
    case 'party-statement': {
      if (!f.partyId) break;
      const { rows, balance } = buildPartyLedger(data, f.partyId);
      const p = data.parties.find((x) => x.id === f.partyId);
      const totDebit = rows.reduce((s, r) => s + r.entry.debit, 0);
      const totCredit = rows.reduce((s, r) => s + r.entry.credit, 0);
      kpis = [
        { label: 'Opening', value: m(p?.openingBalance ?? 0), tone: 'slate' },
        { label: 'Total Debit', value: m(totDebit), tone: 'green' },
        { label: 'Total Credit', value: m(totCredit), tone: 'red' },
        {
          label: balanceLabel(balance),
          value: m(Math.abs(balance)),
          hint: 'closing balance',
          tone: balance > 0 ? 'green' : balance < 0 ? 'red' : 'slate',
        },
      ];
      charts = [
        {
          kind: 'compare',
          title: 'Debit vs Credit',
          left: { label: 'Debit', value: totDebit, color: T.green },
          right: { label: 'Credit', value: totCredit, color: T.red },
          formatValue: (n) => money(n, data.settings.currency),
        },
      ];
      // Oldest-first reads correctly on a printed statement.
      const ordered = [...rows].reverse().filter((r) => inRange(r.entry.date, f));
      sections.push({
        title: `${p?.name ?? 'Party'} — Ledger`,
        head: ['Date', 'Reference', 'Type', 'Cheque #', 'Description', 'Debit', 'Credit', 'Balance'],
        numericCols: [5, 6, 7],
        rows: ordered.map((r) => [
          formatDate(r.entry.date),
          r.txn?.reference ?? '—',
          r.entry.type,
          r.cheque?.chequeNumber ?? '—',
          r.entry.description,
          r.entry.debit ? m(r.entry.debit) : '—',
          r.entry.credit ? m(r.entry.credit) : '—',
          m(r.running),
        ]),
        foot: ['', '', '', '', '', '', balanceLabel(balance), m(Math.abs(balance))],
      });
      break;
    }

    case 'bank-ledger': {
      if (!f.bankAccountId) break;
      const { rows, balance } = buildBankLedger(data, f.bankAccountId);
      const label = bankAccountLabel(data.banks, data.bankAccounts, f.bankAccountId);
      kpis = [
        { label: 'Closing Balance', value: m(balance), tone: balance >= 0 ? 'blue' : 'red' },
        { label: 'Money In', value: m(rows.reduce((s, r) => s + r.entry.debit, 0)), tone: 'green' },
        { label: 'Money Out', value: m(rows.reduce((s, r) => s + r.entry.credit, 0)), tone: 'red' },
      ];
      sections.push({
        title: `${label} — Ledger`,
        head: ['Date', 'Reference', 'Type', 'Cheque #', 'Description', 'Debit', 'Credit', 'Balance'],
        numericCols: [5, 6, 7],
        rows: [...rows].reverse().filter((r) => inRange(r.entry.date, f)).map((r) => [
          formatDate(r.entry.date),
          r.txn?.reference ?? '—',
          r.entry.type,
          r.cheque?.chequeNumber ?? '—',
          r.entry.description,
          r.entry.debit ? m(r.entry.debit) : '—',
          r.entry.credit ? m(r.entry.credit) : '—',
          m(r.running),
        ]),
        foot: ['', '', '', '', '', '', 'Balance', m(balance)],
      });
      break;
    }

    case 'cash-ledger': {
      const rows = data.ledger
        .filter((l) => l.account.kind === 'cash' && l.account.id === 'CASH' && inRange(l.date, f))
        .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt);
      let run = 0;
      const cashIn = rows.reduce((s, l) => s + l.debit, 0);
      const cashOut = rows.reduce((s, l) => s + l.credit, 0);
      kpis = [
        { label: 'Cash in Hand', value: m(cashBalance(data)), tone: 'blue' },
        { label: 'Cash In', value: m(cashIn), tone: 'green' },
        { label: 'Cash Out', value: m(cashOut), tone: 'red' },
      ];
      charts = [
        {
          kind: 'compare',
          title: 'Cash In vs Cash Out',
          left: { label: 'Cash In', value: cashIn, color: T.green },
          right: { label: 'Cash Out', value: cashOut, color: T.red },
          formatValue: (n) => money(n, data.settings.currency),
        },
      ];
      sections.push({
        title: 'Cash Ledger',
        head: ['Date', 'Type', 'Description', 'Debit', 'Credit', 'Balance'],
        numericCols: [3, 4, 5],
        rows: rows.map((l) => {
          run += l.debit - l.credit;
          return [
            formatDate(l.date), l.type, l.description,
            l.debit ? m(l.debit) : '—',
            l.credit ? m(l.credit) : '—',
            m(run),
          ];
        }),
      });
      break;
    }

    case 'debit-credit':
      sections.push(txnSection(data, 'Debit & Credit Adjustments',
        ['Debit Adjustment', 'Credit Adjustment'], f));
      break;

    case 'daily': {
      const byDay = new Map<string, { count: number; debit: number; credit: number }>();
      for (const t of data.transactions) {
        if (!inRange(t.date, f)) continue;
        const cur = byDay.get(t.date) ?? { count: 0, debit: 0, credit: 0 };
        cur.count += 1;
        for (const l of data.ledger) {
          if (l.txnId !== t.id) continue;
          cur.debit += l.debit;
          cur.credit += l.credit;
        }
        byDay.set(t.date, cur);
      }
      const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const txnCount = days.reduce((s, [, v]) => s + v.count, 0);
      kpis = [
        { label: 'Days Active', value: String(days.length), tone: 'blue' },
        { label: 'Transactions', value: String(txnCount), tone: 'slate' },
        {
          label: 'Busiest Day',
          value: days.length ? String(Math.max(...days.map(([, v]) => v.count))) : '0',
          hint: 'entries in one day',
          tone: 'purple',
        },
      ];
      charts = [
        {
          kind: 'line',
          title: 'Transactions per day',
          data: days.map(([d, v]) => ({ label: d.slice(5), value: v.count })),
          formatValue: (n) => String(Math.round(n)),
        },
        ...(dailyTrend(data, f).length > 1
          ? [{ kind: 'line' as const, title: 'Net money movement per day', data: dailyTrend(data, f), formatValue: compact }]
          : []),
      ];
      sections.push({
        title: 'Daily Transaction Summary',
        emptyText: 'No transactions in this period.',
        head: ['Date', 'Transactions', 'Total Debit', 'Total Credit'],
        numericCols: [1, 2, 3],
        rows: days.map(([d, v]) => [formatDate(d), String(v.count), m(v.debit), m(v.credit)]),
      });
      break;
    }

    case 'monthly': {
      const byMonth = new Map<string, { count: number; debit: number; credit: number }>();
      for (const t of data.transactions) {
        if (!inRange(t.date, f)) continue;
        const key = `${t.year}-${String(t.month).padStart(2, '0')}`;
        const cur = byMonth.get(key) ?? { count: 0, debit: 0, credit: 0 };
        cur.count += 1;
        for (const l of data.ledger) {
          if (l.txnId !== t.id) continue;
          cur.debit += l.debit;
          cur.credit += l.credit;
        }
        byMonth.set(key, cur);
      }
      const months = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      kpis = [
        { label: 'Months Active', value: String(months.length), tone: 'blue' },
        { label: 'Transactions', value: String(months.reduce((s, [, v]) => s + v.count, 0)), tone: 'slate' },
        {
          label: 'Avg per Month',
          value: months.length
            ? String(Math.round(months.reduce((s, [, v]) => s + v.count, 0) / months.length))
            : '0',
          tone: 'purple',
        },
      ];
      charts = [{
        kind: 'bar',
        title: 'Transactions per month',
        formatValue: (n) => String(Math.round(n)),
        data: months.slice(-6).map(([k, v]) => ({ label: k, value: v.count, color: T.blue })),
      }];
      sections.push({
        title: 'Monthly Transaction Summary',
        emptyText: 'No transactions in this period.',
        head: ['Month', 'Transactions', 'Total Debit', 'Total Credit'],
        numericCols: [1, 2, 3],
        rows: months.map(([k, v]) => [k, String(v.count), m(v.debit), m(v.credit)]),
      });
      break;
    }

    case 'audit': {
      const rows = [...data.audit]
        .filter((a) => inRange(a.date, f))
        .sort((a, b) => b.at - a.at);
      sections.push({
        title: 'Audit Trail',
        head: ['Date / Time', 'User', 'Action', 'Entity', 'Description', 'Reason'],
        rows: rows.map((a) => [
          new Date(a.at).toLocaleString(),
          a.user,
          a.action,
          a.entity,
          a.description ?? '—',
          a.reason ?? '—',
        ]),
      });
      break;
    }
  }

  // Accent colour follows the report's tone, so the PDF matches the card the
  // user clicked on the Reports page.
  const ACCENT: Record<PdcReportTone, RGB> = {
    blue: T.blue, green: T.green, red: T.red,
    orange: T.orange, purple: T.purple, slate: T.slate,
  };

  const periodLabel = f.from || f.to
    ? `${f.from ? formatDate(f.from) : 'Start'} — ${f.to ? formatDate(f.to) : 'Today'}`
    : 'All dates';
  const scope = [
    f.partyId ? partyName(data, f.partyId) : '',
    f.bankAccountId ? bankAccountLabel(data.banks, data.bankAccounts, f.bankAccountId) : '',
  ].filter(Boolean).join(' · ');

  return buildDesignedPdf({
    title: meta.title,
    subtitle: scope || meta.description,
    businessName: data.settings.businessName || 'Ali Nawaz',
    periodLabel,
    accent: ACCENT[meta.tone],
    kpis,
    charts,
    sections,
  });
}

/** Convenience wrapper used by the ledger page's Print / PDF buttons. */
export function buildPartyStatementDoc(data: PdcDataSet, partyId: string): jsPDF {
  return buildPdcReport(data, 'party-statement', { partyId });
}
