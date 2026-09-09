/**
 * SAADAA Cutting Register -> BigQuery push (companion to BqSync.gs / Code.gs).
 *
 * The team enters cutting-register data on the Sourcing Dashboard (Supabase table
 * sd_cutting_register). This script pushes those rows into the warehouse table
 * saadaa-wh.MAPLEMONK.po_qty_cutting_register — running as the INSTALLING USER
 * (pushpendra), who already has BigQuery access, so NO service-account key is needed
 * anywhere (the dashboard has no GCP creds).
 *
 * How it runs (idempotent: a row is pushed only while bq_synced_at IS NULL, stamped on
 * success; a deterministic insertId dedups streaming retries):
 *   • cuttingReconcile() — PRIMARY. A time trigger every 5 minutes sweeps every not-yet-synced
 *                  row (dashboard saves + public /fill-link submissions) and pushes them, so
 *                  entries reach BigQuery within ~5 min. No external call needed.
 *   • doPost(e)  — OPTIONAL, only if anonymous web apps are allowed. The dashboard POSTs
 *                  {secret, id} for a true real-time push. NOTE: the saadaa.in Workspace blocks
 *                  anonymous web-app access, so this route currently can't be reached — the
 *                  5-minute trigger is what actually runs. Kept in case the policy changes.
 *
 * Reuses the Script Properties BqSync/Code already set: SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY. CUTTING_PUSH_SECRET is only needed for the (optional) web app.
 *
 * ONE-TIME SETUP (trigger route — no web app / no Vercel env needed):
 *   1. Paste this file into the Apps Script project that runs Code.gs / BqSync.gs.
 *   2. Editor -> Services (+) -> confirm "BigQuery" is present (BqSync.gs already needs it).
 *   3. Run installCuttingPushTrigger() once and grant the OAuth consent (installs the
 *      every-5-minute reconcile). Optional first fill: run cuttingReconcile() manually.
 *   (Because the dashboard doesn't call the web app in this mode, leave APPS_SCRIPT_CUTTING_URL
 *    UNSET in Vercel so it doesn't make pointless calls. The web-app steps below are only
 *    relevant if your Workspace ever allows anonymous access.)
 *   Optional web app: Deploy -> New deployment -> "Web app", Execute as "Me", access "Anyone";
 *   add CUTTING_PUSH_SECRET script property; set APPS_SCRIPT_CUTTING_URL + _SECRET in Vercel.
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
    // Every 5 minutes: this is the PRIMARY push mechanism (the saadaa.in Workspace blocks
    // anonymous web-app access, so the doPost/immediate HTTP route can't be reached from the
    // dashboard). A run reads only the rows with bq_synced_at IS NULL — usually zero — so it's
    // cheap; entries reach BigQuery within ~5 minutes. Change to everyMinutes(1) for tighter
    // latency, or everyMinutes(10/15/30) to run less often.
    ScriptApp.newTrigger('cuttingReconcile').timeBased().everyMinutes(5).create();
    console.log('cuttingReconcile trigger installed: every 5 minutes.');
  }

  return { doPost: doPost, reconcile: reconcile, install: install, pushByIds: pushByIds };
})();
