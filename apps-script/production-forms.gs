/**
 * SAADAA — Production Dashboard stage forms → Supabase sync (STANDALONE).
 *
 * Mirrors the production-stage Google-Form response tabs into six Supabase
 * tables, from which the view sd_po_stage_actuals derives each PO's ACTUAL stage
 * dates. The Open PO Tracker shows those as the "* ACTUAL" columns (planned
 * "* TNA" dates stay from the TNA Update sheet).
 *
 * The stages live across THREE spreadsheets — deploy this SAME script (bound) to
 * each; every instance syncs only the tabs it finds and skips the rest:
 *   • "Production Dashboard" (15mC3l06…): PP, Inline, PDI, PO Closure
 *   • "Lab_Reports"          (1z1tbtnm…): tab "Lab_Reports"     → GPT (GPT+FPT rows)
 *   • "Cutting Register"     (1pwgJGXT…): tab "Cutting Register" → Cutting
 * Add Script Properties (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) to EACH of the
 * three projects — they are per-project and NOT shared.
 *
 * Self-contained and namespaced (SbProd_) so it won't collide with the other
 * sync scripts (SbSync_ / SbDisc_).
 *
 * ── ONE-TIME SETUP ──────────────────────────────────────────────────────────
 * 1. Extensions → Apps Script; paste this file; Save.
 * 2. Project Settings → Script Properties:
 *      SUPABASE_URL              = https://jwqqifojsqcdrlquzwqr.supabase.co
 *      SUPABASE_SERVICE_ROLE_KEY = <service_role secret>
 * 3. Run `logProductionTabs()` — check View → Logs that the six SHEET names in
 *    CONFIG match the actual response-tab names; fix any that differ.
 * 4. Run `logProductionHeaders('PP Sample Update Form')` (etc.) to confirm the PO
 *    and date column keys per form (they are the normalized header names).
 * 5. Run `syncProductionForms()` once; confirm rows in Supabase.
 * 6. Run `installProductionFormsTriggers()` once to arm the 5-min + on-edit sync.
 * ────────────────────────────────────────────────────────────────────────────
 */

function syncProductionForms() { return SbProd_.syncAll(); }
function onEditProductionForms(e) { return SbProd_.onEdit(e); }
function installProductionFormsTriggers() { return SbProd_.install(); }
function logProductionTabs() { return SbProd_.listTabs(); }
function logProductionHeaders(tab) { return SbProd_.logHeaders(tab); }

