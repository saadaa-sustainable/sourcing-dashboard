export function missingPoOrderFields(order: {
  category?: unknown; po_type?: unknown; product_code?: unknown; vendor_code?: unknown; vendor_name?: unknown;
}) {
  const missing: string[] = [];
  if (!['fg', 'mat', 'npd'].includes(String(order.category ?? ''))) missing.push('Category');
  if (!['FOB', 'job_work', 'efob'].includes(String(order.po_type ?? ''))) missing.push('PO type');
  for (const [key, label] of [['product_code', 'Product code'], ['vendor_code', 'Vendor code'], ['vendor_name', 'Vendor name']] as const) {
    if (!String(order[key] ?? '').trim()) missing.push(label);
  }
  return missing;
}
