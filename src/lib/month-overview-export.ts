// Downloads of a month overview (the pop-up opened from a month-board card): a PDF report of
// the whole overview, or a CSV with the same sections stacked for Excel. Plain module, used from
// the client; jspdf + autotable load on demand so they stay out of the main bundle.
import { downloadCsv, type CsvValue } from './download';
import type { MonthBoardCard, MonthBoardColumn, MonthDetailSection } from './month-board';

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
const fileBase = (card: MonthBoardCard) => safeName(`${card.detail?.kicker ?? 'Month'} - ${card.label} overview`);
// Helvetica (the built-in PDF font) has no rupee glyph.
const pdfText = (s: string) => s.replace(/₹\s?/g, 'Rs ');

/** A section as plain rows: header + body, with a Status column for tables that carry one. */
function sectionRows(s: MonthDetailSection): { head: string[]; body: string[][] } {
  if (s.kind === 'bars') return { head: ['Item', 'Figure', 'Share / progress'], body: s.bars.map((b) => [b.label, b.value, `${Math.round(b.pct)}%`]) };
  if (s.kind === 'timeline') return { head: ['When', 'What', 'Note'], body: s.events.map((e) => [e.when, e.what, e.note ?? '']) };
  const label = new Map((s.filters ?? []).map((f) => [f.tone, f.label]));
  const withStatus = label.size > 0;
  return {
    head: [...s.columns.map((c) => c.label), ...(withStatus ? ['Status'] : [])],
    body: s.rows.map((r) => [...r.cells, ...(withStatus ? [r.tone ? label.get(r.tone) ?? '' : ''] : [])]),
  };
}

const emptyText = (s: MonthDetailSection) => s.empty ?? 'Nothing to show.';
const isEmpty = (s: MonthDetailSection) => (s.kind === 'bars' ? !s.bars.length : s.kind === 'table' ? !s.rows.length : !s.events.length);
const stamp = () => `${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`;

export async function downloadOverviewPdf(card: MonthBoardCard, col?: MonthBoardColumn) {
  const doc = await buildOverviewPdf(card, col);
  doc?.save(`${fileBase(card)}.pdf`);
}

