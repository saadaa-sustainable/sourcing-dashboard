// Shared source-of-truth for the EasyEcom product master sync.
//   Base:        saadaa-wh.MAPLEMONK.Easyecom_new_product_master        (per-sku)
//   Attributes:  saadaa-wh.MAPLEMONK.Easyecom_new_product_master_custom_fields
//                (long form: cp_id, field_name, value) pivoted onto cp_id.
// One row per sku (7,140), joined to its product's custom fields. All values text.

// EasyEcom custom-field display name -> Supabase snake_case column.
export const PM_CUSTOM_FIELDS = {
  CategoryType: 'category_type',
  Color_Family: 'color_family',
  DEMOGRAPHIC_PRICE_RAGE: 'demographic_price_rage',
  Dyed_Fabric_SKU: 'dyed_fabric_sku',
  FABRIC_COMPOSITION: 'fabric_composition',
  FABRIC_GSM: 'fabric_gsm',
  FABRIC_NAME: 'fabric_name',
  'Fabric Consumption (Average)': 'fabric_consumption_average',
  FitType: 'fit_type',
  GST: 'gst',
  Garment_Length_Type: 'garment_length_type',
  Gender: 'gender',
  'Item Category': 'item_category',
  Neck_Collar_Type: 'neck_collar_type',
  Product_Launch_Date: 'product_launch_date',
  Product_State: 'product_state',
  Product_Type: 'product_type',
  Product_Variant: 'product_variant',
  'Qty (in Meters)': 'qty_in_meters',
  RM_Fabric_SKU: 'rm_fabric_sku',
  Related_Ongoing_Product: 'related_ongoing_product',
  Replenishment_Type: 'replenishment_type',
  SUB_CATEGORY: 'sub_category',
  Season: 'season',
  Sleeve_Type: 'sleeve_type',
  WEAVE_TYPE: 'weave_type',
  Washcare_SKU: 'washcare_sku',
};

const BASE_COLS = [
  'mrp', 'sku', 'cost', 'size', 'width', 'active', 'colour', 'height', 'length', 'weight',
  'hsn_code', 'model_no', 'tax_rate', 'created_at', 'description', 'product_name', 'category_name',
  'tax_rule_name', 'product_image_url',
];

export const PM_COLS = new Set([...BASE_COLS, ...Object.values(PM_CUSTOM_FIELDS)]);

const pivots = Object.entries(PM_CUSTOM_FIELDS)
  .map(([fn, col]) => `MAX(IF(field_name = ${JSON.stringify(fn)}, value, NULL)) AS ${col}`)
  .join(',\n    ');

export const PM_QUERY = `
WITH cf AS (
  SELECT cp_id,
    ${pivots}
  FROM \`saadaa-wh.MAPLEMONK.Easyecom_new_product_master_custom_fields\`
  GROUP BY cp_id
)
SELECT
  ${BASE_COLS.map((c) => `m.${c}`).join(', ')},
  ${Object.values(PM_CUSTOM_FIELDS).map((c) => `cf.${c}`).join(', ')}
FROM \`saadaa-wh.MAPLEMONK.Easyecom_new_product_master\` m
LEFT JOIN cf ON m.cp_id = cf.cp_id`;
