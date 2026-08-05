/**
 * SAADAA — Discontinued Products inventory → Supabase sync (STANDALONE).
 *
 * Bind this to the "Discontinued Products - Available inventory view"
 * spreadsheet (a DIFFERENT spreadsheet from the sourcing/TNA one). It mirrors
 * the one tab into Supabase table `public.discontinued_inventory`, which the
 * dashboard's /discontinued-inventory page reads.
 *
 * It is self-contained and namespaced (SbDisc_) so it will not collide with the
 * main sourcing sync script (SbSync_) if both ever live in the same project.
 *
 * ── ONE-TIME SETUP ──────────────────────────────────────────────────────────
 * 1. Open the spreadsheet → Extensions → Apps Script.
 * 2. Paste this whole file into a script file (e.g. Code.gs) and Save.
 * 3. Project Settings → Script Properties, add:
 *      SUPABASE_URL              = https://jwqqifojsqcdrlquzwqr.supabase.co
 *      SUPABASE_SERVICE_ROLE_KEY = <the service_role secret from Supabase>
 *    (Never commit this key or expose it client-side.)
 * 4. Run `logDiscontinuedHeaders()` once and check the tab name / column keys
 *    in View → Logs. If your tab is named differently, edit SHEET_NAME below.
 * 5. Run `syncDiscontinued()` once (grant the auth prompt) — confirm rows land
 *    in Supabase and the dashboard.
 * 6. Run `installDiscontinuedTriggers()` once to arm the 5-minute + on-edit sync.
 * ────────────────────────────────────────────────────────────────────────────
 */

// ---- Global entry points (unique names; won't clash with the main script) ----
function syncDiscontinued() { return SbDisc_.syncAll(); }
function onEditDiscontinued(e) { return SbDisc_.onEdit(e); }
function installDiscontinuedTriggers() { return SbDisc_.install(); }
// Debug: log the tab's normalized header keys (View → Logs).
function logDiscontinuedHeaders() { return SbDisc_.logHeaders(); }
// Debug: log raw per-column values for the first few data rows.
function logDiscontinuedRaw(n) { return SbDisc_.logRaw(n || 3); }