/** The overview as a jsPDF document (null when the card has no overview). */
export async function buildOverviewPdf(card: MonthBoardCard, col?: MonthBoardColumn) {
  const d = card.detail;
  if (!d) return null;
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const M = 40;
  let y = 44;

  doc.setFontSize(9);
  doc.setTextColor(110);
  doc.text(pdfText(`${d.kicker}${col ? ` · ${col.label}` : ''}`), M, y);
  y += 20;
  doc.setFontSize(18);
  doc.setTextColor(32);
  doc.text(pdfText(card.label), M, y);
  y += 16;
  doc.setFontSize(9);
  doc.setTextColor(80);
  if (d.lede) {
    const lede = doc.splitTextToSize(pdfText(d.lede), W - 2 * M) as string[];
    doc.text(lede, M, y);
    y += lede.length * 11;
  }
  doc.setTextColor(140);
  doc.setFontSize(7.5);
  doc.text(`Generated ${stamp()}`, M, y);
  y += 16;

  if (d.ring) {
    doc.setFillColor(228, 245, 239);
    doc.roundedRect(M, y, W - 2 * M, 34, 6, 6, 'F');
    doc.setFontSize(16);
    doc.setTextColor(0, 110, 82);
    doc.text(d.ring.over ? 'Over' : `${Math.max(0, Math.min(100, d.ring.pct))}%`, M + 12, y + 22);
    doc.setFontSize(9);
    doc.setTextColor(50);
    doc.text(pdfText(`${d.ring.caption}${d.ring.sub ? `: ${d.ring.sub}` : ''}`), M + 70, y + 21);
    y += 46;
  }

  // Tiles: three label/value pairs per row.
  const pairs: string[][] = [];
  for (let i = 0; i < d.tiles.length; i += 3) {
    pairs.push(d.tiles.slice(i, i + 3).flatMap((t) => [pdfText(t.label), pdfText(t.value)]));
  }
  autoTable(doc, {
    body: pairs,
    startY: y,
    margin: { left: M, right: M },
    theme: 'grid',
    styles: { fontSize: 8, cellPadding: 5, lineColor: [225, 227, 229], textColor: [40, 40, 40] },
    columnStyles: { 0: { textColor: [110, 113, 117] }, 2: { textColor: [110, 113, 117] }, 4: { textColor: [110, 113, 117] }, 1: { fontStyle: 'bold' }, 3: { fontStyle: 'bold' }, 5: { fontStyle: 'bold' } },
  });
  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 14;

  if (card.warn) {
    const warn = doc.splitTextToSize(pdfText(card.warn.text), W - 2 * M - 16) as string[];
    doc.setFillColor(255, 245, 217);
    doc.roundedRect(M, y, W - 2 * M, warn.length * 11 + 10, 5, 5, 'F');
    doc.setFontSize(8.5);
    doc.setTextColor(138, 97, 22);
    doc.text(warn, M + 8, y + 14);
    y += warn.length * 11 + 22;
  }

  for (const s of d.sections) {
    if (y > doc.internal.pageSize.getHeight() - 90) {
      doc.addPage();
      y = 44;
    }
    y += 6;
    doc.setFontSize(10.5);
    doc.setTextColor(32);
    doc.text(pdfText(s.title.toUpperCase()), M, y);
    y += 4;
    if (s.hint) {
      doc.setFontSize(7.5);
      doc.setTextColor(110);
      const hint = doc.splitTextToSize(pdfText(s.hint), W - 2 * M) as string[];
      doc.text(hint, M, y + 9);
      y += hint.length * 9 + 2;
    }
    if (isEmpty(s)) {
      doc.setFontSize(8.5);
      doc.setTextColor(110);
      doc.text(pdfText(emptyText(s)), M, y + 14);
      y += 30;
      continue;
    }
    const { head, body } = sectionRows(s);
    const numeric = s.kind === 'table' ? s.columns.map((c) => !!c.num) : [];
    autoTable(doc, {
      head: [head.map(pdfText)],
      body: body.map((r) => r.map(pdfText)),
      startY: y + 6,
      margin: { left: M, right: M },
      styles: { fontSize: 7, cellPadding: 3.5, overflow: 'linebreak', textColor: [40, 40, 40] },
      headStyles: { fillColor: [48, 48, 48], textColor: 255, fontSize: 7 },
      alternateRowStyles: { fillColor: [247, 247, 248] },
      columnStyles: Object.fromEntries(numeric.map((isNum, i) => [i, isNum ? { halign: 'right' as const } : {}])),
      // Number columns: right-align the heading with its figures.
      didParseCell: (cell) => {
        if (cell.section === 'head' && numeric[cell.column.index]) cell.cell.styles.halign = 'right';
      },
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 18;
  }

  // Page numbers.
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFontSize(7);
    doc.setTextColor(150);
    doc.text(pdfText(`${d.kicker} · ${card.label} · page ${p} of ${pages}`), M, doc.internal.pageSize.getHeight() - 20);
  }
  return doc;
}

/** CSV: a summary block (tiles), then each section under its own title row. */
export function downloadOverviewCsv(card: MonthBoardCard, col?: MonthBoardColumn) {
  const d = card.detail;
  if (!d) return;
  const rows: CsvValue[][] = [
    [d.kicker, card.label],
    ['Status', col?.label ?? ''],
    ...(d.lede ? [['About', d.lede]] : []),
    ['Generated', stamp()],
    ...(d.ring ? [[d.ring.caption, d.ring.sub ?? `${d.ring.pct}%`]] : []),
    ...d.tiles.map((t) => [t.label, t.value]),
    ...(card.warn ? [['Note', card.warn.text]] : []),
  ];
  for (const s of d.sections) {
    rows.push([], [s.title.toUpperCase()]);
    if (isEmpty(s)) {
      rows.push([emptyText(s)]);
      continue;
    }
    const { head, body } = sectionRows(s);
    rows.push(head, ...body);
  }
  downloadCsv(`${fileBase(card)}.csv`, ['Month overview', ''], rows);
}
