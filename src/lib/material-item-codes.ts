import type { MaterialCode, MaterialType } from './forms/types';

export type MaterialItem = {
  sku: string;
  product_name: string | null;
  item_category: string | null;
  category_name: string | null;
  colour: string | null;
  rm_fabric_sku: string | null;
};

const normal = (value: string | null) => (value ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
// Explicit EasyEcom classifications. Do not treat an unclassified garment as a trim.
const TYPES: Record<string, MaterialType> = {
  GREIGE: 'raw', RAW: 'raw', 'RAW MATERIAL': 'raw',
  FINISHED: 'dyed', DYED: 'dyed', 'DYED/FINISHED': 'dyed', 'DYED / FINISHED': 'dyed',
  TRIM: 'trim', TRIMS: 'trim', 'SIZE LABEL': 'trim', 'VENDOR LABEL': 'trim',
  'WASHCARE LABEL': 'trim', 'THERMAL LABEL': 'trim', 'SEED TAGS': 'trim',
  'BUTTER PAPPER': 'trim', 'CELLO TAPE': 'trim', CHITTHI: 'trim',
  'FABRIC BAG': 'trim', 'POLY BAG': 'trim',
};

export function materialItemCodes(items: MaterialItem[]): MaterialCode[] {
  const codes = new Map<string, MaterialCode>();
  for (const item of items) {
    const type = TYPES[normal(item.item_category)] ?? TYPES[normal(item.category_name)];
    const code = item.sku.trim().toUpperCase();
    if (!type || !code) continue;
    const mapped: MaterialCode = {
      material_code: code,
      material_type: type,
      fabric_name: item.product_name?.trim() || code,
      colour: item.colour?.trim() || null,
      base_fabric_code: item.rm_fabric_sku?.trim().toUpperCase() || null,
    };
    const prior = codes.get(code);
    if (prior && JSON.stringify(prior) !== JSON.stringify(mapped)) {
      throw new Error(`Conflicting EasyEcom material entries for ${code}`);
    }
    codes.set(code, mapped);
  }
  return [...codes.values()].sort((a, b) => a.material_code.localeCompare(b.material_code));
}
