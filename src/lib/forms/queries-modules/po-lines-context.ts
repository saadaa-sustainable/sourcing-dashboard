import 'server-only';
import { client, pageAll } from './_shared';
import { distributeQty, skuOf, type MixCell, type PoLineDraft, type SkuPending } from '@/lib/po-lines';
import { loadPlanMembership } from './buying-plan-analysis';

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

/* ------------------------------------------------------------------ */
/* Spec 7.5 — quantities suggested from the buying plan                */
/* ------------------------------------------------------------------ */

export type PoPlanSuggestion = {
  /** Pieces the plan approves for this product at this PO type. */
  approvedQty: number;
  /** Pieces already raised against that approval on other requests. */
  issuedQty: number;
  /** What is left of the approval — the quantity being suggested. */
  remainingQty: number;
  planMonth: string;
  poTypeLabel: string;
  /** How the total was split across SKUs, for the note that goes with it. */
  basis: 'history' | 'even' | 'none';
  lines: PoLineDraft[];
  /** Why there is nothing to suggest, when there isn't. */
  note: string | null;
};

const TYPE_KEY: Record<string, 'job' | 'fob' | 'efob'> = {
  job_work: 'job',
  FOB: 'fob',
  efob: 'efob',
};
const TYPE_LABEL: Record<string, string> = { job_work: 'Job Work', FOB: 'FOB', efob: 'E-FOB' };

/**
 * What the buying plan would have this PO order.
 *
 * The plan approves a quantity per product and PO type — not per colour and size — so the
 * remaining approval (approved minus what other requests already claim) is split across
 * SKUs in the mix this product was actually bought in before. It is a starting point, not
 * an instruction: the team edits it before saving.
 */
export async function loadPoPlanSuggestion(poId: number): Promise<PoPlanSuggestion | null> {
  const supabase = await client();
  const { data: poRow } = await supabase
    .from('sd_po_approval')
    .select('id, product_code, po_type, buying_plan_no')
    .eq('id', poId)
    .maybeSingle();
  const po = poRow as { product_code: string | null; po_type: string | null; buying_plan_no: string | null } | null;
  if (!po) return null;

  const productCode = up(po.product_code);
  const typeKey = TYPE_KEY[po.po_type ?? ''] ?? null;
  const poTypeLabel = TYPE_LABEL[po.po_type ?? ''] ?? 'this PO type';
  const membership = await loadPlanMembership(productCode, po.buying_plan_no);
  const approvedQty = typeKey ? Number(membership.qty[typeKey] || 0) : 0;

  const base: PoPlanSuggestion = {
    approvedQty,
    issuedQty: 0,
    remainingQty: 0,
    planMonth: membership.planMonth,
    poTypeLabel,
    basis: 'none',
    lines: [],
    note: null,
  };
  if (!productCode) return { ...base, note: 'Pick a product code first.' };
  if (!typeKey) return { ...base, note: 'Pick the PO type first — the plan approves a quantity per type.' };
  if (!approvedQty) {
    return {
      ...base,
      note: membership.planExists
        ? `The ${membership.planMonth.slice(0, 7)} plan has no approved ${poTypeLabel} quantity for ${productCode}, so there is nothing to suggest — this is an ad-hoc purchase.`
        : `There is no approved buying plan for ${membership.planMonth.slice(0, 7)}, so there is nothing to suggest.`,
    };
  }

  // What other requests already claim against that approval. Rejected and deleted ones
  // never took anything, so they do not count.
  // paging-ok: the requests for one product in one plan month, a handful at most
  let siblingQ = supabase
    .from('sd_po_approval')
    .select('id, po_qty, status')
    .eq('product_code', po.product_code)
    .eq('po_type', po.po_type)
    .is('deleted_at', null)
    .neq('status', 'rejected')
    .limit(200);
  // A request with no plan linked is compared against the other unlinked ones — matching
  // on an empty string would quietly find nothing and overstate what is left.
  siblingQ = po.buying_plan_no
    ? siblingQ.eq('buying_plan_no', po.buying_plan_no)
    : siblingQ.is('buying_plan_no', null);
  const { data: siblings } = await siblingQ;
  const issuedQty = ((siblings ?? []) as { id: number; po_qty: number | null }[])
    .filter((r) => r.id !== poId)
    .reduce((s, r) => s + (Number(r.po_qty) || 0), 0);
  const remainingQty = Math.max(0, approvedQty - issuedQty);
  if (!remainingQty) {
    return {
      ...base,
      issuedQty,
      note: `The ${poTypeLabel} approval of ${approvedQty.toLocaleString('en-IN')} pcs for ${productCode} is already fully claimed by other requests.`,
    };
  }

  // The shape to pour it into: what this product has been ordered in before, per SKU.
  const history = await pageAll<{ product_variant: string | null; size: string | null; original_qty: number | null }>(
    () =>
      supabase
        .from('sd_po_dashboard')
        .select('product_variant, size, original_qty')
        .eq('product_code', productCode)
        .order('po_detail_id'),
  );
  const weights = new Map<string, MixCell>();
  for (const h of history) {
    const variant = up(h.product_variant);
    const size = up(h.size);
    if (!variant) continue;
    const key = `${variant}|${size}`;
    const cell = weights.get(key) ?? { product_variant: variant, size, weight: 0 };
    cell.weight += Number(h.original_qty) || 0;
    weights.set(key, cell);
  }

  let cells = [...weights.values()].filter((c) => c.weight > 0);
  let basis: PoPlanSuggestion['basis'] = 'history';
  if (!cells.length) {
    // Never bought before: fall back to an even split over the active colours and the
    // core sizes, which is a guess and is labelled as one.
    const ctx = await loadPoLineContext(productCode);
    const variants = ctx?.variants ?? [];
    const coreSizes = ['S', 'M', 'L', 'XL'];
    cells = variants.flatMap((v) => coreSizes.map((s) => ({ product_variant: v, size: s, weight: 0 })));
    basis = cells.length ? 'even' : 'none';
  }

  return {
    ...base,
    issuedQty,
    remainingQty,
    basis,
    lines: distributeQty(remainingQty, cells),
    note:
      basis === 'none'
        ? `${productCode} has no colours on the active list and no order history, so the pieces cannot be split into SKUs. Enter them yourself.`
        : null,
  };
}
