/**
 * Ali Nawaz — worksheet-style reports.
 *
 * Matches the printed ledger the business already uses: a bordered grid with
 * `Tafseel` for the description, `Debit (-)` / `Credit (+)` columns, a running
 * balance suffixed `(+)` or `(-)`, an Opening Balance as the first row, and the
 * remainder of the page filled with empty ruled rows so it prints like a real
 * accounting worksheet.
 *
 * This wraps `buildReportPdf` (the dense worksheet engine) rather than the
 * designed/charted builder, because that engine already produces exactly this
 * look — including the blank-row fill.
 */

import type jsPDF from 'jspdf';
import type { Settings } from '@/types';
import type { PdcDataSet } from '@/types/pdc';
import { buildReportPdf, type PdfSection } from './exportPdf';
import { bankAccountLabel, partyName } from './pdcEngine';
import {
  buildBankLedger, buildCashLedger, buildPartyLedger, buildRegister, partyDealings, paymentMethodOf, whoPays,
  type PartyLedgerRow,
} from './pdcRegister';
import { formatDate, formatNumber, todayISO } from './utils';

/** Quantity / rate for a row, or a dash — the printed book shows them blank. */
const qtyOf = (row: { txn?: any }): string =>
  row.txn?.quantity !== undefined ? formatNumber(row.txn.quantity) : '-';
const rateOf = (row: { txn?: any }): string =>
  row.txn?.rate !== undefined ? formatNumber(row.txn.rate) : '-';

/** How it was paid, worded exactly as the screen words it. */
const methodOf = (data: PdcDataSet, row: { txn?: any }): string => {
  if (!row.txn) return '-';
  const { method } = paymentMethodOf(data, row.txn);
  return method && method !== '—' ? method : '-';
};

/** A figure, or a dash when it is zero — as the printed ledger shows it. */
const num = (n: number): string => (n ? formatNumber(n) : '-');

/** Balance with the (+) / (-) suffix the worksheet uses. */
const bal = (n: number): string =>
  `${formatNumber(Math.abs(n))} ${n >= 0 ? '(+)' : '(-)'}`;

/** Settings shim so the shared PDF header works with PDC settings. */
function shim(data: PdcDataSet): Settings {
  return {
    businessName: data.settings.businessName || 'Ali Nawaz',
    ownerName: data.settings.businessName || 'Ali Nawaz',
    currency: data.settings.currency,
    smartEntryEnabled: false,
    updatedAt: data.settings.updatedAt,
  };
}

/**
 * Description for a ledger line, in the worksheet's terse style: the payment
 * method or item, rather than a long sentence. Falls back through item →
 * description → method → type so the Tafseel column is never blank.
 */
function tafseelFor(
  data: PdcDataSet,
  row: { entry: { description: string; type: string }; txn?: any; cheque?: any }
): string {
  const t = row.txn;
  if (!t) return row.entry.description || row.entry.type;

  // What the user actually typed wins — the printed ledger shows their own
  // words ("shoaib", "Sarfaraz online"), not a generated label.
  if (t.description?.trim()) {
    // A cheque still names its number, since that is how the book reads.
    return row.cheque
      ? `${t.description.trim()} (chq ${row.cheque.chequeNumber})`
      : t.description.trim();
  }
  if (t.itemName?.trim()) return t.itemName.trim();
  if (t.category?.trim()) return t.category.trim();
  if (row.cheque) return `chq ${row.cheque.chequeNumber}`;

  const { method } = paymentMethodOf(data, t);
  if (method && method !== '—') return method.toLowerCase();
  return row.entry.description || row.entry.type;
}

/**
 * The columns every printed ledger carries — party, bank and cash alike, on
 * the Party Ledger page and on the Reports page — in the order the screen
 * shows them, so a printout can be read against the screen line for line.
 */
