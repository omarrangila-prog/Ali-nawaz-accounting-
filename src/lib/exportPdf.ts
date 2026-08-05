/**
 * Professional PDF report builder using jsPDF + autotable.
 * Produces a title, business header, month/year, summary cards and clean
 * tables with totals — print-friendly.
 */
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { monthName, formatNumber } from './utils';
import type { Settings } from '@/types';

export interface PdfSection {
  title: string;
  head: string[];
  rows: (string | number)[][];
  /** Optional bold totals row. */
  foot?: (string | number)[];
  /** Right-align these column indexes. */
  numericCols?: number[];
  /**
   * Column index that should be given extra width because it carries free text
   * (e.g. a Tafseel description). Optional — omitted, widths are unchanged.
   */
  wideCol?: number;
}

export interface PdfSummaryCard {
  label: string;
  value: string;
  accent?: [number, number, number];
}

const BLUE: [number, number, number] = [59, 130, 246];
const DARK: [number, number, number] = [24, 28, 38];
const SOFT: [number, number, number] = [120, 128, 140];
const GREEN: [number, number, number] = [16, 150, 100];
const LINE: [number, number, number] = [232, 235, 240];
// Excel-style worksheet colours: visible grey grid lines + light grey header.
const GRID: [number, number, number] = [180, 186, 196];
const HEAD: [number, number, number] = [238, 240, 244];