const SbDisc_ = (function () {
  // If the tab is renamed, change this one string (must match exactly).
  const SHEET_NAME = 'Discontinued Products - Available inventory view';

  const CONFIG = {
    sheet: SHEET_NAME,
    table: 'discontinued_inventory',
    headerRow: 1,
    conflict: 'source_row_key',
    map: mapDiscontinuedRow,
  };

  function syncAll() { syncSheet(CONFIG); }

  function onEdit(e) {
    if (!e || !e.range) return;
    if (e.range.getSheet().getName() === CONFIG.sheet) syncSheet(CONFIG);
  }

  function install() {
    const spreadsheet = SpreadsheetApp.getActive();
    ScriptApp.getProjectTriggers().forEach((trigger) => {
      if (['syncDiscontinued', 'onEditDiscontinued'].includes(trigger.getHandlerFunction())) {
        ScriptApp.deleteTrigger(trigger);
      }
    });
    ScriptApp.newTrigger('syncDiscontinued').timeBased().everyMinutes(5).create();
    ScriptApp.newTrigger('onEditDiscontinued').forSpreadsheet(spreadsheet).onEdit().create();
  }

  // One row per physical unit (serial). Rows with no inventory carry a blank
  // serial, so they key on the SKU instead. Ageing (days_in_warehouse) is taken
  // as-is from the sheet; the dashboard does not recompute it.
  function mapDiscontinuedRow(row) {
    const sku = text(row.sku);
    const serial = text(row.serial_number);
    if (!sku && !serial) return null;
    return {
      source_row_key: serial || ('sku:' + sku),
      sku: sku,
      category: text(row.category),
      sub_category: text(row.sub_category),
      product_name: text(row.product_name),
      color: text(row.color),
      size: text(row.size),
      mrp: number(row.mrp),
      cost: number(row.cost),
      product_launch_date: date(row.product_launch_date),
      product_state: text(row.product_state),
      available_inventory: number(row.available_inventory),
      inventory_status: text(row.inventory_status),
      status: text(row.status),
      serial_number: serial,
      inward_date: date(row.inward_date),
      days_in_warehouse: integerOrNull(row.days_in_warehouse),
    };
  }

  function syncSheet(config) {
    const sheet = SpreadsheetApp.getActive().getSheetByName(config.sheet);
    if (!sheet) { Logger.log('Skipping (tab not found): ' + config.sheet); return; }

    const startedAt = new Date();
    const token = Utilities.getUuid();
    let rowsSynced = 0;
    let rowsDeleted = 0;
    try {
      const values = sheet.getDataRange().getDisplayValues();
      const headers = values[config.headerRow - 1].map(normalizeHeader);
      const context = { headers: headers, literalHeaders: values[config.headerRow - 1] };
      const mapped = values.slice(config.headerRow)
        .filter((row) => row.some((value) => String(value).trim() !== ''))
        .map((row) => config.map(rowToObject(headers, row), context))
        .filter(Boolean)
        .map((row) => Object.assign(row, {
          is_active: true, sync_token: token, synced_at: new Date().toISOString(),
        }));

      const rows = dedupeByKey(mapped, config.conflict);

      // A still-resolving IMPORTRANGE yields all "#N/A" → zero usable rows. Bail
      // before the stale-row sweep rather than deactivating everything.
      if (!rows.length) throw new Error('Refusing to sync ' + config.sheet + ': no usable rows found.');

      chunk(rows, 500).forEach((batch) => {
        rest(config.table + '?on_conflict=' + encodeURIComponent(config.conflict), 'post', batch, {
          Prefer: 'resolution=merge-duplicates,return=minimal',
        });
        rowsSynced += batch.length;
      });

      const stale = rest(
        config.table + '?is_active=eq.true&sync_token=neq.' + encodeURIComponent(token),
        'patch', { is_active: false, synced_at: new Date().toISOString() },
        { Prefer: 'return=representation' }
      );
      rowsDeleted = Array.isArray(stale) ? stale.length : 0;
      writeSyncLog(config.table, rowsSynced, rowsDeleted, 'success', null, startedAt);
    } catch (error) {
      writeSyncLog(config.table, rowsSynced, rowsDeleted, 'error', String(error.stack || error), startedAt);
      throw error;
    }
  }

  function writeSyncLog(table, synced, deleted, status, message, startedAt) {
    rest('sync_log', 'post', [{ table_name: table, rows_synced: synced, rows_deleted: deleted,
      status: status, error_message: message, started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString() }], { Prefer: 'return=minimal' });
  }

  function rest(path, method, payload, extraHeaders) {
    const props = PropertiesService.getScriptProperties();
    const url = props.getProperty('SUPABASE_URL');
    const key = props.getProperty('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Script Properties.');
    const response = UrlFetchApp.fetch(url.replace(/\/$/, '') + '/rest/v1/' + path, {
      method: method, contentType: 'application/json', muteHttpExceptions: true,
      headers: Object.assign({ apikey: key, Authorization: 'Bearer ' + key }, extraHeaders || {}),
      payload: payload === undefined ? undefined : JSON.stringify(payload),
    });
    if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
      throw new Error('Supabase ' + response.getResponseCode() + ': ' + response.getContentText());
    }
    const body = response.getContentText();
    return body ? JSON.parse(body) : null;
  }

  function normalizeHeader(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  }
  function rowToObject(headers, values) {
    const out = {};
    headers.forEach((h, i) => {
      if (!h) return;
      const v = values[i];
      if (!(h in out) || (isBlank(out[h]) && !isBlank(v))) out[h] = v;
    });
    return out;
  }
  function isBlank(v) { return v == null || String(v).trim() === '' || isSheetError(v); }

  const SHEET_ERRORS = ['#n/a', '#ref!', '#value!', '#div/0!', '#name?', '#null!', '#num!',
    '#error!', '#calc!', '#spill!'];
  function isSheetError(v) { return SHEET_ERRORS.indexOf(String(v == null ? '' : v).trim().toLowerCase()) > -1; }

  function text(v) {
    if (isSheetError(v)) return null;
    const s = String(v == null ? '' : v).trim();
    return s || null;
  }
  function number(v) { const s = text(v); if (!s) return 0; const n = Number(s.replace(/,/g, '')); return isFinite(n) ? n : 0; }
  function integerOrNull(v) { const s = text(v); return s == null ? null : Math.trunc(number(s)); }

  // Accepts a Sheets serial number, DD/MM/YYYY, DD-MM-YYYY, or ISO. Anything else
  // (or a #N/A) → null, so bad cells never break the date column on insert.
  function date(v) {
    const s = text(v); if (!s) return null;
    if (/^\d{4,6}$/.test(s)) {
      const serial = Number(s);
      if (serial >= 20000 && serial <= 80000) {
        return new Date(Date.UTC(1899, 11, 30) + serial * 86400000).toISOString().slice(0, 10);
      }
    }
    const dmy = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
    const iso = dmy ? [dmy[3], dmy[2].padStart(2, '0'), dmy[1].padStart(2, '0')].join('-') : s.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
    const parts = iso.split('-').map(Number);
    const probe = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    const roundTrips = probe.getUTCFullYear() === parts[0] && probe.getUTCMonth() === parts[1] - 1 &&
      probe.getUTCDate() === parts[2];
    return roundTrips ? iso : null;
  }

  function dedupeByKey(rows, conflictKey) {
    const byKey = {};
    const order = [];
    rows.forEach((row) => {
      const k = String(row[conflictKey]);
      if (!(k in byKey)) order.push(k);
      byKey[k] = row;
    });
    return order.map((k) => byKey[k]);
  }
  function chunk(items, size) { const c = []; for (let i = 0; i < items.length; i += size) c.push(items.slice(i, i + size)); return c; }

  function logHeaders() {
    const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
    if (!sheet) { Logger.log('Missing tab: ' + SHEET_NAME + '. Tabs present: ' +
      SpreadsheetApp.getActive().getSheets().map((s) => s.getName()).join(' | ')); return; }
    const values = sheet.getDataRange().getDisplayValues();
    Logger.log('Normalized header keys:\n' + (values[0] || []).map(normalizeHeader).filter(Boolean).join('\n'));
  }
  function logRaw(n) {
    const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
    if (!sheet) { Logger.log('Missing tab: ' + SHEET_NAME); return; }
    const values = sheet.getDataRange().getDisplayValues();
    const headers = values[0].map(normalizeHeader);
    values.slice(1).filter((r) => r.some((v) => String(v).trim() !== '')).slice(0, n || 3).forEach((row, idx) => {
      Logger.log('--- data row ' + (idx + 1) + ' ---');
      headers.forEach((h, i) => { if (h) Logger.log(i + '  ' + h + ' = ' + JSON.stringify(row[i])); });
    });
  }

  return { syncAll: syncAll, onEdit: onEdit, install: install, logHeaders: logHeaders, logRaw: logRaw };
})();
