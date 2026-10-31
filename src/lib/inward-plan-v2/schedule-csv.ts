import { normalizeHeader, parseCsv } from '@/lib/csv';
import { units } from './analytics';
import { productKey } from './products';
import { parseDraft, periodBounds } from './validation';
import type { HeaderDraft, LineDraft, ProductSource } from './types';

export const SCHEDULE_CSV_HEADERS = ['PO No', 'Product Code', 'Expected Inward Date', 'Quantity', 'Cost/piece', 'Remarks'];
const normalize = (value: string) => value.trim().toUpperCase();
const identity = (line: LineDraft) => line.planning_level === 'product'
  ? JSON.stringify([line.po_number, line.product_code, line.expected_date]) : JSON.stringify([line.po_detail_id, line.expected_date]);

export function validateScheduleAppend(lines: LineDraft[], existing: LineDraft[], products: ProductSource[]) {
  if (lines.length + existing.length > 500) throw new Error('The schedule may contain at most 500 lines, including existing entries.');
  const seen = new Set(existing.map(identity));
  const totals = new Map<string, number>();
  const importedProducts = new Set(lines.map(line => productKey({ po_number: line.po_number!, product_code: line.product_code! })));
  for (const line of [...existing, ...lines]) {
    if (line.planning_level !== 'product') continue;
    const key = productKey({ po_number: line.po_number!, product_code: line.product_code! });
    if (!importedProducts.has(key)) continue;
    const quantity = line.inward_qty.trim() ? units(line.inward_qty) : 0;
    const total = (totals.get(key) ?? 0) + quantity;
    if (!Number.isSafeInteger(total)) throw new Error('Scheduled quantity exceeds safe precision.');
    totals.set(key, total);
  }
  for (const line of lines) {
    if (seen.has(identity(line))) throw new Error('Duplicate PO/product/date: ' + line.po_number + ' / ' + line.product_code + ' / ' + line.expected_date + '. Change the date or remove the existing entry.');
    seen.add(identity(line));
    const key = productKey({ po_number: line.po_number!, product_code: line.product_code! });
    const source = products.find(product => productKey(product) === key);
    if (!source || (totals.get(key) ?? 0) / 1000 > Number(source.pending_qty))
      throw new Error(line.po_number + ' / ' + line.product_code + ': combined schedule quantity exceeds the open PO pending quantity.');
  }
}

export function parseScheduleCsv(text: string, header: HeaderDraft, products: ProductSource[], existing: LineDraft[]): LineDraft[] {
  periodBounds(header.period_kind, header.period_start);
  if (text.length > 5 * 1024 * 1024) throw new Error('CSV must be no larger than 5 MB.');
  // Reject broken quoting rather than let the shared CSV splitter silently merge rows.
  let quoted = false;
  let closed = false;
  let start = true;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') i++;
      else if (char === '"') { quoted = false; closed = true; }
    } else if (char === ',' || char === '\r' || char === '\n') { start = true; closed = false; }
    else if (char === '"') {
      if (!start || closed) throw new Error('CSV contains an unexpected quote. Export it again as CSV.');
      quoted = true; start = false;
    } else if (closed && !/\s/.test(char)) throw new Error('CSV contains text after a closing quote.');
    else if (!/\s/.test(char)) start = false;
  }
  if (quoted) throw new Error('CSV has an unclosed quoted field.');
  const grid = parseCsv(text.replace(/^\uFEFF/, ''));
  const headers = (grid.shift() ?? []).map(normalizeHeader);
  if (new Set(headers).size !== headers.length) throw new Error('CSV has duplicate column headers.');
  const column = (...aliases: string[]) => headers.findIndex(value => aliases.includes(value));
  const po = column('po_no', 'po_number', 'po');
  const product = column('product_code', 'product');
  const date = column('expected_inward_date', 'expected_date', 'receipt_date');
  const quantity = column('quantity', 'inward_qty', 'qty');
  const cost = column('cost_piece', 'cost_per_piece');
  const remarks = column('remarks');
  if ([po, product, date, quantity].some(index => index < 0)) throw new Error('Required columns: PO No, Product Code, Expected Inward Date, Quantity. Download the template.');
  const rows = grid.map((cells, index) => ({ cells, row: index + 2 })).filter(({ cells }) => cells.some(cell => cell.trim()));
  if (!rows.length) throw new Error('CSV contains no schedule entries.');
  if (rows.length + existing.length > 500) throw new Error('The schedule may contain at most 500 lines, including existing entries.');
  const errors: string[] = [];
  const lines: LineDraft[] = [];
  for (const { cells, row } of rows) {
    try {
      if (cells.length !== headers.length) throw new Error('Column count differs from the header. Quote values containing commas.');
      const candidates = products.filter(source => normalize(source.product_code) === normalize(cells[product]));
      const actual = candidates.filter(source => normalize(source.po_number) === normalize(cells[po]));
      const matches = actual.length ? actual : candidates.filter(source => source.po_ref_num != null && normalize(source.po_ref_num) === normalize(cells[po]));
      if (matches.length !== 1) throw new Error(matches.length ? 'PO reference is ambiguous; use the actual PO number.' : 'PO/product does not match an open approved PO.');
      const source = matches[0];
      let expected = cells[date].trim();
      const indian = expected.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      if (indian) expected = indian[3] + '-' + indian[2] + '-' + indian[1];
      const numeric = (value: string) => /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(value.trim()) ? value.trim().replaceAll(',', '') : value.trim();
      const line: LineDraft = {
        planning_level: 'product', po_number: source.po_number, product_code: source.product_code, po_detail_id: '',
        po_label: source.po_ref_num || source.po_number, vendor_name: source.vendor_name ?? '',
        expected_date: expected, inward_qty: numeric(cells[quantity]),
        cost_per_piece: cost < 0 || !cells[cost].trim() ? source.item_price == null ? '' : String(source.item_price) : numeric(cells[cost]),
        remarks: remarks < 0 ? '' : cells[remarks].trim(), label: (source.po_ref_num || source.po_number) + ' / ' + source.product_code,
      };
      const form = new FormData();
      form.set('period_kind', header.period_kind); form.set('period_start', header.period_start); form.set('lines', JSON.stringify([line]));
      parseDraft(form);
      units(line.inward_qty);
      lines.push(line);
    } catch (error) { errors.push('CSV row ' + row + ': ' + (error instanceof Error ? error.message : 'Invalid entry.')); }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  validateScheduleAppend(lines, existing, products);
  return lines;
}
