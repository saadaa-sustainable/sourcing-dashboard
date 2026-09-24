import 'server-only';
// The daily inventory report that goes to Slack.
//
// Every SKU × warehouse from `sd_inventory_planning` — the snapshot BigQuery syncs from
// EasyEcom twice a day — written to a CSV, stored in the private `inventory-reports`
// bucket, and posted to the Supply Chain channel as a summary plus a signed download link.
//
// Why a link and not an attachment: Slack incoming webhooks are text-only. Attaching a file
// needs a Slack app with a bot token, which this project does not have; the buying-plan
// month report solved the same problem the same way, so this follows it rather than
// inventing a second pattern.
//
// Runs with the SERVICE-ROLE client: a cron has no user session, and the report must read
// every inventory row regardless of who (or what) triggered it.

import { createAdminClient, hasSupabaseAdminEnv } from '@/lib/supabase/admin';
import { toCsv, type CsvValue } from '@/lib/download';
import { hasSupplyChainSlack, notifyInventoryReportSlack } from '@/lib/slack';
import { loadOosSummary, type OosDb } from '@/lib/forms/queries-modules/oos-summary';
import { istToday } from '@/lib/business-logic';

const BUCKET = 'inventory-reports';
const SIGNED_URL_SECONDS = 60 * 60 * 24 * 30; // 30 days — the Slack link stays useful
const PAGE = 1000; // PostgREST caps a response at 1,000 rows; page explicitly.

/** The columns the report carries, in the order they read on the sheet. */
const COLUMNS = [
  'sku',
  'warehouse',
  'category',
  'product_variant',
  'size',
  'color',
  'product_state',
  'current_stock',
  'total_inprogress',
  'daily_quantity',
  't7_quantity',
  't45_quantity',
  'doq_45',
  'doq_90',
  'oos_days_45',
  'lead_time',
  'buffer_days',
  'shopify_sp',
  'cost',
  'date_day',
] as const;

type Row = Record<(typeof COLUMNS)[number], CsvValue>;

export type InventoryReportSummary = {
  rows: number;
  skus: number;
  warehouses: number;
  /**
   * Out of stock as the DOQ dashboard counts it — Main Warehouse, on-sale product states,
   * minus the shared exclusion list. Deliberately the dashboard's own figure rather than a
   * second definition, so Slack and the screen never disagree. Null if it cannot be read.
   */
  outOfStock: number | null;
  outOfStockPct: number | null;
  /** SKUs with nothing in ANY warehouse — a wider, simpler count than the one above. */
  emptyEverywhere: number;
  skusCounted: number;
  /** In stock but under 15 days of cover, judged on what actually sold in the last 45 days. */
  runningLow: number;
  totalStock: number;
  totalInProgress: number;
  /** The snapshot's own data day — older than today means the sync has not run. */
  dataDay: string | null;
  stale: boolean;
};

export type InventoryReportResult =
  | {
      ok: true;
      summary: InventoryReportSummary;
      url: string | null;
      storagePath: string;
      posted: boolean;
      slackError: string | null;
    }
  | { ok: false; error: string };

const num = (v: unknown) => (v == null || v === '' ? 0 : Number(v) || 0);

/**
 * Build today's inventory CSV, store it, and (optionally) post it to Slack.
 *
 * `post: false` still writes the file and records the row, so the report can be generated
 * and checked without sending anything to a channel.
 */