export function ledgerHead(inLabel: string, outLabel: string): string[] {
  return ['Date', 'Qty', 'Rate', 'Method', 'From', 'To', 'Cheque #', 'Tafseel', inLabel, outLabel, 'Balance'];
}
export const LEDGER_NUMERIC_COLS = [1, 2, 8, 9, 10];
/** Tafseel carries the user's own words, so it gets the spare width. */
export const LEDGER_WIDE_COL = 7;
/**
 * How the page width is shared out: From and To carry party and bank names,
 * so they get the most room; Qty, Rate and Method only ever hold a short word
 * or figure.
 */
export const LEDGER_COL_WEIGHTS = [1.1, 0.75, 0.75, 0.8, 1.75, 1.75, 1.0, 1.6, 1.0, 1.0, 1.2];

/**
 * The body of a printed ledger: the opening figure first, then each line
 * oldest-first with its running balance, then the totals row.
 *
 * `opening` is the balance the page starts from — the account's opening
 * balance, or what was brought forward when the page starts mid-way.
 */
export function ledgerTable(
  data: PdcDataSet,
  chrono: PartyLedgerRow[],
  opening: number,
  openingLabel = 'Opening Balance'
): { rows: string[][]; foot: string[]; closing: number } {
  let running = opening;
  const rows: string[][] = [
    // No date: an opening balance is the position BEFORE any transaction,
    // not something that happened on a day. Printing the record creation
    // timestamp here produced "01 Jan 1970" on older records.
    ['', '-', '-', '-', '-', '-', '-', openingLabel,
      opening > 0 ? formatNumber(opening) : '-',
      opening < 0 ? formatNumber(-opening) : '-',
      bal(opening)],
  ];
  for (const r of chrono) {
    running += r.entry.debit - r.entry.credit;
    rows.push([
      formatDate(r.entry.date),
      qtyOf(r),
      rateOf(r),
      methodOf(data, r),
      r.from,
      r.to,
      r.cheque?.chequeNumber || '-',
      tafseelFor(data, r),
      num(r.entry.debit),
      num(r.entry.credit),
      bal(running),
    ]);
  }
  const totalIn = chrono.reduce((s, r) => s + r.entry.debit, 0) + Math.max(opening, 0);
  const totalOut = chrono.reduce((s, r) => s + r.entry.credit, 0) + Math.max(-opening, 0);
  return {
    rows,
    foot: ['', '', '', '', '', '', '', 'Total', formatNumber(totalIn), formatNumber(totalOut), bal(running)],
    closing: running,
  };
}

/** Money in a sentence: "Rs 300,000". */
export const sayMoney = (data: PdcDataSet) => (n: number): string =>
  `${data.settings.currency || 'Rs'} ${formatNumber(Math.round(n))}`;

/** One sentence that says where an account stands, for the top of its page. */
export function partySentence(data: PdcDataSet, partyId: string): string {
  const name = data.parties.find((p) => p.id === partyId)?.name ?? 'Party';
  return whoPays(name, partyDealings(data).get(partyId)?.balance ?? 0, sayMoney(data));
}
export function bankSentence(data: PdcDataSet, label: string, balance: number): string {
  const say = sayMoney(data);
  return balance >= 0 ? `You have ${say(balance)} in ${label}` : `${label} is overdrawn by ${say(-balance)}`;
}
export function cashSentence(data: PdcDataSet, balance: number): string {
  const say = sayMoney(data);
  return balance >= 0 ? `Cash in hand: ${say(balance)}` : `Cash is short by ${say(-balance)} — some cash going out was never recorded coming in`;
}

/**
 * "In plain words" — what I gave the party, what I got from them, and what is
 * left, laid out as a sum the reader can check: Gave − Got = still to receive
 * or pay.
 */
