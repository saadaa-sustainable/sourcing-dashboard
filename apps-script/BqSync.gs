/**
 * SAADAA BigQuery -> Supabase sync (namespaced build, companion to Code.gs).
 *
 * Replaces the laptop backfill scripts (backfill/sync-daily.mjs + backfill-grn-qc.mjs)
 * with time-driven triggers that run on Google's servers as the installing user —
 * no service-account key needed. Data flows BigQuery -> script memory -> Supabase
 * REST upsert; nothing is written to any sheet.
 *
 * Cost design (BigQuery bills bytes scanned; saadaa_inventory_planning is a 6 GB
 * UNPARTITIONED table, so date filters do NOT prune — only column selection does):
 *   - Daily DOQ pull fetches only the numeric planning columns  (~1.5 GB scan)
 *   - Sundays (or bqSyncFullInventoryRefresh) fetch all columns (~6 GB scan)
 *   - OOS is computed IN THIS SCRIPT from the DOQ rows            (saves ~1.8 GB/day)
 *   - Everything else is megabytes.  Total ≈ 60 GB/month, inside BigQuery's free 1 TiB.
 * Daily upserts send only the fetched columns; Supabase keeps existing values for
 * columns missing from the payload, so descriptive fields survive between Sundays.
 *
 * Sync cadence (installed by installBqSyncTriggers, script timezone must be
 * Asia/Kolkata — check appsscript.json):
 *   ~6 AM  bqSyncMorningA : product master -> sd_ee_product_master
 *                           DOQ            -> sd_inventory_planning (numeric daily / full Sunday)
 *                           OOS (in-script)-> sd_oos_calculation
 *   ~6 AM  bqSyncMorningB : PO master (all) -> sd_po_master_raw (Open PO Tracker / in-process feed)
 *                           GRN 45d        -> sd_po_grn_mapping
 *                           GRN-QC 30d     -> sd_ee_grn (+ refresh_vendor_recommendation)
 *                           vendor names + EasyEcom status -> vendor_master_data
 *                           adjustments    -> sd_po_qty_manual_adjustment / _cutting_register
 *   ~6 PM  bqSyncEvening  : PO master -> sd_po_master_raw, GRN 45d -> sd_po_grn_mapping
 * Every target logs to public.sync_log (same table the sheet sync uses).
 *
 * ONE-TIME SETUP (must be done logged in as an account with BigQuery access on
 * saadaa-wh, e.g. pushpendra@saadaa.in):
 *   1. Paste this file into the Apps Script project that already runs Code.gs
 *      (Script Properties SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are reused).
 *   2. Editor left sidebar -> Services (+) -> add "BigQuery API".
 *   3. Run installBqSyncTriggers() once and grant the OAuth consent.
 *   4. Optional first fill: run bqSyncFullInventoryRefresh() once.
 * Then remove the laptop Task Scheduler jobs ("Saadaa Sourcing Sync 6AM/6PM").
 */

// ---- Trigger entry points (the only globals besides BqSync_) ----
function bqSyncMorningA() { return BqSync_.morningA(); }
function bqSyncMorningB() { return BqSync_.morningB(); }
function bqSyncEvening() { return BqSync_.evening(); }
function installBqSyncTriggers() { return BqSync_.install(); }
// Manual: full-column inventory refresh (~6 GB scan) — use after schema changes
// or to fill descriptive columns without waiting for Sunday.
function bqSyncFullInventoryRefresh() { return BqSync_.doqOos(true); }
// DOQ Dashboard window aggregates (runs in morningA too; manual run for testing).
function bqSyncDoqWindows() { return BqSync_.doqWindows(); }
// Manual: run only the vendor sync now (names + EasyEcom status) — use right
// after applying the ee_status migration so the column fills without waiting for
// the 6 AM trigger.
function bqSyncVendors() { return BqSync_.vendorsOnce(); }
// Manual: print the Easyecom_Saadaa_vendors columns + a few sample rows, so you
// can confirm which column carries the active/inactive status and how it's coded.
function bqVendorSchema() { return BqSync_.vendorSchema(); }
// Manual: pull the EasyEcom vendor master RAW (as-is) into sd_ee_vendor_master now,
// without waiting for the 6 AM trigger. Runs automatically in morningB too.
function bqEeVendorMaster() { return BqSync_.eeVendorMaster(); }

