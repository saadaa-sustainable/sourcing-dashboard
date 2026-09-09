/**
 * SAADAA Cutting Register -> BigQuery push (companion to BqSync.gs / Code.gs).
 *
 * The team enters cutting-register data on the Sourcing Dashboard (Supabase table
 * sd_cutting_register). This script pushes those rows into the warehouse table
 * saadaa-wh.MAPLEMONK.po_qty_cutting_register — running as the INSTALLING USER
 * (pushpendra), who already has BigQuery access, so NO service-account key is needed
 * anywhere (the dashboard has no GCP creds).
 *
 * Two ways it runs, both idempotent (a row is pushed only while bq_synced_at IS NULL,
 * stamped on success; a deterministic insertId dedups streaming retries):
 *   • doPost(e)  — IMMEDIATE. The dashboard POSTs {secret, id} right after a save; this
 *                  pushes that one row in real time. (Web App URL, "Execute as: me".)
 *   • cuttingReconcile() — BATCH. A time trigger sweeps every not-yet-synced row, so the
 *                  public /fill-link submissions and any failed immediate call are caught up.
 *
 * Reuses the Script Properties BqSync/Code already set: SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY. Add one more: CUTTING_PUSH_SECRET (any long random string;
 * the same value goes in Vercel as APPS_SCRIPT_CUTTING_SECRET).
 *
 * ONE-TIME SETUP:
 *   1. Paste this file into the Apps Script project that runs Code.gs / BqSync.gs.
 *   2. Editor -> Services (+) -> add "BigQuery API" (BqSync.gs already needs it).
 *   3. Project Settings -> Script Properties -> add CUTTING_PUSH_SECRET = <random string>.
 *   4. Deploy -> New deployment -> type "Web app", Execute as "Me", Who has access
 *      "Anyone". Copy the /exec URL -> set it in Vercel as APPS_SCRIPT_CUTTING_URL,
 *      and set APPS_SCRIPT_CUTTING_SECRET to the same value as step 3. Redeploy Vercel.
 *   5. Run installCuttingPushTrigger() once (installs the twice-daily reconcile) and grant
 *      the OAuth consent. Optional first fill: run cuttingReconcile() manually.
 *
 * Requires the installing user to have BigQuery *write* (Data Editor / tables.updateData)
 * on the MAPLEMONK dataset. If a push fails with a permission error it's logged and the
 * row stays bq_synced_at NULL (retried), so nothing is lost — grant the role and re-run.
 */

// ---- Entry points (globals) ----
function doPost(e) { return CuttingPush_.doPost(e); }
function cuttingReconcile() { return CuttingPush_.reconcile(); }
function installCuttingPushTrigger() { return CuttingPush_.install(); }
// Manual: push a single row id now (testing).
function cuttingPushOne(id) { return CuttingPush_.pushByIds([id]); }

