/*
 * Variation Report — planned vs actual for a CLOSED document (user, 2026-10-09: "For all same
 * 4 tabs Opening a Closed document must always show the Variation Report — planned vs actual,
 * auto-generated, downloadable PDF"). Built at read time from data already on file, never
 * stored. Plain module: the server builders, the panel and the PDF all share these shapes.
 *
 *   Buying Plan     — a month that is over      · approved plan        vs POs issued in the month
 *   Standard Cost   — a frozen cost (PO issued) · standard rate         vs PO line prices
 *   Vendor Capacity — a past Mon–Sun week       · PO capacity           vs quantity on order
 *   Inward Plan     — a month that is over      · approved inward qty   vs GRN received in the month
 */

import { utilisationLabel } from './utilisation';

export type VariationUnit = 'pcs' | 'inr' | 'rate';

export type VariationRow = {
  key: string;
  name: string;
  sub?: string | null;
  planned: number | null;
  actual: number | null;
  note?: string | null;
};

export type VariationSection = {
  title: string;
  unit: VariationUnit;
  plannedLabel: string;
  actualLabel: string;
  /**
   * 'variance' (default): (actual − planned) ÷ planned.
   * 'utilisation': actual ÷ planned, written through utilisationLabel (never above 100%).
   */
  pctMode?: 'variance' | 'utilisation';
  /** Status words; default Excess / Short. */
  words?: { over: string; short: string; onPlan?: string; unplanned?: string };
  rows: VariationRow[];
  empty?: string;
};

export type VariationTile = {
  label: string;
  planned: number | null;
  actual: number | null;
  unit: VariationUnit;
  pctMode?: 'variance' | 'utilisation';
  words?: VariationSection['words'];
};

export type VariationReport = {
  title: string;
  /** "September 2026", "Mon 28 Sep – Sun 4 Oct 2026", a product code … */
  period: string;
  /** Why the document is closed, e.g. "Month closed on 1 Oct 2026". */
  closedNote: string;
  /** What "planned" and "actual" mean here — printed on the panel and the PDF. */
  basis: string[];
  tiles: VariationTile[];
  sections: VariationSection[];
  /** Set when there is no actual data to compare against; the planned side still shows. */
  missing?: string | null;
  generatedAt: string;
  fileName: string;
};

export type VarianceStatus = 'on_plan' | 'over' | 'short' | 'unplanned' | 'no_actual' | 'none';

export type Variance = { diff: number | null; pct: number | null; status: VarianceStatus };

/** actual − planned, its % of planned, and which way it went. */
export function variance(planned: number | null, actual: number | null, pctMode: 'variance' | 'utilisation' = 'variance'): Variance {
  if (planned == null && actual == null) return { diff: null, pct: null, status: 'none' };
  if (actual == null) return { diff: null, pct: null, status: 'no_actual' };
  if (planned == null || planned === 0) return { diff: actual - (planned ?? 0), pct: null, status: actual > 0 ? 'unplanned' : 'on_plan' };
  const diff = actual - planned;
  const pct = pctMode === 'utilisation' ? (actual / planned) * 100 : (diff / planned) * 100;
  const status: VarianceStatus = Math.abs(diff) < 0.005 ? 'on_plan' : diff > 0 ? 'over' : 'short';
  return { diff, pct, status };
}

export function statusWord(s: VarianceStatus, words?: VariationSection['words']): string {
  switch (s) {
    case 'on_plan':
      return words?.onPlan ?? 'On plan';
    case 'over':
      return words?.over ?? 'Excess';
    case 'short':
      return words?.short ?? 'Short';
    case 'unplanned':
      return words?.unplanned ?? 'Not planned';
    case 'no_actual':
      return 'No actual';
    default:
      return '—';
  }
}

/** Number as written in the report. `pdf` swaps ₹ for "Rs" (the PDF font has no ₹ glyph). */
export function fmtValue(v: number | null, unit: VariationUnit, pdf = false): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const rs = pdf ? 'Rs ' : '₹';
  if (unit === 'inr') {
    const abs = Math.abs(v);
    const sign = v < 0 ? '-' : '';
    if (abs >= 1e7) return `${sign}${rs}${(abs / 1e7).toFixed(2)} Cr`;
    if (abs >= 1e5) return `${sign}${rs}${(abs / 1e5).toFixed(2)} L`;
    return `${sign}${rs}${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(abs)}`;
  }
  if (unit === 'rate') return `${rs}${new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v)}`;
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(v);
}

