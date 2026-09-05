import 'server-only';
import { client, PAGE_SIZE } from './_shared';
import type {
  EeProductMaster,
  GrnDetail,
  ProductMaster,
  NpdPromotionCandidate,
  PoDetails,
  FabricMaster,
  FabricCostBase,
  ProductCatalogItem,
  EfobFabricCost,
  ProductBom,
  CuttingRegister,
  DynamicLink,
  MaterialMaster,
  Colour,
} from '../types';

/** The EasyEcom product master — one row per SKU, read-only. Paged (exceeds 1000). */
export async function loadEeProductMaster(): Promise<EeProductMaster[]> {
  const supabase = await client();
  const rows: EeProductMaster[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('sd_ee_product_master')
      .select('*')
      .order('sku')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`sd_ee_product_master: ${error.message}`);
    rows.push(...((data ?? []) as EeProductMaster[]));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

// The GRN detail table has 170k+ rows — far too many to ship to the browser at
// once. The viewer page shows the most recent slice; bump if a wider window is
// needed (it stays a client-side table, so keep it in the low thousands).
const GRN_DETAIL_LIMIT = 5000;

/** Inbound-QC GRN detail (sd_ee_grn) — most recent lines, capped (see GRN_DETAIL_LIMIT). */
export async function loadGrnDetail(): Promise<GrnDetail[]> {
  const supabase = await client();
  const { data, error } = await supabase
    .from('sd_ee_grn')
    .select('*')
    .order('grn_created_at', { ascending: false, nullsFirst: false })
    .limit(GRN_DETAIL_LIMIT);
  if (error) throw new Error(`sd_ee_grn: ${error.message}`);
  return (data ?? []) as GrnDetail[];
}

export const grnDetailLimit = GRN_DETAIL_LIMIT;

/** Every product's master row + the NPD-promotion candidates, for the panel. */
export async function loadProductMaster(): Promise<{
  products: ProductMaster[];
  npdCandidates: NpdPromotionCandidate[];
}> {
  const supabase = await client();
  const [{ data: products }, { data: candidates }] = await Promise.all([
    supabase.from('sd_product_master').select('*').order('product_code').limit(PAGE_SIZE),
    supabase.from('sd_npd_promotion_candidates').select('*').limit(PAGE_SIZE),
  ]);
  return {
    products: (products ?? []) as ProductMaster[],
    npdCandidates: (candidates ?? []) as NpdPromotionCandidate[],
  };
}

/** PO Details Form submissions (Google Form), newest first, for the read-only page. */
export async function loadPoDetails(): Promise<PoDetails[]> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_po_details')
    .select('*')
    .order('submitted_at', { ascending: false, nullsFirst: false })
    .limit(PAGE_SIZE);
  return (data ?? []) as PoDetails[];
}

/** Every fabric master row, for the Fabric Master admin page. */
export async function loadFabricMaster(): Promise<FabricMaster[]> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_fabric_master')
    .select('*')
    .order('fabric_code')
    .limit(PAGE_SIZE);
  return (data ?? []) as FabricMaster[];
}

/** Fabric cost base sheet (grey / processing / finished + yarn→grey), for /fabric-cost. */
export async function loadFabricCostBase(): Promise<FabricCostBase[]> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_fabric_cost_base')
    .select('*')
    .order('fabric_code')
    .limit(PAGE_SIZE);
  return (data ?? []) as FabricCostBase[];
}

/** Cutting-register entries (most recent first), for the Cutting Register page. */
export async function loadCuttingRegisters(): Promise<CuttingRegister[]> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_cutting_register')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(PAGE_SIZE);
  return (data ?? []) as CuttingRegister[];
}

/** Cutting-register dynamic links (most recent first). */
export async function loadDynamicLinks(): Promise<DynamicLink[]> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_dynamic_links')
    .select('*')
    .eq('link_type', 'cutting_register')
    .order('created_at', { ascending: false })
    .limit(PAGE_SIZE);
  return (data ?? []) as DynamicLink[];
}

/** product_code + product_name for the "Add Product" picker (search by either). */
export async function loadProductCatalog(): Promise<ProductCatalogItem[]> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_product_catalog')
    .select('product_code, product_name, category, sub_category')
    .order('product_code')
    .limit(PAGE_SIZE);
  return (data ?? []) as ProductCatalogItem[];
}

/** Monthly EFOB fabric-cost benchmarks, most recent first (spec §6). */
export async function loadEfobFabricCost(): Promise<EfobFabricCost[]> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_efob_fabric_cost')
    .select('*')
    .order('month', { ascending: false })
    .order('fabric_code')
    .limit(500);
  return (data ?? []) as EfobFabricCost[];
}

/** product_code → BOM standard, so the cutting form can show the standard by product. */
export async function loadProductBom(): Promise<Record<string, ProductBom>> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_product_master')
    .select('product_code, bom_quantity, bom_uom')
    .limit(PAGE_SIZE);
  const map: Record<string, ProductBom> = {};
  for (const r of (data ?? []) as { product_code: string; bom_quantity: number | null; bom_uom: string | null }[]) {
    map[r.product_code] = { bom_quantity: r.bom_quantity, bom_uom: r.bom_uom };
  }
  return map;
}

/** Full material master (all types) + active colours, for the Material Master page. */
export async function loadMaterialMaster(): Promise<{
  materials: MaterialMaster[];
  colours: Colour[];
  fabricCodes: string[];
}> {
  const supabase = await client();
  const [{ data: materials }, { data: colours }, { data: fabrics }] = await Promise.all([
    supabase.from('sd_material_master').select('*').order('material_type').order('material_code').limit(PAGE_SIZE),
    supabase.from('sd_colour_master').select('colour, is_active').order('colour').limit(PAGE_SIZE),
    supabase.from('sd_fabric_master').select('fabric_code').eq('is_active', true).order('fabric_code').limit(PAGE_SIZE),
  ]);
  return {
    materials: (materials ?? []) as MaterialMaster[],
    colours: (colours ?? []) as Colour[],
    fabricCodes: ((fabrics ?? []) as { fabric_code: string }[]).map((f) => f.fabric_code),
  };
}
