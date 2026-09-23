import 'server-only';
import { client, pageAll } from './_shared';
import { skuOf, type SkuPending } from '@/lib/po-lines';

/**
 * Spec 7.2 — what the SKU-level entry grid needs for one product: the colours to offer,
 * the sizes to offer, and what is ALREADY pending at SKU level so the typed quantity can be
 * matched against it live ("pending is 100, why are you making 200?").
 */
export type PoLineContext = {
  productCode: string;
  /** Active colours for the product, for the matrix rows and the unknown-colour warning. */
  variants: string[];
  /** Sizes seen for this product on open POs / stock, else the standard ladder. */
  sizes: string[];
  /** Pieces still to arrive per SKU across every open PO for this product. */
  pending: SkuPending[];
};

const SIZE_LADDER = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'];
const up = (s: string | null | undefined) => (s ?? '').trim().toUpperCase();

export async function loadPoLineContext(productCodeRaw: string | null): Promise<PoLineContext | null> {
  const productCode = up(productCodeRaw);
  if (!productCode) return null;
  const supabase = await client();

  const [variantRows, openLines] = await Promise.all([
    supabase.from('sd_active_variants').select('product_code, product_variant').eq('product_code', productCode),
    // Every open line for the product: pending pieces per SKU. Paged — a busy product can
    // carry more than a thousand lines across its open POs.
    pageAll<{ sku: string | null; product_variant: string | null; size: string | null; pending_qty: number | null }>(() =>
      supabase
        .from('sd_po_dashboard')
        .select('sku, product_variant, size, pending_qty')
        .eq('product_code', productCode)
        .gt('pending_qty', 0)
        .order('po_detail_id'),
    ),
  ]);

  const variants = [
    ...new Set(
      ((variantRows.data ?? []) as { product_variant: string | null }[])
        .map((r) => up(r.product_variant))
        .filter(Boolean),
    ),
  ].sort();

  const bySku = new Map<string, SkuPending>();
  const sizesSeen = new Set<string>();
  for (const l of openLines) {
    const variant = up(l.product_variant);
    const size = up(l.size);
    if (!variant) continue;
    if (size) sizesSeen.add(size);
    const sku = up(l.sku) || skuOf(variant, size);
    const cur = bySku.get(sku);
    const qty = Number(l.pending_qty) || 0;
    if (cur) cur.pendingQty += qty;
    else bySku.set(sku, { sku, product_variant: variant, size, pendingQty: qty });
  }

  // Sizes: the ladder first (in order), then anything else the product actually uses.
  const extra = [...sizesSeen].filter((s) => !SIZE_LADDER.includes(s)).sort();
  const sizes = [...SIZE_LADDER, ...extra];

  return { productCode, variants, sizes, pending: [...bySku.values()] };
}
