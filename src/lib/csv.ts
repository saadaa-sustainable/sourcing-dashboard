export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += char;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows;
}

export function normalizeHeader(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/**
 * Parses a CSV into row objects keyed by normalised header, alongside the literal
 * header text. The literal headers matter because `Vendor Master Data` carries a
 * date inside a column name ("No. of Karigar (13th July)") that we store verbatim
 * for traceability, and matching it requires a prefix match on the normalised form.
 */
export function csvTable(input: string, headerRow = 0) {
  const rows = parseCsv(input);
  const literalHeaders = (rows[headerRow] ?? []).map((value) => value.trim());
  const headers = literalHeaders.map(normalizeHeader);
  const objects = rows.slice(headerRow + 1)
    .filter((row) => row.some((value) => value.trim()))
    .map((row) =>
      Object.fromEntries(headers.map((header, index) => [header, row[index] ?? '']).filter(([header]) => header)),
    );
  return { headers, literalHeaders, objects };
}

export function csvObjects(input: string, headerRow = 0) {
  return csvTable(input, headerRow).objects;
}

/**
 * Trigger a client-side CSV download from a header row + data rows. Used to hand
 * the buying team a ready-to-fill import template. Client-only (uses the DOM).
 */
export function downloadCsv(
  filename: string,
  header: string[],
  rows: (string | number)[][] = [],
) {
  const esc = (v: string | number) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [header, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
