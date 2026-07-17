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
