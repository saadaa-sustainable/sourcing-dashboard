/**
 * SAADAA Manual Adjustment (PO) -> BigQuery push (companion to CuttingPush.gs / BqSync.gs).
 *
 * The team now enters PO manual adjustments on the Sourcing Dashboard (Supabase table
 * sd_manual_adjustment_entry) instead of the old ingestion portal. This script pushes those
 * rows into the warehouse table saadaa-wh.MAPLEMONK.po_qty_manual_adjustment — running as
 * the INSTALLING USER, who already has BigQuery access, so NO service-account key is needed
 * anywhere (the dashboard has no GCP creds).
 *
 * Identical mechanics to CuttingPush.gs (idempotent: a row is pushed only while
 * bq_synced_at IS NULL, stamped on success; a deterministic insertId dedups retries):
 *   • adjustReconcile() — PRIMARY. A time trigger every 5 minutes sweeps every not-yet-synced
 *                  row and pushes it, so entries reach BigQuery within ~5 min.
 *   • doPost(e)  — OPTIONAL real-time route (dashboard POSTs {secret, ids}). The saadaa.in
 *                  Workspace blocks anonymous web-app access today, so the trigger is what runs.
 *
 * Reuses the Script Properties BqSync/Code already set: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 * ADJUST_PUSH_SECRET is only needed for the (optional) web app.
 *
 * ONE-TIME SETUP (trigger route — no web app / no Vercel env needed):
 *   1. Paste this file into the Apps Script project that runs Code.gs / BqSync.gs / CuttingPush.gs.
 *   2. Editor -> Services (+) -> confirm "BigQuery" is present.
 *   3. Run installAdjustPushTrigger() once and grant the OAuth consent (installs the
 *      every-5-minute reconcile). Optional first fill: run adjustReconcile() manually.
 *   Optional web app: Deploy -> "Web app", Execute as "Me", access "Anyone"; add
 *   ADJUST_PUSH_SECRET script property; set APPS_SCRIPT_ADJUST_URL + _SECRET in Vercel.
 *
 * Requires the installing user to have BigQuery *write* (Data Editor / tables.updateData) on
 * the MAPLEMONK dataset — the same grant CuttingPush.gs needs. A permission failure is logged
 * and the row stays bq_synced_at NULL (retried), so nothing is lost.
 */

// ---- Entry points (globals). NOTE: if CuttingPush.gs is in the SAME project it already defines
// doPost — only ONE doPost can exist per project. Keep this web-app entry commented out unless
// this script is deployed as its own project; the trigger route below needs no doPost.
// function doPost(e) { return AdjustPush_.doPost(e); }
function adjustReconcile() { return AdjustPush_.reconcile(); }
function installAdjustPushTrigger() { return AdjustPush_.install(); }
// Manual: push specific row ids now (testing), e.g. adjustPushIds([12, 13]).
function adjustPushIds(ids) { return AdjustPush_.pushByIds(ids); }

const AdjustPush_ = (function () {
  const PROJECT = 'saadaa-wh';
  const DATASET = 'MAPLEMONK';
  const TABLE = 'po_qty_manual_adjustment';
  const SOURCE = 'sd_manual_adjustment_entry';
  const SELECT = 'id,po_ref_num,sku_code,manual_adjust_qty,po_type,submitted_by_email,created_at';

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

  // ---- Mapping (mirror of src/lib/manual-adjustment-bq.ts) ----
  // po_ref_num = FY.../<TYPE>/<PRODUCT>/<VENDOR>-<SEQ>; PO type is the 2nd segment.
  function poTypeFromRef_(po) {
    const t = (String(po || '').split('/')[1] || '').trim().toUpperCase();
    return t || null;
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
    return {
      po_no: r.po_ref_num,
      sku_code: r.sku_code,
      manual_adjust_qty: r.manual_adjust_qty,
      po_type: r.po_type || poTypeFromRef_(r.po_ref_num),
      ingestion_date: r.created_at,
      ingestion_by: r.submitted_by_email || 'sourcing-dashboard',
    };
  }

  // ---- BigQuery streaming insert (payload filtered to the live warehouse schema) ----
  function insertRows_(rows) {
    if (!rows.length) return 0;
    const types = typeMap_get_();
    const bqRows = rows.map(function (r) {
      const mapped = toWarehouse_(r);
      const json = {};
      for (const k in mapped) {
        const t = types[k.toLowerCase()];
        if (!t) continue; // column not in the warehouse table — skip
        json[k] = coerce_(mapped[k], t);
      }
      return { insertId: SOURCE + ':' + r.id, json: json };
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
      rows = supaGet_(SOURCE + '?select=' + SELECT + '&bq_synced_at=is.null&id=in.(' + list.join(',') + ')');
    } else {
      rows = supaGet_(SOURCE + '?select=' + SELECT + '&bq_synced_at=is.null&order=id.asc&limit=5000');
    }
    if (!rows.length) return 0;
    insertRows_(rows);
    const doneIds = rows.map(function (r) { return r.id; });
    supaPatch_(SOURCE + '?id=in.(' + doneIds.join(',') + ')', { bq_synced_at: new Date().toISOString() });
    return rows.length;
  }

  function reconcile() {
    try {
      const n = pushByIds([]);
      console.log('[adjust-push] reconcile ok: ' + n + ' rows');
      return { synced: n };
    } catch (e) {
      console.error('[adjust-push] reconcile FAILED: ' + (e && e.message ? e.message : e));
      throw e; // so Apps Script emails the owner on failure
    }
  }

  function json_(obj) {
    return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
  }

  function doPost(e) {
    try {
      const body = e && e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {};
      const secret = PropertiesService.getScriptProperties().getProperty('ADJUST_PUSH_SECRET');
      if (!secret || body.secret !== secret) return json_({ ok: false, error: 'unauthorized' });
      const ids = body.ids || (body.id !== undefined && body.id !== null ? [body.id] : []);
      const n = pushByIds(ids);
      return json_({ ok: true, pushed: n });
    } catch (err) {
      console.error('[adjust-push] doPost error: ' + (err && err.message ? err.message : err));
      return json_({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }

  function install() {
    for (const t of ScriptApp.getProjectTriggers()) {
      if (t.getHandlerFunction() === 'adjustReconcile') ScriptApp.deleteTrigger(t);
    }
    // Every 5 minutes: the PRIMARY push mechanism (mirrors cuttingReconcile). Reads only rows
    // with bq_synced_at IS NULL — usually zero — so it is cheap; entries land within ~5 minutes.
    ScriptApp.newTrigger('adjustReconcile').timeBased().everyMinutes(5).create();
    console.log('adjustReconcile trigger installed: every 5 minutes.');
  }

  return { doPost: doPost, reconcile: reconcile, install: install, pushByIds: pushByIds };
})();
