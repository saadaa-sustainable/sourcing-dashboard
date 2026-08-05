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

/**
 * Map one sd_po_dashboard row (GCP pipeline shape) onto the dashboard's PendingPo.
 * po_type is derived in the view from po_ref_num (FOB/EFOB/JOB). pending_qty_actual
 * mirrors pending_qty — the pipeline's pending is already the true open quantity.
 */
function mapPipelinePo(r: Record<string, unknown>): PendingPo {
  const num = (v: unknown) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  };
  const str = (v: unknown) => (v == null || v === '' ? null : String(v));
  const pending = num(r.pending_qty);
  return {
    source_row_key: str(r.po_detail_id) ?? undefined,
    po_number: str(r.po_number),
    po_created_date: str(r.po_date),
    po_date: str(r.po_date),
    item_price: num(r.item_price),
    po_id: str(r.po_id),
    sku: str(r.sku),
    product_description: str(r.product_description),
    cp_id: str(r.product_id),
    po_detail_id: str(r.po_detail_id),
    original_quantity: num(r.original_qty),
    pending_quantity: pending,
    size: str(r.size),
    po_status: str(r.po_status),
    vendor_name: str(r.vendor_name),
    vendor_code: str(r.vendor_code),
    expected_delivery_date: str(r.expected_delivery_date),
    po_ref_num: str(r.po_ref_num),
    product_variant: str(r.product_variant),
    product_code: str(r.product_code),
    pending_qty_actual: pending,
    po_type: str(r.po_type),
    match_flag: true,
  };
}

/**
 * The dashboard's PO source: sd_po_dashboard (GCP pipeline, filtered to the live
 * sourcing working set). Replaces the pending_po_master sheet. Pages past the
 * PostgREST 1000-row cap with a stable sort on po_detail_id.
 */
async function fetchDashboardPos(supabase: Reader): Promise<PendingPo[]> {
  const rows: PendingPo[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase.from('sd_po_dashboard').select('*')
      .order('po_detail_id', { ascending: true }).range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Supabase read failed for sd_po_dashboard: ${error.message}`);
    if (!data?.length) break;
    rows.push(...(data as Record<string, unknown>[]).map(mapPipelinePo));
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
    merchant_name: s(row.merchant_name), primary_type: s(row.primary_type), total_machines: n(row.total_machines),
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
      // Richer TNA Update milestones (null/0 until the mirror pulls these columns).
      first_delivery_tna_date: date(row.first_delivery_tna_date),
      first_delivery_actual_date: date(row.first_delivery_actual_date),
      first_delivery_delay_days: n(row.first_delivery_delay_days),
      po_closer_tna_date: date(row.po_closer_tna_date),
      po_closer_actual_date: date(row.po_closer_actual_date),
      po_closer_delay_days: n(row.po_closer_delay_days),
      grn_qty: n(row.grn_qty), pending_qty: n(row.pending_qty),
      current_production_stage: s(row.current_production_stage),
      total_delay_days: row.total_delay_days == null || row.total_delay_days === '' ? null : n(row.total_delay_days),
    });
  });

  return {
    pendingPos, vendorTypes, vendorMasters, tnaRecords: [...tnaMap.values()],
    source: 'fixtures', warnings, loadedAt: new Date().toISOString(),
  };
}

type StageActualsRow = {
  po_ref_num: string;
  pp_actual: string | null;
  gpt_actual: string | null;
  cutting_actual: string | null;
  inline_actual: string | null;
  first_delivery_actual: string | null;
  po_closer_actual: string | null;
};

/** sd_po_stage_actuals — one row per PO ref with each stage's latest form actual date. */
async function fetchStageActuals(supabase: Reader): Promise<StageActualsRow[]> {
  const rows: StageActualsRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase.from('sd_po_stage_actuals').select('*')
      .order('po_ref_num', { ascending: true }).range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Supabase read failed for sd_po_stage_actuals: ${error.message}`);
    if (!data?.length) break;
    rows.push(...(data as StageActualsRow[]));
    if (data.length < PAGE_SIZE) break;
  }
  return rows;
}

/**
 * The stage ACTUAL dates come SOLELY from the Google Forms (sd_po_stage_actuals);
 * planned *_tna_date fields are untouched. A stage with no form submission is left
 * BLANK, so a missing actual visibly signals a missing form. Joined on normalized PO ref.
 */
function mergeStageActuals(tnaRecords: TnaRecord[], actuals: StageActualsRow[]): void {
  const norm = (v: string | null | undefined) => (v ?? '').trim().toUpperCase();
  const byRef = new Map(actuals.map((a) => [norm(a.po_ref_num), a]));
  for (const t of tnaRecords) {
    const a = byRef.get(norm(t.po_no));
    t.pp_sample_actual_date = a?.pp_actual ?? null;
    t.gpt_actual_date = a?.gpt_actual ?? null;
    t.cutting_actual_date_first = a?.cutting_actual ?? null;
    t.in_line_actual_date = a?.inline_actual ?? null;
    t.first_delivery_actual_date = a?.first_delivery_actual ?? null;
    t.po_closer_actual_date = a?.po_closer_actual ?? null;
  }
}

export async function loadDashboardData(): Promise<DashboardData> {
  if (!hasSupabaseEnv()) return loadFixtures();
  const supabase = await createClient();
  const [pendingPos, vendorTypes, vendorMasters, tnaRecords, stageActuals] = await Promise.all([
    fetchDashboardPos(supabase),
    fetchAllRows<VendorType>(supabase, 'vendor_type_master', 'vendor_name'),
    fetchAllRows<VendorMaster>(supabase, 'vendor_master_data', 'vendor_code'),
    fetchAllRows<TnaRecord>(supabase, 'tna_tracker', 'po_no'),
    fetchStageActuals(supabase),
  ]);
  // Stage ACTUAL dates come from the Google Forms (Production Dashboard); planned
  // TNA dates stay from tna_tracker.
  mergeStageActuals(tnaRecords, stageActuals);
  const warnings: string[] = [];
  if (!pendingPos.length) warnings.push('No PO rows returned from sd_po_dashboard — check the latest GCP pipeline load.');
  return {
    pendingPos, vendorTypes, vendorMasters, tnaRecords,
    source: 'supabase', warnings, loadedAt: new Date().toISOString(),
  };
}
