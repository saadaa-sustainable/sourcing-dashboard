#!/usr/bin/env node
/**
 * Fails when a Supabase read could silently return only its first 1,000 rows.
 *
 * Why this exists: a single PostgREST response is capped at 1,000 rows. Going over it is not
 * an error — you just get the first thousand, in no guaranteed order, with no warning. Three
 * separate bugs came from that:
 *   - per-size stock on Receivable Plan read ~1,000 of ~2,200 rows, so sizes showed blank and
 *     "no stock on hand" was displayed for stock that existed;
 *   - "Inward last 7 days" summed 1,000 of ~2,900 goods-receipt lines, understating receipts
 *     by roughly two thirds;
 *   - GRN Detail asked for 5,000 rows and got 1,000, because `.limit(5000)` cannot raise the
 *     cap — a limit above it is a wish, not a page size.
 *
 * A read is accepted when it pages (pageAll or .range), wants one row (single/maybeSingle),
 * wants only a count (head: true), or reads a table on the small list below.
 *
 * Adding a table to SMALL_TABLES is a claim that it cannot reach 1,000 rows. Put the observed
 * row count beside it. If it might grow, page instead.
 *
 * Run: node scripts/check-unpaged-reads.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** table -> rows observed when it was added. Must stay comfortably under 1,000. */
const SMALL_TABLES = {
  sd_active_variants: 410,
  sd_adjustment_refresh_log: 0,
  sd_analytics_rule: 12,
  sd_approval_log: 267,
  sd_buying_plan_line: 132,
  sd_cash_flow_by_month: 433,
  sd_cmtp_component: 337,
  sd_cmtp_revision: 3,
  sd_cutting_register: 0,
  sd_ee_product_code_status: 67,
  sd_ee_vendor_master: 94,
  sd_efob_fabric_cost: 1,
  sd_inventory_by_product: 89,
  sd_manual_adjustment_entry: 0,
  sd_npd_promotion_candidates: 7,
  sd_po_actuals_by_product_month: 461,
  sd_po_approval: 4,
  sd_po_approval_line: 9,
  // One row per ask to delete a PO request, and only the undecided ones are ever read
  // unpaged. Bounded by the number of PO requests, which is itself a handful.
  sd_po_delete_request: 1,
  sd_po_details: 482,
  sd_product_fabric: 108,
  sd_product_launch_date: 95,
  sd_product_master: 49,
  sd_temp_product: 2,
  sd_tna_status_snapshot: 18,
  sd_vendor_in_process: 23,
  sd_buying_plan: 6,
  sd_cmtp_subitem: 40,
  sd_colour_master: 60,
  sd_cost_standards: 1,
  sd_custom_role: 10,
  sd_discontinue_request: 30,
  sd_dynamic_links: 10,
  sd_fabric_cost_base: 120,
  sd_fabric_master: 200,
  sd_fabric_rate_submission: 60,
  sd_feature_status: 40,
  sd_feedback: 40,
  sd_feedback_message: 200,
  sd_feedback_vote: 100,
  sd_inward_plan_entry: 110,
  sd_material_codes: 200,
  sd_material_master: 200,
  sd_material_standard_cost: 60,
  sd_nav_visibility: 40,
  sd_oos_sku_exclusion: 0,
  sd_plan_report: 5,
  sd_po_closure: 77,
  sd_po_cycle_time: 3,
  sd_product_catalog: 109,
  sd_receivable_input: 0,
  sd_receivable_plan: 454,
  sd_replenishment: 669,
  sd_replenishment_by_product: 89,
  sd_standard_cost: 88,
  sd_sync_status: 30,
  sd_tna_leadtimes: 1,
  sd_user: 40,
  sd_user_role: 60,
  sd_variant_sales: 669,
  sd_vendor_capacity_log: 40,
  sd_vendor_commitment_log: 3,
  sd_vendor_grn_reject: 69,
  sd_vendor_payment_terms: 29,
  sd_vendor_po_performance: 0,
  sd_vendor_product_capacity_allocation: 200,
  sd_vendor_recommendation: 60,
  sd_vendor_return_qc: 31,
  sd_vendor_type_multiplier: 3,
  sd_vendor_deboarding_request: 0,
  sd_issue_route: 9,
  sd_vendor_deboarding_stats: 50,
  vendor_master_data: 32,
  vendor_type_master: 21,
};

const PAGED = ['.range(', 'pageAll', '.single()', '.maybeSingle()', 'head: true'];
/**
 * Escape hatch for a read that touches a big table but can only return a few rows — narrowed
 * by an id, or feeding a picker that is already capped. Write the reason:
 *   // paging-ok: filtered to one PO, at most a few dozen lines
 * A waiver with no reason after the colon is rejected, because "paging-ok" on its own is
 * indistinguishable from someone silencing the check.
 */
const WAIVER = /\/\/\s*paging-ok:\s*\S+/;
const WRITES = /\.(insert|upsert|update|delete|rpc)\(/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const problems = [];
for (const file of walk('src')) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/\.from\((['"])([a-z0-9_]+)\1\)/g)) {
    const table = m[2];
    if (table in SMALL_TABLES) continue;
    const start = m.index ?? 0;
    const end = src.indexOf(';', start);
    const stmt = src.slice(start, end === -1 ? start + 600 : end);
    // pageAll wraps the call, so look back far enough to see it
    const context = src.slice(Math.max(0, start - 300), start) + stmt;
    if (PAGED.some((k) => context.includes(k))) continue;
    if (WRITES.test(stmt)) continue;
    if (WAIVER.test(context)) continue;
    const line = src.slice(0, start).split('\n').length;
    const limit = /\.limit\((\w+)\)/.exec(stmt);
    // A deliberate small cap is fine: the code asks for N rows and gets them. Only a limit
    // at or above the response cap is a problem — it reads like a page size and is not.
    if (limit && /^\d+$/.test(limit[1]) && Number(limit[1]) < 1000) continue;
    problems.push({
      file: file.replace(/\\/g, '/'),
      line,
      table,
      limit: limit ? limit[1] : null,
    });
  }
}

if (!problems.length) {
  console.log('check-unpaged-reads: OK — every read either pages or reads a known-small table.');
  process.exit(0);
}

console.error(`check-unpaged-reads: ${problems.length} read(s) may silently stop at 1,000 rows.\n`);
for (const p of problems) {
  const note = p.limit
    ? `has .limit(${p.limit}) — a limit does NOT raise the 1,000-row response cap`
    : 'no paging and no limit';
  console.error(`  ${p.file}:${p.line}  ${p.table}  (${note})`);
}
console.error(`
Fix one of these ways:
  - wrap the query in pageAll(() => supabase.from(...)...) with a stable .order(), or
  - add .range() and loop, or
  - if the table genuinely cannot reach 1,000 rows, add it to SMALL_TABLES in
    scripts/check-unpaged-reads.mjs with the row count you observed, or
  - if the read is narrowed so it can only return a few rows, put a reason beside it:
      // paging-ok: filtered to one PO, at most a few dozen lines
`);
process.exit(1);