const CuttingPush_ = (function () {
  const PROJECT = 'saadaa-wh';
  const LOCATION = 'asia-south1';
  const DATASET = 'MAPLEMONK';
  const TABLE = 'po_qty_cutting_register';
  const SELECT =
    'id,po_ref_num,product_code,bom_standard_qty,actual_consumption_qty,' +
    'cutting_date,remarks,submitted_by_email,submitted_by_name,created_at';

  // ---- Supabase (reuse BqSync/Code script properties) ----
  function conf_() {
    const p = PropertiesService.getScriptProperties();
    const url = p.getProperty('SUPABASE_URL');
    const key = p.getProperty('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY script property');
    return { url: url, key: key };
  }
  function supaGet_(path) {
    const c = conf_();
    const res = UrlFetchApp.fetch(c.url + '/rest/v1/' + path, {
      method: 'get',
      headers: { apikey: c.key, Authorization: 'Bearer ' + c.key },
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() >= 300) throw new Error('Supabase GET ' + path + ' -> ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
    return JSON.parse(res.getContentText() || '[]');
  }
  function supaPatch_(path, body) {
    const c = conf_();
    const res = UrlFetchApp.fetch(c.url + '/rest/v1/' + path, {
      method: 'patch',
      contentType: 'application/json',
      headers: { apikey: c.key, Authorization: 'Bearer ' + c.key, Prefer: 'return=minimal' },
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() >= 300) throw new Error('Supabase PATCH ' + path + ' -> ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  }

  // ---- Mapping (mirror of src/lib/cutting-bq.ts) ----
  // po_ref_num = FY.../<TYPE>/<PRODUCT>/<VENDOR>-<SEQ>
  function parsePoRef_(po) {
    const parts = String(po || '').split('/');
    const type = (parts[1] || '').trim() || null;
    const vseq = (parts[3] || '').trim();
    const vendor = vseq ? (vseq.split('-')[0] || '').trim() || null : null;
    return { type: type, vendor: vendor };
  }

  // Warehouse-table column types, read once so date/numeric values coerce correctly.
  let typeMap_ = null;
  function typeMap_get_() {
    if (typeMap_) return typeMap_;
    const meta = BigQuery.Tables.get(PROJECT, DATASET, TABLE);
    typeMap_ = {};
    const fields = (meta.schema && meta.schema.fields) || [];
    for (let i = 0; i < fields.length; i++) typeMap_[fields[i].name.toLowerCase()] = String(fields[i].type).toUpperCase();
    return typeMap_;
  }
  function coerce_(value, type) {
    if (value === null || value === undefined || value === '') return null;
    switch (type) {
      case 'DATE': return String(value).slice(0, 10);
      case 'TIMESTAMP': return String(value); // ISO string is accepted by streaming insert
      case 'DATETIME': return String(value).replace('T', ' ').replace('Z', '').slice(0, 19);
      case 'INTEGER': case 'INT64': case 'FLOAT': case 'FLOAT64':
      case 'NUMERIC': case 'BIGNUMERIC': return Number(value);
      default: return String(value);
    }
  }
  function toWarehouse_(r) {
    const p = parsePoRef_(r.po_ref_num);
    return {
      date_of_cutting: r.cutting_date,
      vendor_code: p.vendor,
      po_number: r.po_ref_num,
      fabric_sku_code: null,
      item_code: r.product_code,
      cutting_qty: null,
      avg_fabric_consumption_approved: r.bom_standard_qty,
      width_of_fabric: null,
      cutting_approval_sheet: null,
      remarks_of_cutting: r.remarks,
      fabric_consumed: r.actual_consumption_qty,
      type_of_po: p.type,
      date_of_ingestion: r.created_at,
      ingestion_by: r.submitted_by_email || r.submitted_by_name || 'sourcing-dashboard',
    };
  }

  // ---- BigQuery streaming insert ----
  function insertRows_(rows) {
    if (!rows.length) return 0;
    const types = typeMap_get_();
    const bqRows = rows.map(function (r) {
      const mapped = toWarehouse_(r);
      const json = {};
      for (const k in mapped) json[k] = coerce_(mapped[k], types[k.toLowerCase()] || 'STRING');
      return { insertId: 'sd_cutting_register:' + r.id, json: json };
    });
    const resp = BigQuery.Tabledata.insertAll(
      { rows: bqRows, skipInvalidRows: false, ignoreUnknownValues: false },
      PROJECT, DATASET, TABLE,
    );
    if (resp && resp.insertErrors && resp.insertErrors.length) {
      throw new Error('BigQuery insert errors: ' + JSON.stringify(resp.insertErrors).slice(0, 500));
    }
    return rows.length;
  }

  // Push specific ids (or, if empty, every not-yet-synced row), then stamp bq_synced_at.
  function pushByIds(ids) {
    let rows;
    if (ids && ids.length) {
      const list = ids.map(function (n) { return Number(n); }).filter(function (n) { return !isNaN(n); });
      if (!list.length) return 0;
      rows = supaGet_('sd_cutting_register?select=' + SELECT + '&bq_synced_at=is.null&id=in.(' + list.join(',') + ')');
    } else {
      rows = supaGet_('sd_cutting_register?select=' + SELECT + '&bq_synced_at=is.null&order=id.asc&limit=5000');
    }
    if (!rows.length) return 0;
    insertRows_(rows);
    const doneIds = rows.map(function (r) { return r.id; });
    supaPatch_('sd_cutting_register?id=in.(' + doneIds.join(',') + ')', { bq_synced_at: new Date().toISOString() });
    return rows.length;
  }

  function reconcile() {
    const startedAt = new Date().toISOString();
    try {
      const n = pushByIds([]);
      console.log('[cutting-push] reconcile ok: ' + n + ' rows');
      return { synced: n };
    } catch (e) {
      console.error('[cutting-push] reconcile FAILED: ' + (e && e.message ? e.message : e));
      throw e; // so Apps Script emails the owner on failure
    }
  }

  function json_(obj) {
    return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
  }

  function doPost(e) {
    try {
      const body = e && e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {};
      const secret = PropertiesService.getScriptProperties().getProperty('CUTTING_PUSH_SECRET');
      if (!secret || body.secret !== secret) return json_({ ok: false, error: 'unauthorized' });
      const ids = body.ids || (body.id !== undefined && body.id !== null ? [body.id] : []);
      const n = pushByIds(ids);
      return json_({ ok: true, pushed: n });
    } catch (err) {
      console.error('[cutting-push] doPost error: ' + (err && err.message ? err.message : err));
      return json_({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }

  function install() {
    for (const t of ScriptApp.getProjectTriggers()) {
      if (t.getHandlerFunction() === 'cuttingReconcile') ScriptApp.deleteTrigger(t);
    }
    ScriptApp.newTrigger('cuttingReconcile').timeBased().everyDays(1).atHour(6).create();
    ScriptApp.newTrigger('cuttingReconcile').timeBased().everyDays(1).atHour(18).create();
    console.log('cuttingReconcile triggers installed (~6 AM and ~6 PM, script timezone).');
  }

  return { doPost: doPost, reconcile: reconcile, install: install, pushByIds: pushByIds };
})();
