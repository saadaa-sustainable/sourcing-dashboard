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
