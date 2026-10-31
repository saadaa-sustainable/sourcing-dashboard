import type { InventorySize } from './types';

export function variantInventoryTotals(rows: InventorySize[]) {
  const total = (field: 'current_stock' | 'doq_45') => {
    if (!rows.length || rows.some(row => row[field] == null || !Number.isFinite(Number(row[field])))) return null;
    const value = rows.reduce((sum, row) => sum + Number(row[field]), 0);
    return Number.isFinite(value) ? value : null;
  };
  const stock = total('current_stock');
  const doq = total('doq_45');
  return { doq, doh: stock != null && doq != null && doq > 0 ? stock / doq : null };
}