export function buildReportPdf(opts: {
  title: string;
  settings: Settings;
  month: number;
  year: number;
  summary?: PdfSummaryCard[];
  sections: PdfSection[];
}): jsPDF {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const M = 24;              // tighter page margin — more usable width, less edge space
  let y = 30;

  // --- Compact header: business name + report title on nearby lines ---
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...SOFT);
  doc.text((opts.settings.businessName || 'Ali Nawaz').toUpperCase(), M, y);

  doc.setFontSize(14);
  doc.setTextColor(...DARK);
  doc.text(opts.title, M, y + 15);

  // Owner/contact line under the title.
  const sub = [opts.settings.ownerName, opts.settings.phone, opts.settings.address]
    .filter(Boolean)
    .join('  •  ');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(...SOFT);
  doc.text(`${monthName(opts.month)} ${opts.year}${sub ? '   ·   ' + sub : ''}`, M, y + 27);
  y += 34;

  // --- Summary strip: dense single-line rows (no tall cards). ---
  if (opts.summary?.length) {
    const cols = 4;
    const colW = (pageW - M * 2) / cols;
    const rowH = 15;         // compact line height
    opts.summary.forEach((c, i) => {
      const col = i % cols;
      const rowIdx = Math.floor(i / cols);
      const x = M + col * colW;
      const cy = y + rowIdx * rowH;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(...SOFT);
      doc.text(`${c.label}:`, x, cy + 10);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      const neg = c.value.trim().startsWith('-') || /\(-\)/.test(c.value);
      doc.setTextColor(...(neg ? [200, 60, 60] as [number, number, number] : DARK));
      // value right after the label (labels are short) — keep it on one line.
      doc.text(c.value, x + doc.getTextWidth(`${c.label}: `) + 2, cy + 10);
    });
    const rows = Math.ceil(opts.summary.length / cols);
    y += rows * rowH + 4;
  }

  doc.setDrawColor(...GRID);
  doc.setLineWidth(0.5);
  doc.line(M, y, pageW - M, y);
  y += 8;

  // --- Sections: one report per page, each filled to the page bottom with
  //     empty bordered grid rows so it prints as a COMPLETE Excel worksheet. ---
  const pageH = doc.internal.pageSize.getHeight();
  const FOOTER_SPACE = 12;       // bottom reserve for the page footer line
  const numCols = (s: PdfSection) => s.head.length;
  const blankRow = (n: number) => Array.from({ length: n }, () => '');
  const usableW = pageW - M * 2;
  // Shared table styling so the header, data and blank-fill tables look identical.
  // overflow:'ellipsize' → long text truncates instead of wrapping, so EVERY row
  // is exactly one line high (uniform cell sizes, no surprise pagination).
  const baseStyles = { fontSize: 8.5, cellPadding: { top: 1.4, bottom: 1.4, left: 4, right: 4 }, textColor: DARK as any, lineColor: GRID, lineWidth: 0.4, halign: 'left' as const, valign: 'middle' as const, overflow: 'ellipsize' as const };

  opts.sections.forEach((section, idx) => {
    // Each report begins on its own fresh page (the first uses the header area).
    if (idx > 0) { doc.addPage(); y = 24; }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(...DARK);
    doc.text(section.title, M, y + 8);
    y += 12;

    const realCols = numCols(section);
    // Fixed, EVEN column widths that fill the full page width. The first column
    // (names/dates) gets 1.6× a normal column so long party names don't wrap;
    // every other real column is equal. Extra empty columns (only when there's
    // real leftover room) are equal too — so cells are uniform and numbers never
    // wrap. This makes each report a clean, evenly-gridded worksheet.
    const FIRST_MULT = 1.6;
    const MIN_COL = 46;                                   // min width for a data column
    // Decide spare columns: add equal empty columns only if the real columns
    // would otherwise be very wide (few columns). Cap so cells stay uniform.
    const naturalReal = usableW / (realCols - 1 + FIRST_MULT);
    let extraCols = 0;
    if (naturalReal > 130) extraCols = Math.min(10, Math.round((naturalReal - 90) / 60) + realCols);
    const totalUnits = (realCols - 1 + FIRST_MULT) + extraCols;
    let unit = usableW / totalUnits;
    if (unit < MIN_COL) { extraCols = 0; unit = usableW / (realCols - 1 + FIRST_MULT); }
    const cols = realCols + extraCols;
    const pad = (arr: string[]) => [...arr, ...blankRow(extraCols)];

    const colStyles = (): Record<number, any> => {
      const cs: Record<number, any> = { 0: { halign: 'left', cellWidth: unit * FIRST_MULT } };
      for (let c = 1; c < cols; c++) cs[c] = { cellWidth: unit };
      // Give the free-text column the room it needs, taken evenly from the
      // numeric columns, which have figures of predictable width.
      if (section.wideCol !== undefined && section.wideCol < realCols) {
        const extra = unit * 0.9;
        cs[section.wideCol] = { ...cs[section.wideCol], cellWidth: unit + extra };
        const numeric = (section.numericCols ?? []).filter((c) => c < realCols);
        if (numeric.length) {
          const give = extra / numeric.length;
          numeric.forEach((c) => {
            cs[c] = { ...cs[c], cellWidth: Math.max(MIN_COL, unit - give) };
          });
        }
      }
      (section.numericCols ?? []).forEach((c) => { cs[c] = { ...cs[c], halign: 'right' }; });
      return cs;
    };

    // --- Pass 1: header + real data (+ totals row right after the data) ---
    const dataRows = section.rows.map((r) => pad(r.map(String)));
    const totalRowIdx = section.foot ? dataRows.length : -1;
    if (section.foot) dataRows.push(pad(section.foot.map(String)));

    autoTable(doc, {
      startY: y,
      head: [pad(section.head)],
      body: dataRows,
      margin: { left: M, right: M },
      tableWidth: usableW,
      styles: baseStyles,
      headStyles: { fillColor: HEAD, textColor: DARK as any, fontStyle: 'bold', fontSize: 8, lineColor: GRID, lineWidth: 0.4, halign: 'center' },
      alternateRowStyles: { fillColor: [255, 255, 255] },
      columnStyles: colStyles(),
      didParseCell: (d) => {
        if (d.section === 'body' && d.row.index === totalRowIdx && d.column.index < realCols) {
          d.cell.styles.fontStyle = 'bold';
          d.cell.styles.fillColor = HEAD;
        }
      },
      theme: 'grid',
    });
    // @ts-expect-error plugin sets lastAutoTable
    const lat = doc.lastAutoTable;
    // Measured per-row height from the real table (header + rows) → precise fill.
    const rowH = (lat.finalY - y) / (dataRows.length + 1);
    let afterY = lat.finalY;

    // --- Pass 2: fill the REMAINING page height with equal empty grid rows,
    //     using the MEASURED row height so it fills exactly to the bottom with
    //     no gap and never spills onto a second page. ---
    const remaining = pageH - FOOTER_SPACE - afterY;
    // Blank rows render a touch taller than the header-inclusive average, so use
    // a conservative per-row height (rowH + 1pt) and floor — the grid fills to
    // the bottom yet NEVER spills onto a second page. Hard-cap by the max rows
    // that can physically fit so autoTable can't paginate the blank table.
    const blankH = rowH + 1.5;
    const blanks = blankH > 0 ? Math.max(0, Math.floor((remaining - 2) / blankH)) : 0;
    if (blanks > 0) {
      autoTable(doc, {
        startY: afterY,
        body: Array.from({ length: blanks }, () => blankRow(cols)),
        margin: { left: M, right: M, bottom: 0 },
        tableWidth: usableW,
        styles: baseStyles,
        columnStyles: colStyles(),
        pageBreak: 'avoid',      // keep the blank fill on this page — no spill
        theme: 'grid',
      });
      // @ts-expect-error plugin sets lastAutoTable
      afterY = doc.lastAutoTable.finalY;
    }
    y = afterY;
  });

  // --- Footer on every page ---
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(160, 168, 180);
    doc.text(
      `${opts.settings.businessName || 'Ali Nawaz'} · Generated ${new Date().toLocaleString()}`,
      M,
      doc.internal.pageSize.getHeight() - 22
    );
    doc.text(
      `Page ${i} of ${pageCount}`,
      pageW - M,
      doc.internal.pageSize.getHeight() - 22,
      { align: 'right' }
    );
  }

  return doc;
}

export function money(n: number, currency = 'Rs'): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}${currency} ${formatNumber(Math.abs(n))}`;
}