export async function generateInventoryReport(
  opts: { post: boolean; by: string },
): Promise<InventoryReportResult> {
  if (!hasSupabaseAdminEnv()) {
    return { ok: false, error: 'Service-role key not configured — the report needs it to read every row and write the file.' };
  }
  const admin = createAdminClient();

  // Every row of the snapshot. Paged deliberately: a single PostgREST response stops at
  // 1,000 rows silently, and this table is ~13,500.
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from('sd_inventory_planning')
      .select(COLUMNS.join(', '))
      .order('row_key')
      .range(from, from + PAGE - 1);
    if (error) return { ok: false, error: `Could not read the inventory: ${error.message}` };
    const batch = (data ?? []) as unknown as Row[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  if (!rows.length) return { ok: false, error: 'The inventory snapshot is empty — has the sync run?' };

  // Summary figures. Stock is summed across warehouses per SKU: empty in one building is
  // not out of stock.
  //
  // Demand is what actually SOLD in the last 45 days, not `daily_quantity` — that column is
  // populated for only 76 of 5,045 SKUs, so days-of-cover built on it looks precise and
  // means nothing. `t45_quantity` covers 3,180 SKUs.
  const bySku = new Map<string, { stock: number; sold45: number }>();
  const warehouses = new Set<string>();
  let totalStock = 0;
  let totalInProgress = 0;
  let dataDay: string | null = null;
  for (const r of rows) {
    const sku = String(r.sku ?? '').trim();
    warehouses.add(String(r.warehouse ?? '').trim());
    const stock = num(r.current_stock);
    totalStock += stock;
    totalInProgress += num(r.total_inprogress);
    if (r.date_day && !dataDay) dataDay = String(r.date_day).slice(0, 10);
    if (!sku) continue;
    const cur = bySku.get(sku) ?? { stock: 0, sold45: 0 };
    cur.stock += stock;
    cur.sold45 += num(r.t45_quantity);
    bySku.set(sku, cur);
  }
  const skuList = [...bySku.values()];
  const emptyEverywhere = skuList.filter((s) => s.stock <= 0).length;
  const runningLow = skuList.filter((s) => {
    if (s.stock <= 0 || s.sold45 <= 0) return false;
    return s.stock / (s.sold45 / 45) < 15;
  }).length;
  const today = istToday().toISOString().slice(0, 10);

  // The headline OOS figure comes from the dashboard's own summary, not a second count.
  let outOfStock: number | null = null;
  let outOfStockPct: number | null = null;
  try {
    const oos = await loadOosSummary(admin as unknown as OosDb);
    if (oos) {
      outOfStock = oos.all.oosYesterday;
      outOfStockPct = oos.all.pctYesterday;
    }
  } catch {
    /* the report still goes out with the wider count below */
  }

  const summary: InventoryReportSummary = {
    rows: rows.length,
    skus: bySku.size,
    warehouses: warehouses.size,
    outOfStock,
    outOfStockPct,
    emptyEverywhere,
    skusCounted: bySku.size,
    runningLow,
    totalStock,
    totalInProgress,
    dataDay,
    // A snapshot older than today means the morning sync has not landed — the report is
    // still sent, but it says so rather than passing yesterday off as today.
    stale: Boolean(dataDay && dataDay < today),
  };

  const csv = toCsv(
    COLUMNS as unknown as string[],
    rows.map((r) => COLUMNS.map((c) => r[c] ?? '')),
  );
  const storagePath = `inventory/${today}.csv`;
  const { error: upErr } = await admin.storage
    .from(BUCKET)
    // A BOM keeps Excel happy with UTF-8 — colour names and product codes are not all ASCII.
    .upload(storagePath, new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), {
      contentType: 'text/csv;charset=utf-8',
      upsert: true,
    });
  if (upErr) return { ok: false, error: `Could not store the CSV: ${upErr.message}` };

  const { data: signed } = await admin.storage.from(BUCKET).createSignedUrl(storagePath, SIGNED_URL_SECONDS);
  const url = signed?.signedUrl ?? null;

  let posted = false;
  let slackError: string | null = null;
  if (opts.post) {
    if (!hasSupplyChainSlack()) {
      slackError = 'No Slack webhook configured (SLACK_SUPPLY_CHAIN_WEBHOOK_URL / SLACK_OPS_WEBHOOK_URL).';
    } else {
      try {
        posted = await notifyInventoryReportSlack({ day: today, summary, csvUrl: url });
        if (!posted) slackError = 'Slack post was skipped (no webhook).';
      } catch (err) {
        slackError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  // One row per day — regenerating overwrites rather than piling up duplicates.
  await admin.from('sd_inventory_report').upsert(
    {
      report_day: today,
      data_day: dataDay,
      storage_path: storagePath,
      rows: summary.rows,
      skus: summary.skus,
      summary,
      generated_by: opts.by,
      generated_at: new Date().toISOString(),
      slack_posted_at: posted ? new Date().toISOString() : null,
      slack_error: slackError,
    },
    { onConflict: 'report_day' },
  );

  return { ok: true, summary, url, storagePath, posted, slackError };
}
