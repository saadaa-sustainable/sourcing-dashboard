import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { csvObjects, csvTable } from './csv';
import { sheetBoolean, sheetDate, sheetNumber, sheetText } from './sheet-values';
import { createClient, hasSupabaseEnv } from './supabase/server';
import type { DashboardData, PendingPo, TnaRecord, VendorMaster, VendorType } from './types';

const n = sheetNumber;
const s = sheetText;
const bool = sheetBoolean;
const date = sheetDate;

/**
 * PostgREST caps a single response (Supabase defaults to 1000 rows), so a plain
 * `select('*')` silently truncates. pending_po_master is already ~3k live rows, which
 * would drop most open POs with no error surfaced. Page through with a stable sort.
 */
const PAGE_SIZE = 1000;

type Reader = Awaited<ReturnType<typeof createClient>>;

async function fetchAllRows<T>(supabase: Reader, table: string, orderBy: string): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase.from(table).select('*').eq('is_active', true)
      .order(orderBy, { ascending: true }).range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Supabase read failed for ${table}: ${error.message}`);
    if (!data?.length) break;
    rows.push(...(data as T[]));
    if (data.length < PAGE_SIZE) break;
  }
  return rows;
}

async function fixture(name: string) {
  return readFile(path.join(process.cwd(), 'data', 'fixtures', name), 'utf8');
}

/**
 * A PO line is only meaningful if it can be traced back to a PO. The sheets carry a
 * long tail of filler rows (blank apart from a stray "TRUE" in the Match column) that
 * would otherwise become rows sharing one synthetic key.
 */
function isIdentifiablePoRow(row: Record<string, string>) {
  return Boolean(s(row.po_ref_num) ?? s(row.po_detail_id));
}

async function loadFixtures(): Promise<DashboardData> {
  const [poText, typeText, masterText, tnaText] = await Promise.all([
    fixture('pending_po_master.csv'), fixture('vendor_type_master.csv'),
    fixture('vendor_master_data.csv'), fixture('tna_tracker.csv'),
  ]);
  const warnings: string[] = [
    'Local fixture mode: configure Supabase environment variables for authenticated live data.',
  ];

  const poRows = csvObjects(poText);
  const usablePoRows = poRows.filter(isIdentifiablePoRow);
  if (usablePoRows.length < poRows.length) {
    warnings.push(`Skipped ${poRows.length - usablePoRows.length} PO rows with no PO reference or detail id.`);
  }
  const pendingPos: PendingPo[] = usablePoRows.map((row) => {
    const detailId = s(row.po_detail_id);
    const legacy = [row.po_ref_num, row.sku, row.cp_id, row.po_id, row.size].join('|');
    return {
      source_row_key: detailId ?? `legacy:${createHash('sha256').update(legacy).digest('hex')}`,
      po_number: s(row.po_number), po_created_date: s(row.po_created_date), po_date: date(row.po_date),
      item_price: n(row.item_price), po_id: s(row.po_id), sku: s(row.sku),
      product_description: s(row.product_description), cp_id: s(row.cp_id), po_detail_id: detailId,
      original_quantity: n(row.original_quantity), pending_quantity: n(row.pending_quantity),
      size: s(row.size), po_status: s(row.po_status), vendor_name: s(row.vendor_name),
      vendor_code: s(row.vendor_code), expected_delivery_date: date(row.expected_delivery_date),
      po_ref_num: s(row.po_ref_num), product_variant: s(row.product_varient), product_code: s(row.product_code),
      pending_qty_actual: n(row.pending_qty_actual), po_type: s(row.po_type), match_flag: bool(row.match),
    };
  });

  const vendorTypes: VendorType[] = csvObjects(typeText)
    .filter((row) => s(row.vendor_name))
    .map((row) => ({
      vendor_name: s(row.vendor_name)!, vendor_code: s(row.vendor_code),
      vendor_type: s(row.vendor_type), merchant_name: s(row.merchant_name), status: s(row.status),
    }));

  // Row 1 is a merged "Vendor Master" group label; the real header is row 2.
  const masterTable = csvTable(masterText, 1);
  const karigarIndex = masterTable.headers.findIndex((header) => header.startsWith('no_of_karigar_'));
  const karigarKey = karigarIndex >= 0 ? masterTable.headers[karigarIndex] : '';
  const vendorMasters: VendorMaster[] = masterTable.objects.filter((row) => s(row.vendor_code)).map((row) => ({
    vendor_code: s(row.vendor_code)!, vendor_name: s(row.vendor_name), onboarding_date: date(row.onboarding_date),
    merchant_name: s(row.merchant_name), total_machines: n(row.total_machines),
    total_active_karigar: n(row.total_active_karigar), machines_for_saadaa: n(row.no_of_machines_for_saadaa),
    capacity_per_month: n(row.capacity_month_for_saadaa),
    karigar_latest: karigarKey ? n(row[karigarKey]) : 0,
    karigar_latest_as_of: karigarIndex >= 0 ? masterTable.literalHeaders[karigarIndex] : null,
  }));

  const tnaMap = new Map<string, TnaRecord>();
  csvObjects(tnaText).forEach((row) => {
    const po = s(row.po_no); if (!po) return;
    tnaMap.set(po, {
      po_no: po, po_issued_date: date(row.po_issued_date), po_qty: n(row.po_qty),
      pp_sample_tna_date: date(row.pp_sample_tna_date), pp_sample_actual_date: date(row.pp_sample_actual_date),
      pp_sample_delay_days: n(row.pp_sample_delay_days), gpt_tna_date: date(row.gpt_tna_date),
      gpt_actual_date: date(row.gpt_actual_date), gpt_delay_days: n(row.gpt_delay_days),
      cutting_tna_date: date(row.cutting_tna_date), cutting_actual_date_first: date(row.cutting_actual_date_first),
      cutting_delay_days: n(row.cutting_delay_days), in_line_tna_date: date(row.in_line_tna_date),
      in_line_actual_date: date(row.in_line_actual_date), in_line_qc_delay_days: n(row.in_line_qc_delay_days),
    });
  });

  return {
    pendingPos, vendorTypes, vendorMasters, tnaRecords: [...tnaMap.values()],
    source: 'fixtures', warnings, loadedAt: new Date().toISOString(),
  };
}

export async function loadDashboardData(): Promise<DashboardData> {
  if (!hasSupabaseEnv()) return loadFixtures();
  const supabase = await createClient();
  const [pendingPos, vendorTypes, vendorMasters, tnaRecords] = await Promise.all([
    fetchAllRows<PendingPo>(supabase, 'pending_po_master', 'id'),
    fetchAllRows<VendorType>(supabase, 'vendor_type_master', 'vendor_name'),
    fetchAllRows<VendorMaster>(supabase, 'vendor_master_data', 'vendor_code'),
    fetchAllRows<TnaRecord>(supabase, 'tna_tracker', 'po_no'),
  ]);
  const warnings: string[] = [];
  if (!pendingPos.length) warnings.push('No active PO rows returned from Supabase — check the latest sync_log entry.');
  return {
    pendingPos, vendorTypes, vendorMasters, tnaRecords,
    source: 'supabase', warnings, loadedAt: new Date().toISOString(),
  };
}
