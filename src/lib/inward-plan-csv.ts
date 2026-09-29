/**
 * Parser for the team's monthly "INWARD PLAN <Month>" sheet, exported as CSV.
 *
 * The sheet has two header rows of its own (the month, the Auto/Manual row) before
 * the real column header, so the parser finds the header row by its column names
 * rather than assuming a position. Columns are matched by meaning, not by order:
 *   product code · PO no · vendor · inward qty this month · cost / piece
 * Total value is never read — it is qty × cost and is recomputed on the dashboard.
 */
export type InwardPlanCsvRow = {
  product_code: string;
  po_no: string | null;
  vendor_name: string | null;
  inward_qty: number;
  cost_per_piece: number | null;
  /** 1-based line number in the CSV, for error messages. */
  line: number;
};

export type InwardPlanCsvResult = {
  rows: InwardPlanCsvRow[];
  /** Lines that were skipped and why (blank product, zero qty, unreadable number). */
  skipped: { line: number; reason: string }[];
  error?: string;
};

/** Minimal RFC-4180 CSV split: quoted cells, doubled quotes, CR/LF line ends. */
export function splitCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); out.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); out.push(row); }
  return out;
}

const norm = (s: string) => s.replace(/﻿/g, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const toNum = (s: string): number | null => {
  const t = s.replace(/[₹,\s]/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

export function parseInwardPlanCsv(text: string): InwardPlanCsvResult {
  const grid = splitCsv(text);
  let headerIdx = -1;
  let col = { product: -1, po: -1, vendor: -1, qty: -1, cost: -1 };
  for (let i = 0; i < Math.min(grid.length, 20); i++) {
    const cells = grid[i].map(norm);
    const product = cells.findIndex((c) => c === 'product code' || c === 'product' || c === 'sku' || c === 'product code sku');
    const po = cells.findIndex((c) => c.startsWith('po no') || c === 'po' || c === 'po ref' || c === 'po number');
    const qty = cells.findIndex((c) => c.includes('inward qty') || c === 'qty' || c === 'quantity' || c.includes('inward quantity'));
    if (product >= 0 && po >= 0 && qty >= 0) {
      headerIdx = i;
      col = {
        product,
        po,
        vendor: cells.findIndex((c) => c.startsWith('vendor')),
        qty,
        cost: cells.findIndex((c) => c.startsWith('cost')),
      };
      break;
    }
  }
  if (headerIdx < 0) {
    return { rows: [], skipped: [], error: 'Could not find the header row — expected columns PRODUCT CODE, PO NO. and Inward qty.' };
  }

  const rows: InwardPlanCsvRow[] = [];
  const skipped: InwardPlanCsvResult['skipped'] = [];
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const cells = grid[i];
    const line = i + 1;
    const product = (cells[col.product] ?? '').trim().toUpperCase();
    const po = (cells[col.po] ?? '').trim();
    if (!product && !po) continue; // blank / total line
    if (!product) { skipped.push({ line, reason: 'no product code' }); continue; }
    const qty = toNum(cells[col.qty] ?? '');
    if (qty == null) { skipped.push({ line, reason: `inward qty "${cells[col.qty] ?? ''}" is not a number` }); continue; }
    if (qty <= 0) { skipped.push({ line, reason: 'inward qty is zero' }); continue; }
    const cost = col.cost >= 0 ? toNum(cells[col.cost] ?? '') : null;
    rows.push({
      product_code: product,
      po_no: po || null,
      vendor_name: col.vendor >= 0 ? (cells[col.vendor] ?? '').trim() || null : null,
      inward_qty: qty,
      cost_per_piece: cost,
      line,
    });
  }
  return { rows, skipped };
}
