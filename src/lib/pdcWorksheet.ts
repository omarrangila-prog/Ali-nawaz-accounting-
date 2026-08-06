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
import { buildBankLedger, buildPartyLedger, buildRegister, paymentMethodOf } from './pdcRegister';
import { formatDate, formatNumber, todayISO } from './utils';

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

  let running = opening;
  const body: (string | number)[][] = [
    // Row one: the opening balance, always present.
    [
      party?.createdAt ? formatDate(new Date(party.createdAt).toISOString().slice(0, 10)) : '',
      'Opening Balance',
      opening > 0 ? formatNumber(opening) : '-',
      opening < 0 ? formatNumber(-opening) : '-',
      bal(opening),
    ],
  ];

  for (const r of chrono) {
    running += r.entry.debit - r.entry.credit;
    body.push([
      formatDate(r.entry.date),
      tafseelFor(data, r),
      num(r.entry.debit),
      num(r.entry.credit),
      bal(running),
    ]);
  }

  const totalDebit = chrono.reduce((s, r) => s + r.entry.debit, 0) + Math.max(opening, 0);
  const totalCredit = chrono.reduce((s, r) => s + r.entry.credit, 0) + Math.max(-opening, 0);

  const section: PdfSection = {
    title: `${party?.name ?? 'Party'} Statement`,
    head: ['Date', 'Tafseel', 'Debit (-)', 'Credit (+)', 'Balance'],
    rows: body,
    foot: ['', 'Total', formatNumber(totalDebit), formatNumber(totalCredit), bal(running)],
    numericCols: [2, 3, 4],
    wideCol: 1,          // Tafseel carries the user's own words
  };

  const now = new Date();
  return buildReportPdf({
    title: `${party?.name ?? 'Party'} — Ledger`,
    settings: shim(data),
    month: now.getMonth() + 1,
    year: now.getFullYear(),
    sections: [section],
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

  let running = opening;
  const body: (string | number)[][] = [
    // Row one is ALWAYS the opening balance, even at zero.
    ['', 'Opening Balance', '-',
      opening > 0 ? formatNumber(opening) : '-',
      opening < 0 ? formatNumber(-opening) : '-',
      bal(opening)],
  ];
  for (const r of chrono) {
    // On a bank account a debit is money IN (a deposit) and a credit is money
    // OUT (a withdrawal) — the customer's view, which is how a statement reads.
    running += r.entry.debit - r.entry.credit;
    body.push([
      formatDate(r.entry.date),
      tafseelFor(data, r),
      r.cheque?.chequeNumber || '-',
      num(r.entry.debit),
      num(r.entry.credit),
      bal(running),
    ]);
  }

  const deposits = chrono.reduce((s, r) => s + r.entry.debit, 0) + Math.max(opening, 0);
  const withdrawals = chrono.reduce((s, r) => s + r.entry.credit, 0) + Math.max(-opening, 0);

  const now = new Date();
  return buildReportPdf({
    title: `${label} — Bank Statement`,
    settings: shim(data),
    month: now.getMonth() + 1,
    year: now.getFullYear(),
    sections: [{
      title: `${label} Statement`,
      head: ['Date', 'Tafseel', 'Cheque #', 'Deposit (+)', 'Withdraw (-)', 'Balance'],
      rows: body,
      foot: ['', 'Total', '', formatNumber(deposits), formatNumber(withdrawals), bal(running)],
      numericCols: [3, 4, 5],
      wideCol: 1,
    }],
  });
}

/** The complete Cash Book as a worksheet. */
export function buildCashBookWorksheet(data: PdcDataSet): jsPDF {
  const reg = [...buildRegister(data)].reverse();   // oldest first
  const opening = data.bankAccounts.reduce((s, a) => s + a.openingBalance, 0);

  const body: (string | number)[][] = [
    ['', 'Opening Balance', '', opening > 0 ? formatNumber(opening) : '-', '-', bal(opening)],
  ];
  for (const r of reg) {
    body.push([
      formatDate(r.txn.date),
      r.partyName || '-',
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
      head: ['Date', 'Party', 'Tafseel', 'Debit (-)', 'Credit (+)', 'Balance'],
      rows: body,
      foot: ['', '', 'Total',
        formatNumber(reg.reduce((s, r) => s + r.debit, 0)),
        formatNumber(reg.reduce((s, r) => s + r.credit, 0)),
        bal(reg.length ? reg[reg.length - 1].running : opening)],
      numericCols: [3, 4, 5],
      wideCol: 2,
    }],
  });
}

export function worksheetFileName(base: string): string {
  return `${base.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${todayISO()}.pdf`;
}