export function partyPlainSection(data: PdcDataSet, partyId: string): PdfSection {
  const name = data.parties.find((p) => p.id === partyId)?.name ?? 'Party';
  const d = partyDealings(data).get(partyId);
  const z = (n?: number) => formatNumber(n ?? 0);
  const rows: string[][] = [
    [`I GAVE ${name}`, z(d?.gave)],
    ['  - goods sold to them', z(d?.goodsSold)],
    ['  - money & cheques paid to them', z(d?.moneyGiven)],
    [`I GOT from ${name}`, z(d?.got)],
    ['  - money & cheques received from them', z(d?.moneyGot)],
  ];
  if (d?.chequesPending) rows.push(['      (of which cheques not cleared yet)', z(d.chequesPending)]);
  rows.push(['  - goods bought from them', z(d?.goodsBought)]);
  const bal = d?.balance ?? 0;
  return {
    title: `In plain words — ${partySentence(data, partyId)}`,
    head: ['', 'Amount'],
    rows,
    foot: [
      bal > 0 ? `STILL TO RECEIVE from ${name} (I gave - I got)`
        : bal < 0 ? `STILL TO PAY ${name} (I got - I gave)`
        : 'SETTLED — nothing to receive or pay',
      z(Math.abs(bal)),
    ],
    numericCols: [1],
    colWeights: [3, 1],
  };
}

/**
 * Party ledger in the worksheet format.
 *
 * The FIRST row is always the Opening Balance, so the statement starts from a
 * known figure exactly like the printed book — even when the opening is zero.
 */
export function buildPartyWorksheet(data: PdcDataSet, partyId: string): jsPDF {
  const party = data.parties.find((p) => p.id === partyId);
  const { rows } = buildPartyLedger(data, partyId);
  const opening = party?.openingBalance ?? 0;

  // buildPartyLedger returns newest-first for the screen; a statement reads
  // oldest-first so the running balance builds down the page.
  const chrono = [...rows].reverse();

  const table = ledgerTable(data, chrono, opening);
  const section: PdfSection = {
    title: `${party?.name ?? 'Party'} Statement — ${partySentence(data, partyId)}`,
    head: ledgerHead('Debit (-)', 'Credit (+)'),
    rows: table.rows,
    foot: table.foot,
    numericCols: LEDGER_NUMERIC_COLS,
    wideCol: LEDGER_WIDE_COL,
    colWeights: LEDGER_COL_WEIGHTS,
  };

  const now = new Date();
  return buildReportPdf({
    title: `${party?.name ?? 'Party'} — Ledger`,
    settings: shim(data),
    month: now.getMonth() + 1,
    year: now.getFullYear(),
    sections: [section, partyPlainSection(data, partyId)],
  });
}

/**
 * BANK STATEMENT — reads like the statement a bank itself issues.
 *
 * Opening Balance first, then every movement in date order with the cheque
 * named where one was involved, Deposits and Withdrawals in their own columns,
 * and a running balance down the page.
 */
export function buildBankWorksheet(data: PdcDataSet, accountId: string): jsPDF {
  const account = data.bankAccounts.find((a) => a.id === accountId);
  const label = bankAccountLabel(data.banks, data.bankAccounts, accountId);
  const { rows } = buildBankLedger(data, accountId);
  const opening = account?.openingBalance ?? 0;
  const chrono = [...rows].reverse();   // oldest first, so the balance builds

  // On a bank account a debit is money IN (a deposit) and a credit is money
  // OUT (a withdrawal) — the customer's view, which is how a statement reads.
  const table = ledgerTable(data, chrono, opening);

  const now = new Date();
  return buildReportPdf({
    title: `${label} — Bank Statement`,
    settings: shim(data),
    month: now.getMonth() + 1,
    year: now.getFullYear(),
    sections: [{
      title: `${label} Statement — ${bankSentence(data, label, table.closing)}`,
      head: ledgerHead('Deposit (+)', 'Withdraw (-)'),
      rows: table.rows,
      foot: table.foot,
      numericCols: LEDGER_NUMERIC_COLS,
      wideCol: LEDGER_WIDE_COL,
      colWeights: LEDGER_COL_WEIGHTS,
    }],
  });
}

