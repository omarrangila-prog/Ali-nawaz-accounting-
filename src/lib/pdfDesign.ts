/**
 * Premium PDF report designer.
 *
 * A presentation layer for the Cash Book reports: branded cover header, KPI
 * cards, native vector charts and generously-spaced tables. Everything is drawn
 * with jsPDF primitives — no extra dependency, no rasterised images, so the
 * output stays sharp at any zoom and the file stays small.
 *
 * This is deliberately separate from `exportPdf.ts` (the dense Excel-style
 * worksheet builder used by the legacy bond reports) so neither can regress the
 * other.
 */

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

export type RGB = [number, number, number];

/** Design tokens — one palette for every generated report. */
export const T = {
  ink: [17, 24, 39] as RGB,
  body: [55, 65, 81] as RGB,
  soft: [107, 114, 128] as RGB,
  faint: [156, 163, 175] as RGB,
  hair: [229, 231, 235] as RGB,
  panel: [249, 250, 251] as RGB,
  white: [255, 255, 255] as RGB,

  blue: [37, 99, 235] as RGB,
  blueSoft: [219, 234, 254] as RGB,
  green: [5, 150, 105] as RGB,
  greenSoft: [209, 250, 229] as RGB,
  red: [220, 38, 38] as RGB,
  redSoft: [254, 226, 226] as RGB,
  orange: [217, 119, 6] as RGB,
  orangeSoft: [254, 243, 199] as RGB,
  purple: [124, 58, 237] as RGB,
  purpleSoft: [237, 233, 254] as RGB,
  slate: [71, 85, 105] as RGB,
};

/** Chart series colours, in order. */
export const SERIES: RGB[] = [T.blue, T.green, T.orange, T.purple, T.red, T.slate];

export const PAGE = {
  margin: 40,
  /** Reserved strip at the bottom for the footer. */
  footer: 46,
};

/** A KPI card in the summary strip. */
export interface Kpi {
  label: string;
  value: string;
  /** Optional supporting line under the value. */
  hint?: string;
  tone?: 'blue' | 'green' | 'red' | 'orange' | 'purple' | 'slate';
}

/** One slice / bar of a chart. */
export interface ChartDatum {
  label: string;
  value: number;
  color?: RGB;
}

export type ChartSpec =
  | { kind: 'bar'; title?: string; data: ChartDatum[]; formatValue?: (n: number) => string }
  | { kind: 'donut'; title?: string; data: ChartDatum[]; centerLabel?: string; centerValue?: string }
  | { kind: 'line'; title?: string; data: ChartDatum[]; formatValue?: (n: number) => string }
  | {
      kind: 'compare';
      title?: string;
      /** Two-sided comparison, e.g. Income vs Costs. */
      left: { label: string; value: number; color?: RGB };
      right: { label: string; value: number; color?: RGB };
      formatValue?: (n: number) => string;
    };

export interface DesignSection {
  title: string;
  subtitle?: string;
  head: string[];
  rows: (string | number)[][];
  foot?: (string | number)[];
  /** Column indexes to right-align (money / numbers). */
  numericCols?: number[];
  /** Column index whose text should render as a coloured status pill. */
  statusCol?: number;
  /** Start this section on a new page. */
  newPage?: boolean;
  /** Message shown when there are no rows. */
  emptyText?: string;
}

export interface DesignReport {
  title: string;
  subtitle?: string;
  businessName: string;
  /** e.g. "1 Jul 2026 — 31 Jul 2026" or "All dates". */
  periodLabel?: string;
  kpis?: Kpi[];
  charts?: ChartSpec[];
  sections: DesignSection[];
  /** Accent colour for the header band. */
  accent?: RGB;
  /**
   * Force landscape. Normally left unset — the builder switches automatically
   * when any section has enough columns that portrait would truncate text.
   */
  landscape?: boolean;
}

/** Column count above which portrait A4 starts truncating cell text. */
const WIDE_TABLE_COLS = 7;

const toneColor = (tone?: Kpi['tone']): RGB => {
  switch (tone) {
    case 'green': return T.green;
    case 'red': return T.red;
    case 'orange': return T.orange;
    case 'purple': return T.purple;
    case 'slate': return T.slate;
    default: return T.blue;
  }
};
const toneSoft = (tone?: Kpi['tone']): RGB => {
  switch (tone) {
    case 'green': return T.greenSoft;
    case 'red': return T.redSoft;
    case 'orange': return T.orangeSoft;
    case 'purple': return T.purpleSoft;
    case 'slate': return T.panel;
    default: return T.blueSoft;
  }
};