export function fmtDiff(v: Variance, unit: VariationUnit, pdf = false): string {
  if (v.diff == null) return '—';
  const body = fmtValue(Math.abs(v.diff), unit, pdf);
  return v.diff > 0.004 ? `+${body}` : v.diff < -0.004 ? `-${body}` : body;
}

export function fmtPct(v: Variance, pctMode: 'variance' | 'utilisation' = 'variance'): string {
  if (v.pct == null) return '—';
  if (pctMode === 'utilisation') return utilisationLabel(v.pct);
  const r = Math.round(v.pct);
  return `${r > 0 ? '+' : ''}${r}%`;
}

/** Download the report as an A4 PDF (jsPDF loaded on demand, in the browser). */
export async function downloadVariationPdf(r: VariationReport) {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const left = 40;
  let y = 44;
  doc.setFontSize(15);
  doc.setTextColor(22);
  doc.text(`Variation Report - ${r.title}`, left, y);
  y += 16;
  doc.setFontSize(9);
  doc.setTextColor(90);
  doc.text(`${r.period} · ${r.closedNote}`, left, y);
  y += 12;
  doc.text(`Generated ${new Date(r.generatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST · planned vs actual`, left, y);
  y += 16;

  doc.setTextColor(60);
  doc.setFontSize(8.5);
  for (const b of r.basis) {
    const lines = doc.splitTextToSize(`- ${b}`, W - left * 2) as string[];
    doc.text(lines, left, y);
    y += lines.length * 10.5;
  }
  if (r.missing) {
    y += 2;
    doc.setTextColor(170, 90, 0);
    const lines = doc.splitTextToSize(r.missing, W - left * 2) as string[];
    doc.text(lines, left, y);
    y += lines.length * 10.5;
  }
  y += 6;

  if (r.tiles.length) {
    autoTable(doc, {
      startY: y,
      margin: { left, right: left },
      head: [['Summary', 'Planned', 'Actual', 'Variation', '%', 'Status']],
      body: r.tiles.map((t) => {
        const v = variance(t.planned, t.actual, t.pctMode);
        return [t.label, fmtValue(t.planned, t.unit, true), fmtValue(t.actual, t.unit, true), fmtDiff(v, t.unit, true), fmtPct(v, t.pctMode), statusWord(v.status, t.words)];
      }),
      styles: { fontSize: 8.5, cellPadding: 4 },
      headStyles: { fillColor: [22, 21, 19], textColor: 255 },
      columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' } },
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 18;
  }

  for (const s of r.sections) {
    if (y > doc.internal.pageSize.getHeight() - 80) {
      doc.addPage();
      y = 44;
    }
    doc.setFontSize(11);
    doc.setTextColor(22);
    doc.text(s.title, left, y);
    y += 6;
    autoTable(doc, {
      startY: y,
      margin: { left, right: left },
      head: [['', s.plannedLabel, s.actualLabel, 'Variation', '%', 'Status']],
      body: s.rows.length
        ? s.rows.map((row) => {
            const v = variance(row.planned, row.actual, s.pctMode);
            const name = [row.name, row.sub, row.note].filter(Boolean).join(' · ');
            return [name, fmtValue(row.planned, s.unit, true), fmtValue(row.actual, s.unit, true), fmtDiff(v, s.unit, true), fmtPct(v, s.pctMode), statusWord(v.status, s.words)];
          })
        : [[s.empty ?? 'Nothing to compare.', '', '', '', '', '']],
      styles: { fontSize: 7.5, cellPadding: 3, overflow: 'linebreak' },
      headStyles: { fillColor: [240, 198, 30], textColor: 22, fontSize: 7.5 },
      alternateRowStyles: { fillColor: [250, 249, 245] },
      columnStyles: { 0: { cellWidth: 190 }, 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' } },
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 20;
  }

  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFontSize(7.5);
    doc.setTextColor(140);
    doc.text(`SAADAA Sourcing · ${r.title} · page ${p} of ${pages}`, left, doc.internal.pageSize.getHeight() - 20);
  }
  const safe = r.fileName.replace(/[\\/:*?"<>|]+/g, '-') || 'variation-report';
  doc.save(safe.endsWith('.pdf') ? safe : `${safe}.pdf`);
}
