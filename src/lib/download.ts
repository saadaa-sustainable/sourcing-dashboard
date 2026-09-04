export type CsvValue = string | number | null | undefined;

const csvCell = (value: CsvValue) => {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** Serialises a header row plus body rows into RFC 4180 CSV text. */
export function toCsv(headers: string[], rows: CsvValue[][]): string {
  return [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

/**
 * Triggers a client-side download of the given rows as a CSV file. The leading
 * BOM keeps Excel happy with UTF-8 (vendor names and product codes can be
 * non-ASCII); numbers are written raw so the file stays usable for analysis.
 */
export function downloadCsv(filename: string, headers: string[], rows: CsvValue[][]) {
  const blob = new Blob(['﻿' + toCsv(headers, rows)], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const safe = filename.replace(/[\\/:*?"<>|]+/g, '-').replace(/^-+|-+$/g, '') || 'export';
  link.href = url;
  link.download = safe.endsWith('.csv') ? safe : `${safe}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Triggers a client-side download of the given rows as a landscape-A4 PDF
 * table. jspdf + autotable are imported on demand so they stay out of the main
 * bundle. Values must be plain text/numbers — the built-in Helvetica font has
 * no ₹ glyph, so pre-format currency as raw numbers (as the CSV rows do).
 */
export async function downloadPdf(
  filename: string,
  title: string,
  headers: string[],
  rows: CsvValue[][],
  /** Optional free-text note (e.g. a report remark) rendered under the header. */
  note?: string,
) {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  doc.setFontSize(13);
  doc.text(title, 40, 36);
  doc.setFontSize(8);
  doc.setTextColor(120);
  doc.text(
    `Generated ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST · ${rows.length} rows`,
    40,
    50,
  );
  let tableStart = 62;
  const trimmedNote = note?.trim();
  if (trimmedNote) {
    doc.setTextColor(60);
    const wrapped = doc.splitTextToSize(`Remark: ${trimmedNote}`, 760) as string[];
    doc.text(wrapped, 40, 62);
    tableStart = 62 + wrapped.length * 10 + 6;
  }
  autoTable(doc, {
    head: [headers],
    body: rows.map((row) => row.map((v) => (v == null ? '' : String(v)))),
    startY: tableStart,
    margin: { left: 40, right: 40 },
    styles: { fontSize: 6.5, cellPadding: 3, overflow: 'linebreak' },
    headStyles: { fillColor: [92, 77, 212], fontSize: 6.5 },
    alternateRowStyles: { fillColor: [248, 249, 252] },
  });
  const safe = filename.replace(/[\\/:*?"<>|]+/g, '-').replace(/^-+|-+$/g, '') || 'export';
  doc.save(safe.endsWith('.pdf') ? safe : `${safe}.pdf`);
}