/** Shorten a number for axis labels: 1.2M, 450K, 900. */
export function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e7) return `${(n / 1e7).toFixed(1)}Cr`;
  if (abs >= 1e5) return `${(n / 1e5).toFixed(1)}L`;
  if (abs >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(Math.round(n));
}

// ---------------------------------------------------------------------------
// Header / footer
// ---------------------------------------------------------------------------

function drawHeader(doc: jsPDF, r: DesignReport): number {
  const W = doc.internal.pageSize.getWidth();
  const M = PAGE.margin;
  const accent = r.accent ?? T.blue;
  const bandH = 86;

  // Accent band across the top.
  doc.setFillColor(...accent);
  doc.rect(0, 0, W, bandH, 'F');
  // A subtle darker wedge for depth.
  doc.setFillColor(accent[0] * 0.86, accent[1] * 0.86, accent[2] * 0.86);
  doc.triangle(W - 190, 0, W, 0, W, bandH, 'F');

  // Business name, small and uppercase above the title.
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(255, 255, 255);
  doc.text(r.businessName.toUpperCase(), M, 30, { charSpace: 1.2 });

  // Report title.
  doc.setFontSize(22);
  doc.text(r.title, M, 56);

  // Period / subtitle.
  const sub = [r.subtitle, r.periodLabel].filter(Boolean).join('   ·   ');
  if (sub) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(255, 255, 255);
    doc.text(sub, M, 73);
  }

  return bandH + 26;
}

function drawFooter(doc: jsPDF, r: DesignReport) {
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = PAGE.margin;
  const pages = doc.getNumberOfPages();

  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setDrawColor(...T.hair);
    doc.setLineWidth(0.6);
    doc.line(M, H - 30, W - M, H - 30);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...T.faint);
    doc.text(
      `${r.businessName}  ·  ${r.title}  ·  generated ${new Date().toLocaleString()}`,
      M,
      H - 17
    );
    doc.setFont('helvetica', 'bold');
    doc.text(`${i} / ${pages}`, W - M, H - 17, { align: 'right' });
  }
}

// ---------------------------------------------------------------------------
// KPI cards
// ---------------------------------------------------------------------------

function drawKpis(doc: jsPDF, kpis: Kpi[], y: number): number {
  const W = doc.internal.pageSize.getWidth();
  const M = PAGE.margin;
  const usable = W - M * 2;
  const gap = 10;
  // Up to 4 per row keeps each card wide enough for large money values.
  const perRow = Math.min(4, kpis.length);
  const cardW = (usable - gap * (perRow - 1)) / perRow;
  const cardH = 58;

  kpis.forEach((k, i) => {
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    const x = M + col * (cardW + gap);
    const cy = y + row * (cardH + gap);
    const accent = toneColor(k.tone);

    // Card body with a soft tinted background.
    doc.setFillColor(...toneSoft(k.tone));
    doc.roundedRect(x, cy, cardW, cardH, 7, 7, 'F');
    // Accent bar on the left edge.
    doc.setFillColor(...accent);
    doc.roundedRect(x, cy, 3.4, cardH, 2, 2, 'F');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(...T.soft);
    doc.text(k.label.toUpperCase(), x + 12, cy + 17, { charSpace: 0.5 });

    doc.setFontSize(15);
    doc.setTextColor(...accent);
    // Shrink very long values so they never overflow the card.
    const maxW = cardW - 22;
    let size = 15;
    while (size > 9 && doc.getTextWidth(k.value) > maxW) {
      size -= 0.5;
      doc.setFontSize(size);
    }
    doc.text(k.value, x + 12, cy + 37);

    if (k.hint) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(...T.soft);
      doc.text(k.hint.slice(0, 46), x + 12, cy + 49);
    }
  });

  const rows = Math.ceil(kpis.length / perRow);
  return y + rows * (cardH + gap) + 8;
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

function chartFrame(doc: jsPDF, x: number, y: number, w: number, h: number, title?: string): number {
  doc.setFillColor(...T.white);
  doc.setDrawColor(...T.hair);
  doc.setLineWidth(0.8);
  doc.roundedRect(x, y, w, h, 7, 7, 'FD');
  if (title) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(...T.ink);
    doc.text(title, x + 14, y + 19);
    return y + 30;
  }
  return y + 14;
}

