/**
 * "Statement" style PDF — modelled on the Easy Khata layout the client knows:
 *   Title + date range
 *   Total Debit | Total Credit | Net Balance strip
 *   Date · Tafseel · Debit(-) · Credit(+) · Balance   (running balance, green)
 *
 * Used for party ledgers and any running-balance statement.
 */
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { Settings } from '@/types';
import { formatNumber, formatDate } from './utils';

const DARK: [number, number, number] = [24, 28, 38];
const SOFT: [number, number, number] = [120, 128, 140];
const GREEN: [number, number, number] = [16, 150, 100];
const RED: [number, number, number] = [220, 60, 60];
const LINE: [number, number, number] = [232, 235, 240];

export interface StatementRow {
  date: string;        // ISO
  voucher?: string;    // e.g. "SAL-01", "PUR-02", "RCV-01"
  type?: string;       // Opening / Purchase / Sale / Receipt / Payment / Adjustment
  qty?: number;        // bond quantity (purchase/sale only)
  rate?: number;       // per-bond rate (purchase/sale only)
  tafseel: string;     // description
  debit: number;       // (-)
  credit: number;      // (+)
  balance: number;     // running; +ve credit, -ve debit
}

export interface StatementOpts {
  settings: Settings;
  title: string;       // e.g. "Yameen Statement"
  fromDate?: string;
  toDate?: string;
  rows: StatementRow[];
}

export function buildStatementPdf(opts: StatementOpts): jsPDF {
  const { settings, title, rows } = opts;
  const cur = settings.currency || 'Rs';
  // Landscape so the detailed ledger (Voucher/Type/Qty/Rate + Dr/Cr/Balance) fits.
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const M = 40;
  let y = 46;

  const totalDebit = rows.reduce((a, r) => a + r.debit, 0);
  const totalCredit = rows.reduce((a, r) => a + r.credit, 0);
  const net = rows.length ? rows[rows.length - 1].balance : totalCredit - totalDebit;

  // ---- Business name (small, top) ----
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...SOFT);
  doc.text((settings.businessName || 'Ali Nawaz').toUpperCase(), M, y - 20);

  // ---- Title ----
  doc.setFontSize(15);
  doc.setTextColor(...DARK);
  doc.text(title, M, y);
  // date range
  if (opts.fromDate || opts.toDate) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(...SOFT);
    const range = `${opts.fromDate ? formatDate(opts.fromDate) : ''}${opts.toDate ? ' – ' + formatDate(opts.toDate) : ''}`;
    doc.text(range, M, y + 15);
  }
  y += 34;

  // ---- Summary strip: Total Debit | Total Credit | Net Balance ----
  const colW = (pageW - M * 2) / 3;
  const strip = [
    { label: 'Total Debit', value: `${cur} ${formatNumber(totalDebit)}`, color: DARK },
    { label: 'Total Credit', value: `${cur} ${formatNumber(totalCredit)}`, color: DARK },
    {
      label: 'Net Balance',
      value: `${cur} ${formatNumber(Math.abs(net))} ${net >= 0 ? '(+)' : '(-)'}`,
      color: net >= 0 ? GREEN : RED,
    },
  ];
  strip.forEach((c, i) => {
    const x = M + i * colW;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(...SOFT);
    doc.text(c.label, x, y);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(...(c.color as [number, number, number]));
    doc.text(c.value, x, y + 16);
  });
  y += 30;
  doc.setDrawColor(...LINE);
  doc.line(M, y, pageW - M, y);
  y += 8;

  // ---- Ledger table ----
  const BAL_COL = 8; // index of the Balance column (after adding Voucher/Type/Qty/Rate)
  autoTable(doc, {
    startY: y,
    head: [['Date', 'Voucher #', 'Type', 'Tafseel', 'Qty', 'Rate', 'Debit (-)', 'Credit (+)', 'Balance']],
    body: rows.map((r) => [
      formatDate(r.date),
      r.voucher ?? '-',
      r.type ?? '-',
      r.tafseel,
      r.qty ? formatNumber(r.qty) : '-',
      r.rate ? formatNumber(r.rate) : '-',
      r.debit ? formatNumber(r.debit) : '-',
      r.credit ? formatNumber(r.credit) : '-',
      `${formatNumber(Math.abs(r.balance))} ${r.balance >= 0 ? '(+)' : '(-)'}`,
    ]),
    margin: { left: M, right: M },
    styles: { fontSize: 9, cellPadding: 6, textColor: DARK as any, lineColor: LINE, lineWidth: 0.5 },
    headStyles: { fillColor: [255, 255, 255], textColor: SOFT as any, fontStyle: 'bold', fontSize: 8.5, lineWidth: { bottom: 0.8 } as any },
    columnStyles: {
      4: { halign: 'right' },
      5: { halign: 'right' },
      6: { halign: 'right' },
      7: { halign: 'right' },
      [BAL_COL]: { halign: 'right', textColor: GREEN as any, fontStyle: 'bold' },
    },
    theme: 'plain',
    didParseCell: (data) => {
      // Colour the running-balance cell red when negative.
      if (data.section === 'body' && data.column.index === BAL_COL) {
        const r = rows[data.row.index];
        data.cell.styles.textColor = (r.balance >= 0 ? GREEN : RED) as any;
      }
    },
  });

  // ---- Footer ----
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(170, 176, 186);
    doc.text(
      `${settings.businessName || 'Ali Nawaz'} · Generated ${new Date().toLocaleDateString()}`,
      M,
      doc.internal.pageSize.getHeight() - 22
    );
    doc.text(`Page ${i} of ${pageCount}`, pageW - M, doc.internal.pageSize.getHeight() - 22, { align: 'right' });
  }

  return doc;
}