/** The complete Cash Book as a worksheet. */
export function buildCashBookWorksheet(data: PdcDataSet): jsPDF {
  const reg = [...buildRegister(data)].reverse();   // oldest first
  const opening = data.bankAccounts.reduce((s, a) => s + a.openingBalance, 0);

  const body: (string | number)[][] = [
    ['', '-', '-', 'Opening Balance', '-', '-',
      opening > 0 ? formatNumber(opening) : '-', '-', bal(opening)],
  ];
  for (const r of reg) {
    body.push([
      formatDate(r.txn.date),
      qtyOf(r),
      rateOf(r),
      r.partyName || '-',
      r.cheque?.chequeNumber || '-',
      tafseelFor(data, { entry: { description: r.txn.description ?? '', type: r.txn.type }, txn: r.txn, cheque: r.cheque }),
      num(r.debit),
      num(r.credit),
      bal(r.running),
    ]);
  }

  const now = new Date();
  return buildReportPdf({
    title: 'Cash Book',
    settings: shim(data),
    month: now.getMonth() + 1,
    year: now.getFullYear(),
    sections: [{
      title: 'Cash Book Statement',
      head: ['Date', 'Qty', 'Rate', 'Party', 'Cheque #', 'Tafseel', 'Debit (-)', 'Credit (+)', 'Balance'],
      rows: body,
      foot: ['', '', '', '', '', 'Total',
        formatNumber(reg.reduce((s, r) => s + r.debit, 0)),
        formatNumber(reg.reduce((s, r) => s + r.credit, 0)),
        bal(reg.length ? reg[reg.length - 1].running : opening)],
      numericCols: [1, 2, 6, 7, 8],
      wideCol: 5,
    }],
  });
}

export function worksheetFileName(base: string): string {
  return `${base.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${todayISO()}.pdf`;
}

/**
 * CASH ACCOUNT statement — every physical-cash movement, with what came in and
 * what went out in their own columns and a running balance down the page.
 */
export function buildCashWorksheet(data: PdcDataSet): jsPDF {
  const { rows, balance, totalIn, totalOut, breakdown } = buildCashLedger(data);
  const chrono = [...rows].reverse();   // oldest first, so the balance builds

  // Cash always starts from nothing: it is created by the entries below it.
  const table = ledgerTable(data, chrono, 0);

  const now = new Date();
  return buildReportPdf({
    title: 'Cash Account — Statement',
    settings: shim(data),
    month: now.getMonth() + 1,
    year: now.getFullYear(),
    sections: [
      {
        title: `Cash Account — ${cashSentence(data, balance)}`,
        head: ledgerHead('Cash In (+)', 'Cash Out (-)'),
        rows: table.rows,
        foot: table.foot,
        numericCols: LEDGER_NUMERIC_COLS,
        wideCol: LEDGER_WIDE_COL,
        colWeights: LEDGER_COL_WEIGHTS,
      },
      {
        // Where the cash came from and what it went on, so the balance above is
        // explained rather than merely stated.
        title: 'Summary',
        head: ['', 'Amount'],
        rows: [
          ['Cash received from Sales', formatNumber(breakdown.fromSales)],
          ['Cash received through Receive', formatNumber(breakdown.fromReceive)],
          ['Other cash received', formatNumber(breakdown.fromOther)],
          ['Cash paid for Purchases', formatNumber(breakdown.forPurchases)],
          ['Cash paid through Pay', formatNumber(breakdown.forPay)],
          ['Cash paid for Expenses', formatNumber(breakdown.forExpenses)],
          ['Other cash paid', formatNumber(breakdown.forOther)],
          ['Total Cash In', formatNumber(totalIn)],
          ['Total Cash Out', formatNumber(totalOut)],
        ],
        foot: ['CASH IN HAND', bal(balance)],
        numericCols: [1],
      },
    ],
  });
}
