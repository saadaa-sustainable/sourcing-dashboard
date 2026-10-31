import type { ProductSource, SourceLine } from './types';

export function productKey(source: Pick<ProductSource, 'po_number' | 'product_code'>) {
  return JSON.stringify([source.po_number, source.product_code]);
}

export function productOptions(sources: SourceLine[]): ProductSource[] {
  const products = new Map<string, ProductSource>();
  for (const source of sources) {
    const key = productKey(source);
    const old = products.get(key);
    if (!old) products.set(key, { ...source });
    else {
      old.pending_qty = Number(old.pending_qty) + Number(source.pending_qty);
      if (Number(old.item_price) !== Number(source.item_price) || (old.item_price == null) !== (source.item_price == null)) old.item_price = null;
      if (source.expected_delivery_date && (!old.expected_delivery_date || source.expected_delivery_date < old.expected_delivery_date)) old.expected_delivery_date = source.expected_delivery_date;
    }
  }
  return [...products.values()];
}