const BqSync_ = (function () {
  const PROJECT = 'saadaa-wh';
  const LOCATION = 'asia-south1';
  const DATASET = '`saadaa-wh.MAPLEMONK.';
  const BATCH = 500;

  // Numeric/planning columns pulled EVERY day (~1.5 GB of the 6 GB table).
  const INV_DAILY_COLS = [
    'date_day', 'sku', 'warehouse', 'size', 'product_state', 'current_stock', 'total_inprogress',
    'daily_quantity', 'has_inventory_today', 't7_quantity', 't45_quantity',
    'doq_7', 'doq_15', 'doq_30', 'doq_45', 'doq_90', 'doq_365',
    'oos_days_45', 'total_sales_in_last_45_inventory_days', 'weighted_doq_45',
    'monthly_doq', 'yearly_doq', 'lead_time', 'buffer_days', 'shopify_sp', 'v_doq', 'cost',
  ];
  // Descriptive / rarely-used columns refreshed only on Sundays (they push the scan to ~6 GB).
  const INV_WEEKLY_COLS = [
    'rm_code', 'dyed_fabric_sku', 'product_name', 'product_variant', 'color', 'category',
    'sub_category', 'fabric_consumption_average', 'categorytype', 'item_category', 'gender',
    'fittype', 'age_group', 'demographic_price_range', 'weave_type', 'fabric_name',
    'fabric_composition', 'fabric_gsm', 'garment_length_type', 'sleeve_type', 'neck_collar_type',
    'replenishment_type', 'washcare_sku', 'season', 'gst', 'related_ongoing_product',
    'qty_in_metres', 't730_quantity', 't73015_quantity', 'doq_7_30', 'doq_30_45',
    'oos_days_7', 'oos_days_15', 'oos_days_30', 'oos_days_90', 'oos_days_365', 'weightage_doq',
  ];

  // po_status_id -> label (mirror of backfill/backfill-po.mjs).
  const PO_STATUS = { 2: 'Waiting', 3: 'Approved', 4: 'Rejected', 5: 'Completed', 7: 'cancelled' };

  const GRN_COLS = [
    'po_created_date', 'po_detail_id', 'po_id', 'po_number', 'cp_id', 'sku', 'size',
    'product_description', 'po_created_warehouse', 'po_created_location_key', 'po_status',
    'vendor_name', 'vendor_code', 'expected_delivery_date', 'grn_id', 'po_ref_num', 'grn_status',
    'grn_created_date', 'grn_invoice_date', 'grn_invoice_number', 'last_grn_date', 'po_type',
    'po_original_quantity', 'po_pending_quantity', 'total_grn_value', 'grn_receive_quantity',
  ];

  // EasyEcom custom-field display name -> Supabase column (mirror of product-master-query.mjs).
  const PM_CUSTOM_FIELDS = {
    CategoryType: 'category_type', Color_Family: 'color_family',
    DEMOGRAPHIC_PRICE_RAGE: 'demographic_price_rage', Dyed_Fabric_SKU: 'dyed_fabric_sku',
    FABRIC_COMPOSITION: 'fabric_composition', FABRIC_GSM: 'fabric_gsm', FABRIC_NAME: 'fabric_name',
    'Fabric Consumption (Average)': 'fabric_consumption_average', FitType: 'fit_type', GST: 'gst',
    Garment_Length_Type: 'garment_length_type', Gender: 'gender', 'Item Category': 'item_category',
    Neck_Collar_Type: 'neck_collar_type', Product_Launch_Date: 'product_launch_date',
    Product_State: 'product_state', Product_Type: 'product_type', Product_Variant: 'product_variant',
    'Qty (in Meters)': 'qty_in_meters', RM_Fabric_SKU: 'rm_fabric_sku',
    Related_Ongoing_Product: 'related_ongoing_product', Replenishment_Type: 'replenishment_type',
    SUB_CATEGORY: 'sub_category', Season: 'season', Sleeve_Type: 'sleeve_type',
    WEAVE_TYPE: 'weave_type', Washcare_SKU: 'washcare_sku',
  };
  const PM_BASE_COLS = [
    'mrp', 'sku', 'cost', 'size', 'width', 'active', 'colour', 'height', 'length', 'weight',
    'hsn_code', 'model_no', 'tax_rate', 'created_at', 'description', 'product_name',
    'category_name', 'tax_rule_name', 'product_image_url',
  ];

  // ---------------- BigQuery ----------------

  // Runs a query via the BigQuery advanced service; returns plain objects with
  // lower-cased keys and schema-typed values (numbers as Number, TIMESTAMP as ISO).
  function runQuery(sql) {
    let resp = BigQuery.Jobs.query(
      { query: sql, useLegacySql: false, location: LOCATION, maxResults: 10000 },
      PROJECT,
    );
    const jobId = resp.jobReference.jobId;
    while (!resp.jobComplete) {
      Utilities.sleep(2000);
      resp = BigQuery.Jobs.getQueryResults(PROJECT, jobId, { location: LOCATION, maxResults: 10000 });
    }
    const fields = resp.schema.fields;
    const out = [];
    const collect = (page) => {
      for (const row of page.rows || []) {
        const obj = {};
        for (let j = 0; j < fields.length; j++) {
          const v = row.f[j].v;
          const key = fields[j].name.toLowerCase();
          const t = fields[j].type;
          if (v === null || v === undefined) obj[key] = null;
          else if (t === 'INTEGER' || t === 'INT64' || t === 'FLOAT' || t === 'FLOAT64' ||
                   t === 'NUMERIC' || t === 'BIGNUMERIC') obj[key] = Number(v);
          else if (t === 'BOOLEAN' || t === 'BOOL') obj[key] = v === 'true';
          else if (t === 'TIMESTAMP') obj[key] = new Date(Number(v) * 1000).toISOString();
          else obj[key] = v; // STRING / DATE / DATETIME stay strings
        }
        out.push(obj);
      }
    };
    collect(resp);
    while (resp.pageToken) {
      resp = BigQuery.Jobs.getQueryResults(PROJECT, jobId, {
        location: LOCATION, maxResults: 10000, pageToken: resp.pageToken,
      });
      collect(resp);
    }
    return out;
  }

  // ---------------- Supabase ----------------

  function conf_() {
    const p = PropertiesService.getScriptProperties();
    const url = p.getProperty('SUPABASE_URL');
    const key = p.getProperty('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY script property');
    return { url, key };
  }

  function supa(method, path, payload) {
    const { url, key } = conf_();
    const res = UrlFetchApp.fetch(`${url}/rest/v1/${path}`, {
      method,
      contentType: 'application/json',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      payload: payload === undefined ? undefined : JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() >= 300) {
      throw new Error(`Supabase ${method} ${path} -> ${res.getResponseCode()}: ${res.getContentText().slice(0, 300)}`);
    }
    return res;
  }

  function upsert(table, conflict, rows) {
    for (let i = 0; i < rows.length; i += BATCH) {
      supa('post', `${table}?on_conflict=${conflict}`, rows.slice(i, i + BATCH));
    }
  }

  // Same log table the 5-min sheet sync writes, so freshness checks stay unified.
  function logRun(table, startedAt, rowsSynced, rowsDeleted, status, errorMessage) {
    try {
      supa('post', 'sync_log', [{
        table_name: table, rows_synced: rowsSynced, rows_deleted: rowsDeleted,
        status, error_message: errorMessage || null,
        started_at: startedAt, finished_at: new Date().toISOString(),
      }]);
    } catch (e) {
      console.error(`sync_log write failed for ${table}: ${e.message}`);
    }
  }

  // Runs one target, logs success/error, never throws (returns the error instead
  // so the remaining targets in the trigger still run).
  function runTarget(table, fn) {
    const startedAt = new Date().toISOString();
    try {
      const result = fn() || { synced: 0, deleted: 0 };
      logRun(table, startedAt, result.synced, result.deleted || 0, 'success', null);
      console.log(`[${table}] ok: ${result.synced} rows`);
      return null;
    } catch (e) {
      logRun(table, startedAt, 0, 0, 'error', String(e.message || e).slice(0, 500));
      console.error(`[${table}] FAILED: ${e.message}`);
      return e;
    }
  }

  // ---------------- Targets ----------------

  function productMaster() {
    const pivots = Object.entries(PM_CUSTOM_FIELDS)
      .map(([fn, col]) => `MAX(IF(field_name = ${JSON.stringify(fn)}, value, NULL)) AS ${col}`)
      .join(',\n    ');
    const sql = `
      WITH cf AS (SELECT cp_id, ${pivots} FROM ${DATASET}Easyecom_new_product_master_custom_fields\` GROUP BY cp_id)
      SELECT ${PM_BASE_COLS.map((c) => `m.${c}`).join(', ')},
             ${Object.values(PM_CUSTOM_FIELDS).map((c) => `cf.${c}`).join(', ')}
      FROM ${DATASET}Easyecom_new_product_master\` m
      LEFT JOIN cf ON m.cp_id = cf.cp_id`;
    const synced_at = new Date().toISOString();
    const seen = new Set();
    const rows = [];
    for (const r of runQuery(sql)) {
      if (!r.sku || seen.has(r.sku)) continue;
      seen.add(r.sku);
      r.synced_at = synced_at;
      rows.push(r);
    }
    upsert('sd_ee_product_master', 'sku', rows);
    return { synced: rows.length };
  }

  // DOQ snapshot -> sd_inventory_planning, then OOS aggregated here (no second
  // BigQuery scan) -> sd_oos_calculation. full=true fetches all columns.
  function doqOos(full) {
    const cols = full ? INV_DAILY_COLS.concat(INV_WEEKLY_COLS) : INV_DAILY_COLS;
    const sql = `
      SELECT ${cols.join(', ')} FROM ${DATASET}saadaa_inventory_planning\`
      WHERE date_day = (SELECT MAX(date_day) FROM ${DATASET}saadaa_inventory_planning\`)`;
    const startedAt = new Date().toISOString();
    let raw;
    try {
      raw = runQuery(sql);
    } catch (e) {
      // Query itself failed: surface it on both dependent tables in sync_log.
      const msg = String(e.message || e).slice(0, 500);
      logRun('sd_inventory_planning', startedAt, 0, 0, 'error', msg);
      logRun('sd_oos_calculation', startedAt, 0, 0, 'error', msg);
      return [e];
    }
    const synced_at = new Date().toISOString();

    const invErr = runTarget('sd_inventory_planning', () => {
      const seen = new Set();
      const rows = [];
      for (const r of raw) {
        if (!r.sku) continue;
        const key = `${r.sku}|${r.warehouse || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(Object.assign({ row_key: key, synced_at }, r));
      }
      upsert('sd_inventory_planning', 'row_key', rows);
      return { synced: rows.length };
    });

    const oosErr = runTarget('sd_oos_calculation', () => {
      const rows = oosAggregate(raw, full, synced_at);
      upsert('sd_oos_calculation', 'sku', rows);
      return { synced: rows.length };
    });
    return [invErr, oosErr].filter(Boolean);
  }

  // JS port of the OOS_QUERY aggregation in backfill/sync-daily.mjs: one row per
  // garment SKU (metre SKUs and dyed-fabric/RM codes excluded), 45d metrics + DOH.
  // Descriptive fields are only present (and only sent) on full runs; daily runs
  // send numerics only, so Supabase keeps the existing descriptive values.
  function oosAggregate(raw, full, synced_at) {
    const round1 = (x) => Math.round(x * 10) / 10;
    const anyVal = (cur, v) => (cur !== null && cur !== undefined ? cur : (v === undefined ? null : v));
    const genderCode = (g) => {
      const u = String(g || '').trim().toUpperCase();
      if (['WOMEN', 'FEMALE', 'F'].includes(u)) return 'F';
      if (['MEN', 'MENS', 'MALE', 'M'].includes(u)) return 'M';
      if (['UNISEX', 'U'].includes(u)) return 'U';
      return '';
    };
    const groups = new Map();
    for (const r of raw) {
      if (!r.sku) continue;
      if (String(r.size || '').toUpperCase() === 'IN METERS') continue;
      if (/^[^/]+\/[^/]+\/[^/]+$/.test(r.sku)) continue; // dyed-fabric/RM codes
      let g = groups.get(r.sku);
      if (!g) {
        g = { sku: r.sku, product_status: null, total_oos_days: null, total_qty_sold: null,
              doq_45: null, current_stock: 0, inprocess_stock: 0, sales_value: null };
        if (full) {
          Object.assign(g, { product_code: null, category_with_gender: null, rm_code: null,
            dyed_fabric_sku: null, product_variant: null, product_name: null, color: null,
            size: null, weave_type: null, _categorytype: null, _gender: null });
        }
        groups.set(r.sku, g);
      }
      g.product_status = anyVal(g.product_status, r.product_state);
      if (r.oos_days_45 != null) g.total_oos_days = Math.max(g.total_oos_days ?? -Infinity, r.oos_days_45);
      if (r.total_sales_in_last_45_inventory_days != null) {
        g.total_qty_sold = Math.max(g.total_qty_sold ?? -Infinity, r.total_sales_in_last_45_inventory_days);
      }
      if (r.doq_45 != null) g.doq_45 = Math.max(g.doq_45 ?? -Infinity, r.doq_45);
      // sales_value holds the per-unit Selling Price (Shopify SP) — the UI's
      // "Selling Price" column, feeding Sales Leakage = SP × DOQ × OOS days.
      if (r.shopify_sp != null && r.shopify_sp > 0) {
        g.sales_value = Math.max(g.sales_value ?? -Infinity, r.shopify_sp);
      }
      g.current_stock += r.current_stock || 0;
      g.inprocess_stock += r.total_inprogress || 0;
      if (full) {
        g.product_code = anyVal(g.product_code, String(r.category || '').trim() || null);
        g.rm_code = anyVal(g.rm_code, r.rm_code);
        g.dyed_fabric_sku = anyVal(g.dyed_fabric_sku, r.dyed_fabric_sku);
        g.product_variant = anyVal(g.product_variant, r.product_variant);
        g.product_name = anyVal(g.product_name, r.product_name);
        g.color = anyVal(g.color, r.color);
        g.size = anyVal(g.size, r.size);
        g.weave_type = anyVal(g.weave_type, r.weave_type);
        g._categorytype = anyVal(g._categorytype, String(r.categorytype || '').trim() || null);
        g._gender = anyVal(g._gender, r.gender);
      }
    }
    const rows = [];
    for (const g of groups.values()) {
      const doq = g.doq_45;
      g.doh = doq ? round1(g.current_stock / doq) : null;
      g.doh_with_inprocess = doq ? round1((g.current_stock + g.inprocess_stock) / doq) : null;
      // Availability days (45-day window): these two columns previously had NO
      // writer anywhere in the pipeline — every row sat at NULL/0 (the
      // "Availability days showing 0" bug). oos_days_45 is a calendar-window
      // count (max 45), so available = window minus OOS days.
      g.total_inventory_days = 45;
      g.total_available_days = Math.max(0, 45 - (g.total_oos_days ?? 0));
      if (full) {
        g.category_with_gender = g._categorytype
          ? `${genderCode(g._gender)} ${g._categorytype.toUpperCase()}`.trim() : null;
        delete g._categorytype;
        delete g._gender;
      }
      g.synced_at = synced_at;
      rows.push(g);
    }
    return rows;
  }

  // ---- DOQ Dashboard windows (port of the sheet "DOQ 3-Table Generator") ----
  // Per-SKU aggregates for the dashboard's windows, all from the daily history
  // (the sheet's RAW SALES ~ daily_quantity, Inventory report ~ current_stock):
  //   d1 latest day · l7 last 7 days · w1..w4 last 4 complete Mon-Sun weeks ·
  //   at all time.  Cost note: the table is column-pruned, not date-pruned, so
  //   the all-time window costs the same as the 35-day ones (4 columns read).
  function doqWindows() {
    const startedAt = new Date().toISOString();
    return runTarget('sd_doq_window', () => {
      // 1. distinct dates (small scan: date_day only) -> window boundaries + N days
      const dates = runQuery(
        `SELECT FORMAT_DATE('%Y-%m-%d', date_day) d FROM ${DATASET}saadaa_inventory_planning\` ` +
        `WHERE date_day IS NOT NULL GROUP BY 1 ORDER BY 1`,
      ).map((r) => r.d);
      if (!dates.length) throw new Error('saadaa_inventory_planning has no dates');
      const latest = dates[dates.length - 1];
      const earliest = dates[0];

      const parse = (s) => { const p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); };
      const iso = (d) => Utilities.formatDate(d, 'Asia/Kolkata', 'yyyy-MM-dd');
      const addD = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
      const latestD = parse(latest);
      // last 4 COMPLETE Mon-Sun weeks (w1 most recent), same math as the sheet
      const dow = latestD.getDay();
      const lastSunday = dow === 0 ? latestD : addD(latestD, -((dow + 6) % 7) - 1);
      const windows = {
        d1: { start: latest, end: latest, label: latest },
        l7: { start: iso(addD(latestD, -6)), end: latest, label: iso(addD(latestD, -6)) + ' → ' + latest },
      };
      for (let w = 1; w <= 4; w++) {
        const end = addD(lastSunday, -7 * (w - 1));
        const start = addD(end, -6);
        windows['w' + w] = { start: iso(start), end: iso(end), label: iso(start) + ' → ' + iso(end) };
      }
      windows.at = { start: earliest, end: latest, label: earliest + ' → ' + latest };
      for (const k in windows) {
        windows[k].ndays = dates.filter((d) => d >= windows[k].start && d <= windows[k].end).length;
      }

      // 2. one conditional-aggregation query -> per-SKU window figures
      const cond = (k) => `date_day BETWEEN '${windows[k].start}' AND '${windows[k].end}'`;
      const per = (k) =>
        `SUM(IF(${cond(k)}, qty, 0)) ${k}_qty, ` +
        `COUNTIF(${cond(k)} AND stk > 0) ${k}_avail, ` +
        `COUNTIF(${cond(k)} AND stk <= 0) ${k}_oos`;
      const sql =
        `WITH day AS ( ` +
        `  SELECT sku, date_day, SUM(COALESCE(daily_quantity, 0)) qty, SUM(COALESCE(current_stock, 0)) stk ` +
        `  FROM ${DATASET}saadaa_inventory_planning\` ` +
        `  WHERE sku IS NOT NULL AND UPPER(COALESCE(Size, '')) != 'IN METERS' ` +
        `    AND NOT REGEXP_CONTAINS(sku, r'^[^/]+/[^/]+/[^/]+$') ` +
        `  GROUP BY sku, date_day ` +
        `) SELECT sku, ${['d1', 'l7', 'w1', 'w2', 'w3', 'w4', 'at'].map(per).join(', ')} ` +
        `FROM day GROUP BY sku`;
      const raw = runQuery(sql);

      const synced_at = new Date().toISOString();
      const rows = raw.map((r) => Object.assign({}, r, { synced_at }));
      upsert('sd_doq_window', 'sku', rows);
      upsert('sd_doq_window_meta', 'id', [
        { id: 1, windows: { latest, earliest, windows }, synced_at },
      ]);
      return { synced: rows.length };
    });
  }

  // SKU convention (validated against the sheet): <product_code><2-char colour>_<size>
  //   SDRPTBR_XS -> variant SDRPTBR, product_code SDRPT, size XS  (mirror of backfill-po.mjs)
  function deriveSku(sku) {
    if (!sku) return { product_variant: null, product_code: null, size: null };
    const s = String(sku);
    const m = s.match(/^(.*)_([^_]+)$/);
    const product_variant = m ? m[1] : s;
    const size = m ? m[2] : null;
    const product_code = product_variant.length > 2 ? product_variant.slice(0, -2) : product_variant;
    return { product_variant, product_code, size };
  }

  // Full PO master refresh: EE_purchase_orders (+ po_items) -> sd_po_master_raw.
  // This is the working set the Open PO Tracker (sd_po_dashboard), the vendor
  // in-process load (sd_po_in_process), Inward Plan and Buying Plan actuals all
  // read via sd_po_filtered. Ports backfill/backfill-po.mjs, which previously
  // ran only as a one-off laptop script — so the table had frozen a month out of
  // date, showing the same Approved POs every day and never dropping ones that
  // had since completed. ALL statuses, deduped to the latest airbyte version per
  // line so a PO flipping Approved->Completed drops off the tracker on next sync.
  // Upsert only (never deletes); ~64k lines, a few MB scan, so run it twice daily.
  function poMaster() {
    const sql = `
      SELECT
        i.purchase_order_detail_id AS po_detail_id,
        h.po_id, h.po_number, h.po_ref_num,
        SAFE_CAST(h.po_status_id AS INT64) AS po_status_code,
        h.vendor_code, h.vendor_name, h.po_created_warehouse AS warehouse,
        i.sku, i.product_id, i.product_description,
        SAFE_CAST(i.original_quantity AS NUMERIC) AS original_qty,
        SAFE_CAST(i.pending_quantity  AS NUMERIC) AS pending_qty,
        SAFE_CAST(i.item_price        AS NUMERIC) AS item_price,
        SAFE_CAST(h.total_po_value    AS NUMERIC) AS total_po_value,
        SAFE_CAST(SUBSTR(h.po_created_date,1,10)        AS DATE) AS po_date,
        SAFE_CAST(SUBSTR(h.po_updated_date,1,10)        AS DATE) AS po_updated_date,
        SAFE_CAST(SUBSTR(h.expected_delivery_date,1,10) AS DATE) AS expected_delivery_date
      FROM ${DATASET}EE_purchase_orders\` h
      JOIN ${DATASET}EE_purchase_orders_po_items\` i
        ON i._airbyte_EE_purchase_orders_hashid = h._airbyte_EE_purchase_orders_hashid
      QUALIFY ROW_NUMBER() OVER (
        PARTITION BY i.purchase_order_detail_id ORDER BY i._airbyte_emitted_at DESC) = 1`;
    const ingested_at = new Date().toISOString();
    const seen = new Set();
    const rows = [];
    for (const r of runQuery(sql)) {
      if (r.po_detail_id == null) continue;
      const id = String(r.po_detail_id);
      if (seen.has(id)) continue;
      seen.add(id);
      const d = deriveSku(r.sku == null ? null : String(r.sku));
      const code = r.po_status_code == null ? null : Number(r.po_status_code);
      rows.push({
        po_detail_id: id,
        po_id: r.po_id == null ? null : String(r.po_id),
        po_number: r.po_number == null ? null : String(r.po_number),
        po_ref_num: r.po_ref_num,
        po_status_code: code,
        po_status: code == null ? null : (PO_STATUS[code] || String(code)),
        vendor_code: r.vendor_code, vendor_name: r.vendor_name, warehouse: r.warehouse,
        sku: r.sku, product_id: r.product_id == null ? null : String(r.product_id),
        product_code: d.product_code, product_variant: d.product_variant, size: d.size,
        product_description: r.product_description,
        original_qty: r.original_qty, pending_qty: r.pending_qty,
        item_price: r.item_price, total_po_value: r.total_po_value,
        po_date: r.po_date, po_updated_date: r.po_updated_date,
        expected_delivery_date: r.expected_delivery_date,
        ingested_at,
      });
    }
    upsert('sd_po_master_raw', 'po_detail_id', rows);
    return { synced: rows.length };
  }

  function grn() {
    const sql = `
      SELECT ${GRN_COLS.join(', ')} FROM ${DATASET}saadaa_po_grn_mapping\`
      WHERE grn_created_date >= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 45 DAY)`;
    const synced_at = new Date().toISOString();
    const seen = new Set();
    const rows = [];
    for (const r of runQuery(sql)) {
      if (r.po_detail_id == null) continue;
      const key = `${r.po_detail_id}|${r.grn_id == null ? '' : r.grn_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(Object.assign({ row_key: key, synced_at }, r));
    }
    upsert('sd_po_grn_mapping', 'row_key', rows);
    return { synced: rows.length };
  }

  // Inbound-QC GRN lines, incremental on the _airbyte_emitted_at PARTITION column
  // (mirror of backfill/backfill-grn-qc.mjs — a grn_created_at filter would prune
  // nothing and miss late QC decisions).
  function grnQc() {
    const sql = `
      SELECT
        SAFE_CAST(i.grn_detail_id AS INT64) AS grn_detail_id,
        SAFE_CAST(h.grn_id AS INT64) AS grn_id,
        SUBSTR(h.grn_created_at, 1, 10) AS grn_created_at,
        SUBSTR(h.grn_invoice_date, 1, 10) AS grn_invoice_date,
        SAFE_CAST(h.po_id AS INT64) AS po_id,
        SAFE_CAST(h.po_number AS INT64) AS po_number,
        h.po_ref_num, h.vendor_name,
        SAFE_CAST(h.vendor_c_id AS INT64) AS vendor_c_id,
        SAFE_CAST(i.purchase_order_detail_id AS INT64) AS purchase_order_detail_id,
        SAFE_CAST(i.product_id AS INT64) AS product_id,
        i.sku, i.original_quantity, i.received_quantity,
        i.qc_pass, i.qc_fail, i.qc_pending, i.damaged, i.return_to_source, i.discard, i.lost
      FROM ${DATASET}EE_grn_details\` h
      JOIN ${DATASET}EE_grn_details_grn_items\` i
        ON i._airbyte_EE_grn_details_hashid = h._airbyte_EE_grn_details_hashid
      WHERE i.grn_detail_id IS NOT NULL
        AND DATE(i._airbyte_emitted_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
      QUALIFY ROW_NUMBER() OVER (PARTITION BY SAFE_CAST(i.grn_detail_id AS INT64) ORDER BY h.grn_created_at DESC) = 1`;
    const rows = runQuery(sql).filter((r) => r.grn_detail_id != null);
    upsert('sd_ee_grn', 'grn_detail_id', rows);
    supa('post', 'rpc/refresh_vendor_recommendation', {});
    return { synced: rows.length };
  }

  // Candidate column names for EasyEcom's vendor active/inactive status, in
  // priority order — the first one present in Easyecom_Saadaa_vendors is read
  // into vendor_master_data.ee_status. If none match, the sync falls back to
  // names-only (its original behaviour) and logs it, so it can never break.
  // Run bqVendorSchema() to see the real columns and adjust this list if needed.
  const VENDOR_STATUS_CANDIDATES = ['status', 'vendor_status', 'active', 'is_active', 'account_status'];

  function vendorStatusColumn() {
    const cols = runQuery(`
      SELECT column_name FROM ${DATASET}INFORMATION_SCHEMA.COLUMNS\`
      WHERE table_name = 'Easyecom_Saadaa_vendors'`).map((r) => String(r.column_name).toLowerCase());
    const present = new Set(cols);
    return VENDOR_STATUS_CANDIDATES.find((c) => present.has(c)) || null;
  }

  // HYBRID vendor master: GCP owns vendor_name (and now ee_status); the sheet
  // still owns the capacity model. Updates EXISTING vendors only, never inserts.
  function vendors() {
    const statusCol = vendorStatusColumn();
    const select = statusCol
      ? `vendor_code, vendor_name, CAST(${statusCol} AS STRING) AS ee_status`
      : 'vendor_code, vendor_name';
    const gcp = runQuery(`
      SELECT DISTINCT ${select} FROM ${DATASET}Easyecom_Saadaa_vendors\`
      WHERE vendor_code IS NOT NULL AND TRIM(vendor_name) != ''`);
    const existing = JSON.parse(
      supa('get', 'vendor_master_data?select=vendor_code').getContentText(),
    );
    const codes = new Set(existing.map((r) => r.vendor_code));
    // Collapse to one row per vendor_code (DISTINCT + a status column can yield
    // duplicates, and a batch upsert can't touch the same conflict key twice).
    // Prefer a row that actually carries a status value.
    const byCode = new Map();
    for (const r of gcp) {
      if (!codes.has(r.vendor_code)) continue;
      const prev = byCode.get(r.vendor_code);
      if (!prev || (prev.ee_status == null && r.ee_status != null)) byCode.set(r.vendor_code, r);
    }
    const updates = [...byCode.values()].map((r) => {
      const row = { vendor_code: r.vendor_code, vendor_name: String(r.vendor_name).trim() };
      if (statusCol) row.ee_status = r.ee_status == null ? null : String(r.ee_status).trim();
      return row;
    });
    upsert('vendor_master_data', 'vendor_code', updates);
    console.log(`[vendor_master_data] status column: ${statusCol || 'none found — synced names only'}`);
    return { synced: updates.length };
  }

  function vendorsOnce() { return runTarget('vendor_master_data', vendors); }

  // Diagnostics: dump the source vendor table's schema + a few rows so the exact
  // status column and its encoding (1/0, active/inactive, …) can be confirmed.
  function vendorSchema() {
    const cols = runQuery(`
      SELECT column_name, data_type FROM ${DATASET}INFORMATION_SCHEMA.COLUMNS\`
      WHERE table_name = 'Easyecom_Saadaa_vendors' ORDER BY ordinal_position`);
    console.log('Easyecom_Saadaa_vendors columns:\n' +
      cols.map((c) => `  ${c.column_name} (${c.data_type})`).join('\n'));
    console.log(`Detected status column: ${vendorStatusColumn() || 'none'}`);
    const sample = runQuery(`SELECT * FROM ${DATASET}Easyecom_Saadaa_vendors\` LIMIT 5`);
    console.log('Sample rows:\n' + JSON.stringify(sample, null, 2));
    return { columns: cols.length, detected: vendorStatusColumn() };
  }

  // Small snapshot tables with no natural key: replace all rows (delete + insert),
  // same as the PO Manual Adjustment tab's Refresh button.
  function adjustments() {
    const manual = runQuery(`
      SELECT po_no, sku_code, manual_adjust_qty, po_type,
             CAST(ingestion_date AS STRING) AS ingestion_date, ingestion_by
      FROM ${DATASET}po_qty_manual_adjustment\` ORDER BY ingestion_date DESC`);
    const cutting = runQuery(`
      SELECT CAST(date_of_cutting AS STRING) AS date_of_cutting, vendor_code, po_number,
             fabric_sku_code, item_code, cutting_qty, avg_fabric_consumption_approved,
             width_of_fabric, cutting_approval_sheet, remarks_of_cutting, fabric_consumed,
             type_of_po, CAST(date_of_ingestion AS STRING) AS date_of_ingestion, ingestion_by
      FROM ${DATASET}po_qty_cutting_register\` ORDER BY date_of_ingestion DESC`);
    supa('delete', 'sd_po_qty_manual_adjustment?synced_at=gte.1970-01-01T00:00:00Z');
    for (let i = 0; i < manual.length; i += BATCH) supa('post', 'sd_po_qty_manual_adjustment', manual.slice(i, i + BATCH));
    supa('delete', 'sd_po_qty_cutting_register?synced_at=gte.1970-01-01T00:00:00Z');
    for (let i = 0; i < cutting.length; i += BATCH) supa('post', 'sd_po_qty_cutting_register', cutting.slice(i, i + BATCH));
    return { synced: manual.length + cutting.length, deleted: manual.length + cutting.length };
  }

  // EasyEcom vendor master — RAW landing, exactly as EasyEcom/BigQuery holds it (no
  // transformation, no added business columns). Separate from the hybrid
  // vendor_master_data (which keeps the Sheet-owned capacity model). Full refresh:
  // replace all rows each run so sd_ee_vendor_master mirrors the source, same
  // delete+insert pattern as adjustments(). SELECT * lands whatever columns exist;
  // sd_ee_vendor_master's columns match runQuery()'s lowercased field names.
  // Full vendor record — EVERY EasyEcom field, not just the 9 Airbyte normalized
  // into `Easyecom_Saadaa_vendors`. The rest (contact person, phone, PAN, GSTIN,
  // MSME, DL, FSSAI, prep/transit days, tokens) live only in the raw _airbyte_data
  // JSON, so read that and JSON_VALUE every field. Deduped to the latest emission
  // per vendor. Column names match sd_ee_vendor_master. address stays a JSON blob.
  function eeVendorMaster() {
    const rows = runQuery(`
      WITH latest AS (
        SELECT _airbyte_data,
          ROW_NUMBER() OVER (PARTITION BY JSON_VALUE(_airbyte_data, '$.vendor_c_id')
                             ORDER BY _airbyte_emitted_at DESC) AS rn
        FROM ${DATASET}_airbyte_raw_Easyecom_Saadaa_vendors\`
      )
      SELECT
        JSON_VALUE(_airbyte_data, '$.vendor_code')                AS vendor_code,
        JSON_VALUE(_airbyte_data, '$.vendor_name')                AS vendor_name,
        JSON_VALUE(_airbyte_data, '$.active')                     AS active,
        JSON_VALUE(_airbyte_data, '$.email')                      AS email,
        JSON_QUERY(_airbyte_data, '$.address')                    AS address,
        JSON_VALUE(_airbyte_data, '$.paymentTerm')                AS paymentterm,
        JSON_VALUE(_airbyte_data, '$.deliveryTerm')               AS deliveryterm,
        JSON_VALUE(_airbyte_data, '$.currency_code')              AS currency_code,
        JSON_VALUE(_airbyte_data, '$.vendor_c_id')                AS vendor_c_id,
        JSON_VALUE(_airbyte_data, '$.firstname')                  AS firstname,
        JSON_VALUE(_airbyte_data, '$.lastname')                   AS lastname,
        JSON_VALUE(_airbyte_data, '$.contact_number')             AS contact_number,
        JSON_VALUE(_airbyte_data, '$.pan')                        AS pan,
        JSON_VALUE(_airbyte_data, '$.tax_identification_number')  AS tax_identification_number,
        JSON_VALUE(_airbyte_data, '$.msme_number')                AS msme_number,
        JSON_VALUE(_airbyte_data, '$.unregisteredVendor')         AS unregistered_vendor,
        JSON_VALUE(_airbyte_data, '$.vendor_token')               AS vendor_token,
        JSON_VALUE(_airbyte_data, '$.api_token')                  AS api_token,
        JSON_VALUE(_airbyte_data, '$.dl_number')                  AS dl_number,
        JSON_VALUE(_airbyte_data, '$.dl_expiry')                  AS dl_expiry,
        JSON_VALUE(_airbyte_data, '$.fssai_number')               AS fssai_number,
        JSON_VALUE(_airbyte_data, '$.fssai_expiry')               AS fssai_expiry,
        JSON_VALUE(_airbyte_data, '$.freight_forwarding_days')    AS freight_forwarding_days,
        JSON_VALUE(_airbyte_data, '$.prep_days')                  AS prep_days,
        JSON_VALUE(_airbyte_data, '$.shipment_Intransit_days')    AS shipment_intransit_days,
        JSON_VALUE(_airbyte_data, '$.warehouse_checkin_time')     AS warehouse_checkin_time
      FROM latest WHERE rn = 1 AND JSON_VALUE(_airbyte_data, '$.vendor_code') IS NOT NULL`);
    const synced_at = new Date().toISOString();
    for (const r of rows) r.synced_at = synced_at;
    supa('delete', 'sd_ee_vendor_master?synced_at=gte.1970-01-01T00:00:00Z');
    for (let i = 0; i < rows.length; i += BATCH) supa('post', 'sd_ee_vendor_master', rows.slice(i, i + BATCH));
    return { synced: rows.length, deleted: rows.length };
  }

  // ---------------- Trigger bodies ----------------

  function throwIfErrors(errors) {
    const real = errors.filter(Boolean);
    // Rethrow so Apps Script sends the owner a failure notification email.
    if (real.length) throw new Error(`${real.length} sync target(s) failed: ${real.map((e) => e.message).join(' | ')}`);
  }

  function morningA() {
    const errors = [runTarget('sd_ee_product_master', productMaster)];
    const isSunday = new Date().getDay() === 0; // script TZ = Asia/Kolkata
    errors.push(...doqOos(isSunday));
    errors.push(doqWindows());   // DOQ Dashboard window aggregates
    throwIfErrors(errors);
  }

  // Create sd_po_closure rows for POs that just turned Completed, so the closure
  // SLA clock starts near the actual EasyCom completion (not whenever someone next
  // opens the PO Closure screen). Runs after sd_po_master_raw is refreshed above.
  // Non-fatal: a closure-sync hiccup must never fail the PO sync.
  function syncPoClosures_() {
    try { supa('post', 'rpc/sd_sync_po_closures', {}); }
    catch (e) { console.log('po-closure sync skipped: ' + e); }
  }

  function morningB() {
    throwIfErrors([
      runTarget('sd_po_master_raw', poMaster),
      runTarget('sd_po_grn_mapping', grn),
      runTarget('sd_ee_grn', grnQc),
      runTarget('vendor_master_data', vendors),
      runTarget('sd_ee_vendor_master', eeVendorMaster),
      runTarget('sd_po_qty_manual_adjustment', adjustments),
    ]);
    syncPoClosures_();
  }

  function evening() {
    throwIfErrors([
      runTarget('sd_po_master_raw', poMaster),
      runTarget('sd_po_grn_mapping', grn),
    ]);
    syncPoClosures_();
  }

  function install() {
    const HANDLERS = ['bqSyncMorningA', 'bqSyncMorningB', 'bqSyncEvening'];
    for (const t of ScriptApp.getProjectTriggers()) {
      if (HANDLERS.includes(t.getHandlerFunction())) ScriptApp.deleteTrigger(t);
    }
    ScriptApp.newTrigger('bqSyncMorningA').timeBased().everyDays(1).atHour(6).create();
    ScriptApp.newTrigger('bqSyncMorningB').timeBased().everyDays(1).atHour(6).create();
    ScriptApp.newTrigger('bqSyncEvening').timeBased().everyDays(1).atHour(18).create();
    console.log('BqSync triggers installed: morningA + morningB (~6 AM), evening (~6 PM), script timezone.');
  }

  return { morningA, morningB, evening, install, doqOos, doqWindows, vendorsOnce, vendorSchema, eeVendorMaster };
})();
