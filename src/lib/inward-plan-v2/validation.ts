import type { HeaderDraft, LineDraft, PeriodKind } from './types';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value;
}
export function planTitle(kind: PeriodKind, start: string): string {
  if (!validDate(start)) throw new Error('Choose a valid planning date.');
  const date = new Date(start + 'T00:00:00Z');
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getUTCMonth()];
  const year = date.getUTCFullYear();
  if (kind === 'monthly') return `IP_Monthly_${month}_${year}`;
  const day = date.getUTCDate();
  const suffix = day % 100 >= 11 && day % 100 <= 13 ? 'th'
    : day % 10 === 1 ? 'st' : day % 10 === 2 ? 'nd' : day % 10 === 3 ? 'rd' : 'th';
  return `IP_Weekly_${day}${suffix} ${month}, ${year}`;
}
export function periodBounds(kind: PeriodKind, start: string) {
  if (!validDate(start)) throw new Error('Choose a valid planning date.');
  const date = new Date(start + 'T00:00:00Z');
  if (kind === 'weekly' && date.getUTCDay() !== 1) throw new Error('Weekly plans must start on a Monday.');
  if (kind === 'monthly' && date.getUTCDate() !== 1) throw new Error('Monthly plans must start on the 1st.');
  const end = new Date(date);
  if (kind === 'weekly') end.setUTCDate(end.getUTCDate() + 6);
  else { end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0); }
  const cutoff = new Date(date);
  cutoff.setUTCDate(cutoff.getUTCDate() + (kind === 'weekly' ? 1 : 2));
  // Exclusive midnight in Asia/Kolkata, which has no DST.
  cutoff.setTime(cutoff.getTime() - 330 * 60_000);
  return { start, end: end.toISOString().slice(0, 10), deadline: cutoff.toISOString() };
}
export function parseDraft(form: FormData): { header: HeaderDraft; lines: LineDraft[] } {
  const text = (key: string) => String(form.get(key) ?? '').trim();
  const kind = text('period_kind');
  if (kind !== 'weekly' && kind !== 'monthly') throw new Error('Choose weekly or monthly.');
  const header: HeaderDraft = {
    id: text('plan_id') || text('id') || undefined, title: planTitle(kind, text('period_start')), remarks: text('remarks'),
    period_kind: kind, period_start: text('period_start'),
  };
  if (header.id && !UUID.test(header.id)) throw new Error('Invalid plan ID.');
  if (header.remarks.length > 4000) throw new Error('Remarks must be at most 4000 characters.');
  const bounds = periodBounds(kind, header.period_start);
  const raw: unknown = JSON.parse(text('lines') || '[]');
  if (!Array.isArray(raw) || raw.length > 500) throw new Error('A plan may contain at most 500 lines.');
  const seen = new Set<string>();
  const lines = raw.map((entry: unknown, index) => {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid line.');
    const row = entry as Record<string, unknown>;
    const line: LineDraft = {
      planning_level: row.planning_level === 'product' ? 'product' : 'sku',
      po_number: String(row.po_number ?? '').trim(), product_code: String(row.product_code ?? '').trim(),
      id: String(row.id ?? '') || undefined, po_detail_id: String(row.po_detail_id ?? '').trim(),
      expected_date: String(row.expected_date ?? ''), inward_qty: String(row.inward_qty ?? ''),
      cost_per_piece: String(row.cost_per_piece ?? ''), remarks: String(row.remarks ?? ''), label: '',
    };
    const fail = (message: string): never => { throw new Error('Line ' + (index + 1) + ': ' + message); };
    if (line.id && !UUID.test(line.id)) fail('invalid ID.');
    if (line.planning_level === 'product') {
      if (!line.po_number || !line.product_code || line.po_number.length > 200 || line.product_code.length > 200) fail('select a PO and product code.');
    } else if (!line.po_detail_id || line.po_detail_id.length > 200) fail('select a legacy PO line.');
    if (!validDate(line.expected_date) || line.expected_date < bounds.start || line.expected_date > bounds.end)
      fail('receipt date must belong to the planning period.');
    if (!/^\d+(\.\d{1,3})?$/.test(line.inward_qty) || !Number.isFinite(Number(line.inward_qty)) || Number(line.inward_qty) <= 0)
      fail('quantity must be positive, with at most 3 decimal places.');
    if (line.cost_per_piece !== '' && (!/^\d+(\.\d{1,4})?$/.test(line.cost_per_piece) ||
      !Number.isFinite(Number(line.cost_per_piece)))) fail('cost must be nonnegative, with at most 4 decimal places.');
    if (line.remarks.length > 4000) fail('remarks are too long.');
    const key = (line.planning_level === 'product' ? JSON.stringify([line.po_number, line.product_code]) : line.po_detail_id) + '|' + line.expected_date;
    if (seen.has(key)) fail('duplicate PO/SKU and receipt date.');
    seen.add(key);
    return line;
  });
  return { header, lines };
}
export function deadlineLabel(exclusiveDeadline: string): string {
  return new Date(new Date(exclusiveDeadline).getTime() - 1).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short',
  }) + ' IST';
}