/** Horizontal bar chart — best for comparing named categories. */
function drawBar(
  doc: jsPDF, spec: Extract<ChartSpec, { kind: 'bar' }>,
  x: number, y: number, w: number, h: number
) {
  const top = chartFrame(doc, x, y, w, h, spec.title);
  const fmt = spec.formatValue ?? compact;
  const data = spec.data.slice(0, 6);
  if (data.length === 0) return;

  const max = Math.max(...data.map((d) => Math.abs(d.value)), 1);
  const labelW = 92;
  const valueW = 74;
  const trackX = x + 14 + labelW;
  const trackW = w - 28 - labelW - valueW;
  const avail = h - (top - y) - 16;
  const rowH = Math.min(26, avail / data.length);
  const barH = Math.min(11, rowH - 8);

  data.forEach((d, i) => {
    const cy = top + i * rowH + rowH / 2;
    const color = d.color ?? SERIES[i % SERIES.length];

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...T.body);
    // Truncate long category names rather than overlapping the bar.
    let label = d.label;
    while (label.length > 3 && doc.getTextWidth(label) > labelW - 8) {
      label = label.slice(0, -1);
    }
    if (label !== d.label) label = label.slice(0, -1) + '…';
    doc.text(label, x + 14, cy + 3);

    // Track.
    doc.setFillColor(...T.panel);
    doc.roundedRect(trackX, cy - barH / 2, trackW, barH, barH / 2, barH / 2, 'F');
    // Value bar.
    const bw = Math.max(2, (Math.abs(d.value) / max) * trackW);
    doc.setFillColor(...color);
    doc.roundedRect(trackX, cy - barH / 2, bw, barH, barH / 2, barH / 2, 'F');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(...T.ink);
    doc.text(fmt(d.value), x + w - 14, cy + 3, { align: 'right' });
  });
}

/** Donut chart — best for composition (share of a whole). */
function drawDonut(
  doc: jsPDF, spec: Extract<ChartSpec, { kind: 'donut' }>,
  x: number, y: number, w: number, h: number
) {
  const top = chartFrame(doc, x, y, w, h, spec.title);
  const data = spec.data.filter((d) => d.value > 0).slice(0, 6);
  const total = data.reduce((s, d) => s + d.value, 0);

  const areaH = h - (top - y) - 14;
  const cx = x + 14 + areaH / 2;
  const cy = top + areaH / 2;
  const rOuter = Math.min(areaH, 110) / 2;
  const rInner = rOuter * 0.6;

  if (total <= 0) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(...T.faint);
    doc.text('No data for this period', x + 14, cy);
    return;
  }

  // Draw each slice as a filled polygon approximating the arc.
  let angle = -Math.PI / 2; // start at 12 o'clock
  data.forEach((d, i) => {
    const sweep = (d.value / total) * Math.PI * 2;
    const color = d.color ?? SERIES[i % SERIES.length];
    // Fine steps keep the arc smooth — coarse steps show as visible banding.
    const steps = Math.max(6, Math.ceil(sweep / 0.03));
    doc.setFillColor(...color);
    // Stroke in the same colour so adjacent triangles leave no hairline seams.
    doc.setDrawColor(...color);
    doc.setLineWidth(0.4);

    for (let s = 0; s < steps; s++) {
      const a0 = angle + (sweep * s) / steps;
      const a1 = angle + (sweep * (s + 1)) / steps;
      // One quad per step spanning inner→outer radius.
      doc.triangle(
        cx + Math.cos(a0) * rInner, cy + Math.sin(a0) * rInner,
        cx + Math.cos(a0) * rOuter, cy + Math.sin(a0) * rOuter,
        cx + Math.cos(a1) * rOuter, cy + Math.sin(a1) * rOuter,
        'FD'
      );
      doc.triangle(
        cx + Math.cos(a0) * rInner, cy + Math.sin(a0) * rInner,
        cx + Math.cos(a1) * rOuter, cy + Math.sin(a1) * rOuter,
        cx + Math.cos(a1) * rInner, cy + Math.sin(a1) * rInner,
        'FD'
      );
    }
    angle += sweep;
  });

  // Punch the hole so it reads as a donut.
  doc.setFillColor(...T.white);
  doc.circle(cx, cy, rInner, 'F');

  if (spec.centerValue) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(...T.ink);
    doc.text(spec.centerValue, cx, cy + 2, { align: 'center' });
    if (spec.centerLabel) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.5);
      doc.setTextColor(...T.soft);
      doc.text(spec.centerLabel.toUpperCase(), cx, cy + 12, { align: 'center' });
    }
  }

  // Legend down the right side.
  const lx = cx + rOuter + 22;
  const lw = x + w - 14 - lx;
  data.forEach((d, i) => {
    const ly = top + 8 + i * 17;
    const color = d.color ?? SERIES[i % SERIES.length];
    doc.setFillColor(...color);
    doc.roundedRect(lx, ly, 8, 8, 2, 2, 'F');

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...T.body);
    let label = d.label;
    while (label.length > 3 && doc.getTextWidth(label) > lw - 52) label = label.slice(0, -1);
    doc.text(label, lx + 13, ly + 7);

    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...T.ink);
    doc.text(`${Math.round((d.value / total) * 100)}%`, x + w - 14, ly + 7, { align: 'right' });
  });
}

