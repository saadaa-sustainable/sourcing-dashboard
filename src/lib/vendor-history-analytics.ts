import { vendorCapacityModel, type CapacityRules } from './business-logic';

export type ReceiptLine = { row_key: string; po_detail_id: string | null; po_ref_num: string | null; po_number: number | string | null; po_original_quantity: number | null; grn_receive_quantity: number | null; last_grn_date: string | null; expected_delivery_date: string | null };
export type HistoryOrderLine = { po_detail_id: string; po_ref_num: string | null; po_number: number | string | null; product_code: string | null; original_qty: number | null; expected_delivery_date: string | null };
export type Performance = { pos: number; datedPos: number; otif: number | null; onTime: number | null; fill: number | null; delay: number | null };
const key = (r: { po_ref_num: string | null; po_number: string | number | null }) => r.po_ref_num?.trim() || (r.po_number != null ? `#${r.po_number}` : '');
const date = (v: string | null) => v && /^\d{4}-\d{2}-\d{2}/.test(v) && Number.isFinite(Date.parse(v.slice(0, 10))) ? v.slice(0, 10) : null;
const maxDate = (a: string | null, b: string | null) => !a ? b : !b ? a : a > b ? a : b;

/** One observation per received PO; canonical PO lines supply ordered quantities once. */
export function historyPerformance(receipts: ReceiptLine[], lines: HistoryOrderLine[], commitments: Map<string, string>, product?: string | null) {
  const orders = new Map<string, { qty: number; products: Set<string>; edd: string | null }>();
  const seenLines = new Set<string>();
  for (const l of lines) {
    const k = key(l); const id = `${k}|${l.po_detail_id}`;
    if (!k || seenLines.has(id)) continue;
    seenLines.add(id);
    const o = orders.get(k) ?? { qty: 0, products: new Set<string>(), edd: null };
    o.qty += Math.max(0, Number(l.original_qty) || 0);
    if (l.product_code) o.products.add(l.product_code.trim().toUpperCase());
    o.edd = maxDate(o.edd, date(l.expected_delivery_date)); orders.set(k, o);
  }
  const pos = new Map<string, { received: number; actual: string | null; edd: string | null; fallback: Map<string, number> }>();
  const seen = new Set<string>();
  for (const r of receipts) {
    const k = key(r); const actual = date(r.last_grn_date);
    if (!k || !actual || !(Number(r.grn_receive_quantity) > 0) || seen.has(r.row_key)) continue;
    seen.add(r.row_key);
    const p = pos.get(k) ?? { received: 0, actual: null, edd: null, fallback: new Map<string, number>() };
    p.received += Number(r.grn_receive_quantity); p.actual = maxDate(p.actual, actual);
    p.edd = maxDate(p.edd, date(r.expected_delivery_date));
    const id = r.po_detail_id ?? r.row_key;
    p.fallback.set(id, Math.max(p.fallback.get(id) ?? 0, Number(r.po_original_quantity) || 0));
    pos.set(k, p);
  }
  const summarize = (same: boolean): Performance => {
    let count = 0, dated = 0, onTime = 0, full = 0, otif = 0, delay = 0;
    for (const [k, p] of pos) {
      const o = orders.get(k);
      if (same && (!product || !o?.products.has(product.trim().toUpperCase()))) continue;
      count++;
      const qty = o?.qty ?? [...p.fallback.values()].reduce((a, b) => a + b, 0);
      const inFull = qty > 0 && p.received >= qty;
      if (inFull) full++;
      const edd = date(commitments.get(k) ?? null) ?? o?.edd ?? p.edd;
      if (edd && p.actual) {
        dated++;
        const days = Math.round((Date.parse(p.actual) - Date.parse(edd)) / 86400000);
        delay += Math.max(0, days);
        if (days <= 0) { onTime++; if (inFull) otif++; }
      }
    }
    const pct = (n: number, d: number) => d ? Math.round(n / d * 1000) / 10 : null;
    return { pos: count, datedPos: dated, otif: pct(otif, dated), onTime: pct(onTime, dated), fill: pct(full, count), delay: dated ? Math.round(delay / dated * 10) / 10 : null };
  };
  return { all: summarize(false), same: summarize(true) };
}

export function historyCapacity(input: { machines: number | null; karigar: number | null; vendorType: string | null; inProcessQty: number; reportDate: string | null; poQty: number | null }, rules: CapacityRules, performance: Performance, sameProduct?: Performance, now = Date.now()) {
  const model = vendorCapacityModel(input, rules);
  const daysRemaining = model.entered && model.capacityPerMonth > 0 ? Math.round((model.available! / (model.capacityPerMonth / 30)) * 10) / 10 : null;
  const reasons: string[] = [];
  let recommendation: 'Check data before issuing' | 'Hold: insufficient capacity' | 'Review before issuing' | 'Capacity available';
  if (!model.entered) { recommendation = 'Check data before issuing'; reasons.push('No usable headcount/capacity report is available.'); }
  else if (model.available! <= 0 || (input.poQty != null && input.poQty > model.available!)) { recommendation = 'Hold: insufficient capacity'; reasons.push('Existing load plus this PO exceeds available capacity, or no capacity remains.'); }
  else { recommendation = 'Capacity available'; reasons.push('The capacity model has room for additional production.'); }
  if (input.poQty == null || input.poQty <= 0) { reasons.push('Add the new PO quantity to assess whether this specific order fits.'); if (recommendation === 'Capacity available') recommendation = 'Review before issuing'; }
  if (!performance.datedPos) { reasons.push('No dated receipt history is available to assess delivery reliability.'); if (recommendation === 'Capacity available') recommendation = 'Review before issuing'; }
  else if (performance.otif != null && performance.otif < 100) { reasons.push('Some dated POs were late or not received in full; review the delivery risk.'); if (recommendation === 'Capacity available') recommendation = 'Review before issuing'; }
  if (!input.reportDate || !Number.isFinite(Date.parse(input.reportDate)) || now - Date.parse(input.reportDate) > 7 * 86400000) {
    reasons.push('The capacity report is missing or more than 7 days old. Refresh it before committing production.');
    if (recommendation === 'Capacity available') recommendation = 'Review before issuing';
  }
  if (sameProduct?.datedPos && sameProduct.otif != null && sameProduct.otif < 100) {
    reasons.push('Same-product POs include late or incomplete deliveries; confirm a realistic TNA.');
    if (recommendation === 'Capacity available') recommendation = 'Review before issuing';
  }
  return { ...model, daysRemaining, reportDate: input.reportDate, headcount: input.karigar, inProcessQty: input.inProcessQty, poQty: input.poQty, recommendation, reasons };
}