const SbProd_ = (function () {
  // Each form tab → its own mirror table. `sheet` MUST match the tab name exactly
  // (verify with logProductionTabs). Each mapper extracts po_ref_num + actual_date.
  // ⚠ Column keys are the normalized header names — verify with logProductionHeaders.
  const CONFIG = [
    // In the Production Dashboard spreadsheet (15mC3l06…):
    { sheet: 'PP Sample Update Form',       table: 'pp_sample_form',  headerRow: 1, conflict: 'source_row_key', map: mapPpSample },
    { sheet: 'IN-LINE & MID LINE QC FORM',  table: 'inline_qc_form',  headerRow: 1, conflict: 'source_row_key', map: mapInline },
    { sheet: 'PRE-DISPATCH QC FORM',        table: 'pdi_form',        headerRow: 1, conflict: 'source_row_key', map: mapPdi },
    { sheet: 'PO Closure Form responses',   table: 'po_closure_form', headerRow: 1, conflict: 'source_row_key', map: mapClosure },
    // In the LAB-TEST REPORT spreadsheet (1z1tbtnmXxF…) — deploy this script there too;
    // set 'sheet' to that tab's exact name (run logProductionTabs there):
    { sheet: 'Lab_Reports',                 table: 'gpt_form',        headerRow: 1, conflict: 'source_row_key', map: mapGpt },
    // In the CUTTING spreadsheet (1pwgJGXTLJp…) — deploy this script there too; set 'sheet'
    // to that tab's exact name (run logProductionTabs there):
    { sheet: 'Cutting Register',            table: 'cutting_form',    headerRow: 1, conflict: 'source_row_key', map: mapCutting },
  ];

  // ---- Per-stage mappers. Date source per form (verified against tab headers).
  //   PP        -> "Date"                         (Production Dashboard)
  //   GPT       -> "Updated Date", GPT+FPT rows    (SEPARATE lab-test report sheet)
  //   Cutting   -> "DATE OF CUTTING"               (SEPARATE cutting sheet)
  //   Inline    -> "DATE OF IN-LINE QC"
  //   PDI       -> "Date of Pre Dispatch QC"       (feeds First Delivery actual)
  //   Closure   -> "PO Closure Date - as per TNA"
  // ⚠ STEP 0 (inspection columns): the resultKey / reportKey / remarksKey below are
  //   NORMALIZED header names — run logProductionHeaders and confirm/replace them per
  //   form. A wrong or absent key just yields null (non-fatal). QC stages (PP, GPT,
  //   Inline, PDI) carry a pass/fail answer + an uploaded report link; Cutting and
  //   Closure usually do not, so they pass no inspection keys.
  function mapPpSample(row) { return stageRow(row, 'po_number', 'date', { resultKey: 'pp_result', reportKey: 'pp_report_upload', remarksKey: 'remarks' }); }
  function mapGpt(row) {
    // Lab-test report sheet: keep GPT and FPT reports; the GPT actual is the latest
    // "Updated Date" across them for a PO (joined on PO No). Seam-strength etc. fails
    // are logged here too and captured as fail rows with a remark.
    if (!/gpt|fpt/i.test(text(row.test_type) || '')) return null;
    return stageRow(row, 'po_no', 'updated_date', { resultKey: 'result', reportKey: 'report_link', remarksKey: 'remarks' });
  }
  function mapCutting(row)  { return stageRow(row, 'po_number', 'date_of_cutting'); }
  function mapInline(row)   { return stageRow(row, 'po_number', 'date_of_in_line_qc', { resultKey: 'result', reportKey: 'report_upload', remarksKey: 'remarks' }); }
  function mapPdi(row)      { return stageRow(row, 'po_number', 'date_of_pre_dispatch_qc', { resultKey: 'result', reportKey: 'report_upload', remarksKey: 'remarks' }); }
  function mapClosure(row)  { return stageRow(row, 'po_no',     'po_closure_date_as_per_tna'); }

  // Normalize a form pass/fail answer to 'pass' | 'fail' | null. ⚠ Add any local
  // spellings seen in the sheets (e.g. 'ok', 'approved', 'rejected', 'ng').
  function passFail(v) {
    const s = (text(v) || '').toLowerCase();
    if (!s) return null;
    if (/(^|[^a-z])(pass|passed|ok|approved|accept|accepted)([^a-z]|$)/.test(s)) return 'pass';
    if (/(^|[^a-z])(fail|failed|reject|rejected|not ?ok|ng)([^a-z]|$)/.test(s)) return 'fail';
    return null;
  }

  // Keep only a URL-looking value (the Drive link from a form file-upload column).
  function urlOnly(v) {
    const s = text(v);
    return s && /^https?:\/\//i.test(s) ? s : null;
  }

  function stageRow(row, poKey, dateKey, opts) {
    const po = text(row[poKey]);
    if (!po) return null;
    const actual = dateKey === '__submitted__' ? submittedDate(row) : date(row[dateKey]);
    opts = opts || {};
    const result = opts.resultKey ? passFail(row[opts.resultKey]) : null;
    return {
      // result is in the key so a same-timestamp pass + fail do not collide.
      source_row_key: sha256([text(row.timestamp) || '', po, actual || '', result || ''].join('|')),
      po_ref_num: po,
      actual_date: actual,
      submitted_at: formTimestamp(row.timestamp),
      result: result,
      report_url: opts.reportKey ? urlOnly(row[opts.reportKey]) : null,
      remarks: opts.remarksKey ? text(row[opts.remarksKey]) : null,
    };
  }

  function syncAll() { CONFIG.forEach(syncSheet); }

  function onEdit(e) {
    if (!e || !e.range) return;
    const name = e.range.getSheet().getName();
    const config = CONFIG.find((c) => c.sheet === name);
    if (config) syncSheet(config);
  }

  function install() {
    const spreadsheet = SpreadsheetApp.getActive();
    ScriptApp.getProjectTriggers().forEach((trigger) => {
      if (['syncProductionForms', 'onEditProductionForms'].includes(trigger.getHandlerFunction())) {
        ScriptApp.deleteTrigger(trigger);
      }
    });
    ScriptApp.newTrigger('syncProductionForms').timeBased().everyMinutes(5).create();
    ScriptApp.newTrigger('onEditProductionForms').forSpreadsheet(spreadsheet).onEdit().create();
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
      const mapped = values.slice(config.headerRow)
        .filter((row) => row.some((v) => String(v).trim() !== ''))
        .map((row) => config.map(rowToObject(headers, row)))
        .filter(Boolean)
        .map((row) => Object.assign(row, { is_active: true, sync_token: token, synced_at: new Date().toISOString() }));
      const rows = dedupeByKey(mapped, config.conflict);
      if (!rows.length) throw new Error('Refusing to sync ' + config.sheet + ': no usable rows.');
      chunk(rows, 500).forEach((batch) => {
        rest(config.table + '?on_conflict=' + encodeURIComponent(config.conflict), 'post', batch, {
          Prefer: 'resolution=merge-duplicates,return=minimal',
        });
        rowsSynced += batch.length;
      });
      const stale = rest(
        config.table + '?is_active=eq.true&sync_token=neq.' + encodeURIComponent(token),
        'patch', { is_active: false, synced_at: new Date().toISOString() }, { Prefer: 'return=representation' });
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

  function normalizeHeader(v) {
    return String(v || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
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
  const SHEET_ERRORS = ['#n/a', '#ref!', '#value!', '#div/0!', '#name?', '#null!', '#num!', '#error!', '#calc!', '#spill!'];
  function isSheetError(v) { return SHEET_ERRORS.indexOf(String(v == null ? '' : v).trim().toLowerCase()) > -1; }

  function text(v) {
    if (isSheetError(v)) return null;
    const s = String(v == null ? '' : v).trim();
    return s || null;
  }

  // Accepts a Sheets serial, DD/MM/YYYY, DD-MM-YYYY, or ISO → 'YYYY-MM-DD' or null.
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
    const ok = probe.getUTCFullYear() === parts[0] && probe.getUTCMonth() === parts[1] - 1 && probe.getUTCDate() === parts[2];
    return ok ? iso : null;
  }

  // The submission date (date part of the "Timestamp" column) as 'YYYY-MM-DD'.
  function submittedDate(row) {
    const s = text(row.timestamp); if (!s) return null;
    return date(s.split(/[ T]/)[0]);
  }

  // Full form Timestamp ("DD/MM/YYYY HH:MM:SS", IST) → ISO timestamptz.
  function formTimestamp(v) {
    const s = text(v); if (!s) return null;
    const m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (m) {
      const iso = m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0') +
        'T' + m[4].padStart(2, '0') + ':' + m[5] + ':' + (m[6] || '00') + '+05:30';
      const d = new Date(iso);
      return isNaN(d.getTime()) ? null : d.toISOString();
    }
    const d = date(s);
    return d ? new Date(d + 'T00:00:00+05:30').toISOString() : null;
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
  function sha256(value) {
    return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value)
      .map((b) => ('0' + (b & 255).toString(16)).slice(-2)).join('');
  }
  function chunk(items, size) { const c = []; for (let i = 0; i < items.length; i += size) c.push(items.slice(i, i + size)); return c; }

  function listTabs() {
    Logger.log('Tabs in this spreadsheet:\n' +
      SpreadsheetApp.getActive().getSheets().map((s) => '"' + s.getName() + '"').join('\n'));
  }
  function logHeaders(tab) {
    const sheet = SpreadsheetApp.getActive().getSheetByName(tab);
    if (!sheet) { Logger.log('Missing tab: ' + tab); return; }
    Logger.log('Normalized headers of "' + tab + '":\n' +
      (sheet.getDataRange().getDisplayValues()[0] || []).map(normalizeHeader).filter(Boolean).join('\n'));
  }

  return { syncAll: syncAll, onEdit: onEdit, install: install, listTabs: listTabs, logHeaders: logHeaders };
})();