/** Line/area chart — best for a trend over time. */
function drawLine(
  doc: jsPDF, spec: Extract<ChartSpec, { kind: 'line' }>,
  x: number, y: number, w: number, h: number
) {
  const top = chartFrame(doc, x, y, w, h, spec.title);
  const data = spec.data.slice(-12);
  const fmt = spec.formatValue ?? compact;
  if (data.length === 0) return;

  const padL = 46, padR = 14, padB = 22;
  const plotX = x + padL;
  const plotW = w - padL - padR;
  const plotY = top + 6;
  const plotH = h - (top - y) - padB - 10;

  const values = data.map((d) => d.value);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const toY = (v: number) => plotY + plotH - ((v - min) / span) * plotH;

  // Horizontal gridlines + y labels.
  doc.setFontSize(6.5);
  doc.setFont('helvetica', 'normal');
  for (let g = 0; g <= 3; g++) {
    const v = min + (span * g) / 3;
    const gy = toY(v);
    doc.setDrawColor(...T.hair);
    doc.setLineWidth(0.5);
    doc.line(plotX, gy, plotX + plotW, gy);
    doc.setTextColor(...T.faint);
    doc.text(fmt(v), plotX - 6, gy + 2, { align: 'right' });
  }

  const stepX = data.length > 1 ? plotW / (data.length - 1) : 0;
  const pts = data.map((d, i) => ({ x: plotX + i * stepX, y: toY(d.value) }));

  // Soft area fill under the line.
  doc.setFillColor(...T.blueSoft);
  for (let i = 0; i < pts.length - 1; i++) {
    const base = toY(min);
    doc.triangle(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, pts[i].x, base, 'F');
    doc.triangle(pts[i + 1].x, pts[i + 1].y, pts[i + 1].x, base, pts[i].x, base, 'F');
  }

  // The line itself.
  doc.setDrawColor(...T.blue);
  doc.setLineWidth(1.8);
  for (let i = 0; i < pts.length - 1; i++) {
    doc.line(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
  }
  // Point markers.
  pts.forEach((p) => {
    doc.setFillColor(...T.white);
    doc.circle(p.x, p.y, 2.6, 'F');
    doc.setDrawColor(...T.blue);
    doc.setLineWidth(1.3);
    doc.circle(p.x, p.y, 2.6, 'S');
  });

  // X labels — thinned out so they never collide.
  const every = Math.ceil(data.length / 6);
  doc.setFontSize(6.5);
  doc.setTextColor(...T.soft);
  data.forEach((d, i) => {
    if (i % every !== 0 && i !== data.length - 1) return;
    doc.text(d.label.slice(0, 8), plotX + i * stepX, plotY + plotH + 13, { align: 'center' });
  });
}

/** Two-sided comparison bar — e.g. total income vs total costs. */
function drawCompare(
  doc: jsPDF, spec: Extract<ChartSpec, { kind: 'compare' }>,
  x: number, y: number, w: number, h: number
) {
  const top = chartFrame(doc, x, y, w, h, spec.title);
  const fmt = spec.formatValue ?? compact;
  const max = Math.max(spec.left.value, spec.right.value, 1);
  const rows = [
    { ...spec.left, color: spec.left.color ?? T.green },
    { ...spec.right, color: spec.right.color ?? T.red },
  ];

  const trackX = x + 14;
  const trackW = w - 28;
  rows.forEach((r, i) => {
    const cy = top + 8 + i * 44;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...T.soft);
    doc.text(r.label.toUpperCase(), trackX, cy, { charSpace: 0.4 });

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(...r.color);
    doc.text(fmt(r.value), x + w - 14, cy, { align: 'right' });

    doc.setFillColor(...T.panel);
    doc.roundedRect(trackX, cy + 6, trackW, 12, 6, 6, 'F');
    doc.setFillColor(...r.color);
    const bw = Math.max(3, (r.value / max) * trackW);
    doc.roundedRect(trackX, cy + 6, bw, 12, 6, 6, 'F');
  });
}

function drawChart(doc: jsPDF, spec: ChartSpec, x: number, y: number, w: number, h: number) {
  switch (spec.kind) {
    case 'bar': return drawBar(doc, spec, x, y, w, h);
    case 'donut': return drawDonut(doc, spec, x, y, w, h);
    case 'line': return drawLine(doc, spec, x, y, w, h);
    case 'compare': return drawCompare(doc, spec, x, y, w, h);
  }
}

/** Lay charts out: one full-width, or two side by side. */
function drawCharts(doc: jsPDF, charts: ChartSpec[], y: number): number {
  const W = doc.internal.pageSize.getWidth();
  const M = PAGE.margin;
  const usable = W - M * 2;
  const gap = 12;
  let cursor = y;

  // Grow the charts to use the room actually left on the cover, so the page
  // ends with a balanced layout instead of a dead white band.
  const H = doc.internal.pageSize.getHeight();
  const rowCount = Math.ceil(charts.length / 2);
  const room = H - PAGE.footer - y - gap * (rowCount - 1) - 6;
  const h = Math.max(132, Math.min(180, room / rowCount));

  for (let i = 0; i < charts.length; i += 2) {
    const pair = charts.slice(i, i + 2);
    if (pair.length === 1) {
      drawChart(doc, pair[0], M, cursor, usable, h);
    } else {
      const w = (usable - gap) / 2;
      drawChart(doc, pair[0], M, cursor, w, h);
      drawChart(doc, pair[1], M + w + gap, cursor, w, h);
    }
    cursor += h + gap;
  }
  return cursor + 6;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/** Status text → pill colours, so cheque states read at a glance. */
const STATUS_TONE: Record<string, [RGB, RGB]> = {
  pending: [T.orangeSoft, [146, 64, 14]],
  transferred: [T.purpleSoft, [91, 33, 182]],
  deposited: [T.blueSoft, [30, 64, 175]],
  presented: [T.blueSoft, [30, 64, 175]],
  cleared: [T.greenSoft, [6, 95, 70]],
  bounced: [T.redSoft, [153, 27, 27]],
  returned: [T.redSoft, [153, 27, 27]],
  cancelled: [T.panel, [107, 114, 128]],
  replaced: [T.panel, [71, 85, 105]],
  credit: [T.blueSoft, [30, 64, 175]],
  'cash / bank': [T.greenSoft, [6, 95, 70]],
  receivable: [T.greenSoft, [6, 95, 70]],
  payable: [T.redSoft, [153, 27, 27]],
  settled: [T.panel, [107, 114, 128]],
};

function drawSection(doc: jsPDF, s: DesignSection, y: number, accent: RGB): number {
  const W = doc.internal.pageSize.getWidth();
  const M = PAGE.margin;

  // Section heading with an accent rule.
  doc.setFillColor(...accent);
  doc.roundedRect(M, y, 3, 14, 1.5, 1.5, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...T.ink);
  doc.text(s.title, M + 10, y + 11);
  let head = y + 22;

  if (s.subtitle) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...T.soft);
    doc.text(s.subtitle, M + 10, head);
    head += 12;
  }

  if (s.rows.length === 0) {
    doc.setFillColor(...T.panel);
    doc.roundedRect(M, head, W - M * 2, 40, 6, 6, 'F');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...T.faint);
    doc.text(s.emptyText ?? 'Nothing to show for this selection.', W / 2, head + 24, { align: 'center' });
    return head + 54;
  }

  const numeric = new Set(s.numericCols ?? []);
  const body = s.rows.map((r) => r.map(String));
  const footIdx = s.foot ? body.length : -1;
  if (s.foot) body.push(s.foot.map(String));

  autoTable(doc, {
    startY: head,
    head: [s.head],
    body,
    margin: { left: M, right: M, bottom: PAGE.footer },
    styles: {
      font: 'helvetica',
      fontSize: 8.5,
      // Roomy rows — the main reason the old output felt cramped.
      cellPadding: { top: 7, bottom: 7, left: 9, right: 9 },
      textColor: T.body as any,
      lineColor: T.hair,
      lineWidth: 0,
      valign: 'middle',
      overflow: 'ellipsize',
    },
    headStyles: {
      fillColor: T.white,
      textColor: T.soft as any,
      fontStyle: 'bold',
      fontSize: 7.5,
      cellPadding: { top: 6, bottom: 8, left: 9, right: 9 },
      lineColor: T.hair,
      lineWidth: { bottom: 1.2 } as any,
    },
    alternateRowStyles: { fillColor: T.panel },
    columnStyles: Object.fromEntries(
      s.head.map((_, i) => [i, { halign: numeric.has(i) ? 'right' : 'left' }])
    ) as any,
    // headStyles applies to the whole header row and overrides the per-column
    // halign above, which left money HEADINGS stranded to the left of their
    // figures. Re-assert the alignment per header cell so each label sits
    // directly over the column it names.
    willDrawCell: (d) => {
      if (d.section === 'head' && numeric.has(d.column.index)) {
        d.cell.styles.halign = 'right';
      }
    },
    didParseCell: (d) => {
      // Totals row: bold, tinted, with a strong top rule.
      if (d.section === 'body' && d.row.index === footIdx) {
        d.cell.styles.fontStyle = 'bold';
        d.cell.styles.fillColor = accent.map((c) => Math.min(255, c + (255 - c) * 0.88)) as any;
        d.cell.styles.textColor = T.ink as any;
        d.cell.styles.lineWidth = { top: 1.2 } as any;
        d.cell.styles.lineColor = accent;
      }
      // Money columns in monospace-ish bold for readability.
      if (d.section === 'body' && numeric.has(d.column.index)) {
        const raw = String(d.cell.raw);
        if (/^-|^\(/.test(raw.trim())) d.cell.styles.textColor = T.red as any;
      }
    },
    // Status pills are drawn manually over the cell.
    didDrawCell: (d) => {
      if (s.statusCol === undefined) return;
      if (d.section !== 'body' || d.column.index !== s.statusCol) return;
      if (d.row.index === footIdx) return;
      const text = String(d.cell.raw ?? '').trim();
      const tone = STATUS_TONE[text.toLowerCase()];
      if (!text || !tone) return;

      // Blank the plain text, then draw the pill in its place.
      doc.setFillColor(...(d.row.index % 2 === 1 ? T.panel : T.white));
      doc.rect(d.cell.x + 1, d.cell.y + 1, d.cell.width - 2, d.cell.height - 2, 'F');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7);
      const tw = doc.getTextWidth(text) + 14;
      const px = d.cell.x + 9;
      const py = d.cell.y + d.cell.height / 2 - 7;
      doc.setFillColor(...tone[0]);
      doc.roundedRect(px, py, tw, 14, 7, 7, 'F');
      doc.setTextColor(...tone[1]);
      doc.text(text, px + 7, py + 9.4);
    },
    theme: 'plain',
  });

  // @ts-expect-error plugin sets lastAutoTable
  return doc.lastAutoTable.finalY + 22;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function buildDesignedPdf(r: DesignReport): jsPDF {
  // Wide registers (Cash Book, ledgers) need landscape or every cell truncates
  // to "Ahmed Tr…" / "Rs 54…". Decide once, up front.
  const wide = r.landscape ?? r.sections.some((s) => s.head.length > WIDE_TABLE_COLS);
  const doc = new jsPDF({ orientation: wide ? 'landscape' : 'portrait', unit: 'pt', format: 'a4' });
  const H = doc.internal.pageSize.getHeight();
  const accent = r.accent ?? T.blue;

  let y = drawHeader(doc, r);

  const hasCover = !!(r.kpis?.length || r.charts?.length);
  if (r.kpis?.length) y = drawKpis(doc, r.kpis, y);
  if (r.charts?.length) y = drawCharts(doc, r.charts, y);


  // Minimum room for a heading plus roughly four rows — below this a table
  // would be orphaned, so it is cleaner to start it on the next page.
  const MIN_TABLE_ROOM = 150;

  r.sections.forEach((s, i) => {
    const needed = MIN_TABLE_ROOM + (s.subtitle ? 12 : 0);
    const noRoom = y > H - PAGE.footer - needed;
    // When there ARE charts, the first page reads as a dashboard/cover; letting
    // a long register begin under it just squeezes in a few rows before
    // breaking anyway. Start it cleanly on its own page instead.
    const coverBreak = hasCover && i === 0 && s.rows.length > 6;

    if ((s.newPage && i > 0) || noRoom || coverBreak) {
      doc.addPage();
      y = PAGE.margin;
    }
    y = drawSection(doc, s, y, accent);
  });

  drawFooter(doc, r);
  return doc;
}
