/**
 * SAADAA Sheets -> Supabase sync (namespaced build).
 *
 * Safe to drop into a project that already contains another script: the ONLY
 * global identifiers this file declares are the three trigger entry points
 * (syncAllSheets, onEditSync, installSyncTriggers) and the single namespace
 * object SbSync_. Every helper, config array and constant lives inside SbSync_,
 * so there is nothing generic (text_, number_, date_, SYNC_CONFIG, ...) left in
 * the global scope to collide with an existing bound dashboard script.
 *
 * Script properties required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 * Run installSyncTriggers() once to arm the 5-minute + on-edit sync.
 */

// ---- Trigger entry points (the only functions Apps Script needs globally) ----
function syncAllSheets() { return SbSync_.syncAll(); }
function onEditSync(e) { return SbSync_.onEdit(e); }
function installSyncTriggers() { return SbSync_.install(); }

// ---- Everything else, sealed inside one uniquely-named global ----
const SbSync_ = (function () {
  const CONFIG = [
    {
      sheet: 'Pending_PO_MASTER', table: 'pending_po_master', headerRow: 1,
      conflict: 'source_row_key', map: mapPendingPoRow,
    },
    {
      sheet: 'Vendor_Type_Master', table: 'vendor_type_master', headerRow: 1,
      conflict: 'vendor_name', map: mapVendorTypeRow,
    },
    {
      sheet: 'Vendor Master Data', table: 'vendor_master_data', headerRow: 2,
      conflict: 'vendor_code', map: mapVendorMasterRow,
    },
    {
      sheet: 'TNA Tracker', table: 'tna_tracker', headerRow: 1,
      conflict: 'po_no', map: mapTnaRow,
    },
  ];

  function syncAll() {
    CONFIG.forEach(syncSheet);
  }

  function onEdit(e) {
    if (!e || !e.range) return;
    const name = e.range.getSheet().getName();
    const config = CONFIG.find((item) => item.sheet === name);
    if (config) syncSheet(config);
  }

  function install() {
    const spreadsheet = SpreadsheetApp.getActive();
    ScriptApp.getProjectTriggers().forEach((trigger) => {
      if (['syncAllSheets', 'onEditSync'].includes(trigger.getHandlerFunction())) {
        ScriptApp.deleteTrigger(trigger);
      }
    });
    ScriptApp.newTrigger('syncAllSheets').timeBased().everyMinutes(5).create();
    ScriptApp.newTrigger('onEditSync').forSpreadsheet(spreadsheet).onEdit().create();
  }

  function syncSheet(config) {
    const startedAt = new Date();
    const token = Utilities.getUuid();
    let rowsSynced = 0;
    let rowsDeleted = 0;
    try {
      const sheet = SpreadsheetApp.getActive().getSheetByName(config.sheet);
      if (!sheet) throw new Error('Missing sheet: ' + config.sheet);
      const values = sheet.getDataRange().getDisplayValues();
      const headers = values[config.headerRow - 1].map(normalizeHeader);
      const context = { headers: headers, literalHeaders: values[config.headerRow - 1] };
      const mapped = values.slice(config.headerRow)
        .filter((row) => row.some((value) => String(value).trim() !== ''))
        .map((row) => config.map(rowToObject(headers, row), context))
        .filter(Boolean)
        .map((row) => Object.assign(row, {
          is_active: true,
          sync_token: token,
          synced_at: new Date().toISOString(),
        }));

      // Postgres refuses an upsert batch that touches the same conflict target twice
      // ("ON CONFLICT DO UPDATE command cannot affect row a second time"), which would
      // fail the whole sheet. Last row wins, mirroring a top-to-bottom sheet read.
      const rows = dedupeByKey(mapped, config.conflict);
      if (rows.length < mapped.length) {
        Logger.log(config.sheet + ': collapsed ' + (mapped.length - rows.length) +
          ' duplicate ' + config.conflict + ' rows');
      }

      // An IMPORTRANGE that is still resolving yields a sheet of "#N/A", which maps to
      // zero usable rows. Bail out before the stale-row sweep rather than deactivating
      // every row and blanking the dashboard.
      if (!rows.length) throw new Error('Refusing to sync ' + config.sheet + ': no usable rows found.');

      chunk(rows, 500).forEach((batch) => {
        rest(config.table + '?on_conflict=' + encodeURIComponent(config.conflict), 'post', batch, {
          Prefer: 'resolution=merge-duplicates,return=minimal',
        });
        rowsSynced += batch.length;
      });

      // Only deactivate stale rows after every upsert batch succeeds.
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

  function mapPendingPoRow(row) {
    const poDetailId = text(row.po_detail_id);
    // Filler rows (blank but for a stray "TRUE" in Match) carry no PO identity and would
    // otherwise collapse onto a single synthetic source_row_key.
    if (!poDetailId && !text(row.po_ref_num)) return null;
    const legacyKey = [row.po_ref_num, row.sku, row.cp_id, row.po_id, row.size]
      .map(text).join('|');
    return {
      source_row_key: poDetailId || 'legacy:' + sha256(legacyKey),
      po_number: text(row.po_number), po_created_date: timestamp(row.po_created_date),
      po_date: date(row.po_date), item_price: number(row.item_price), po_id: text(row.po_id),
      sku: text(row.sku), product_description: text(row.product_description), cp_id: text(row.cp_id),
      po_detail_id: poDetailId || null, original_quantity: number(row.original_quantity),
      pending_quantity: number(row.pending_quantity), size: text(row.size), po_status: text(row.po_status),
      po_created_warehouse: text(row.po_created_warehouse),
      po_created_location_key: text(row.po_created_location_key),
      po_created_warehouse_c_id: text(row.po_created_warehouse_c_id),
      vendor_name: text(row.vendor_name), vendor_code: text(row.vendor_code),
      expected_delivery_date: date(row.expected_delivery_date), po_ref_num: text(row.po_ref_num),
      completed_at_timestamp: timestamp(row.completed_at_timestamp),
      product_variant: text(row.product_varient), product_code: text(row.product_code),
      pending_qty_actual: number(row.pending_qty_actual), po_type: text(row.po_type),
      match_flag: boolean(row.match),
    };
  }

  function mapVendorTypeRow(row) {
    const vendorName = text(row.vendor_name);
    if (!vendorName) return null;
    return { vendor_name: vendorName, vendor_code: text(row.vendor_code),
      vendor_type: text(row.vendor_type), merchant_name: text(row.merchant_name), status: text(row.status) };
  }

  function mapVendorMasterRow(row, context) {
    const vendorCode = text(row.vendor_code);
    if (!vendorCode) return null;
    const karigarIndex = context.headers.findIndex((header) => header.indexOf('no_of_karigar_') === 0);
    const karigarKey = karigarIndex >= 0 ? context.headers[karigarIndex] : '';
    return {
      vendor_code: vendorCode, vendor_name: text(row.vendor_name), onboarding_date: date(row.onboarding_date),
      contact_person_name: text(row.contact_person_name), contact_no: text(row.contact_no),
      address: text(row.address), primary_type: text(row.primary_type),
      fob_complete_possible: text(row.fob_complete_possible), merchant_name: text(row.merchant_name),
      vendor_preference: text(row.vendor_preference), total_machines: number(row.total_machines),
      total_active_karigar: number(row.total_active_karigar),
      machines_for_saadaa: number(row.no_of_machines_for_saadaa),
      capacity_per_month: number(row.capacity_month_for_saadaa),
      karigar_latest: karigarKey ? number(row[karigarKey]) : 0,
      karigar_latest_as_of: karigarIndex >= 0 ? context.literalHeaders[karigarIndex] : null,
    };
  }

  function mapTnaRow(row) {
    const poNo = text(row.po_no);
    if (!poNo) return null;
    return {
      po_no: poNo, po_issued_date: date(row.po_issued_date), po_qty: number(row.po_qty),
      pp_sample_tna_date: date(row.pp_sample_tna_date), pp_sample_actual_date: date(row.pp_sample_actual_date),
      pp_sample_delay_days: integer(row.pp_sample_delay_days), gpt_tna_date: date(row.gpt_tna_date),
      gpt_actual_date: date(row.gpt_actual_date), gpt_delay_days: integer(row.gpt_delay_days),
      cutting_tna_date: date(row.cutting_tna_date),
      cutting_actual_date_first: date(row.cutting_actual_date_first),
      cutting_delay_days: integer(row.cutting_delay_days), in_line_tna_date: date(row.in_line_tna_date),
      in_line_actual_date: date(row.in_line_actual_date), in_line_qc_delay_days: integer(row.in_line_qc_delay_days),
    };
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
  function rowToObject(headers, values) { const out = {}; headers.forEach((h, i) => { if (h) out[h] = values[i]; }); return out; }

  // Sheets renders formula failures as literal text ("#N/A" while IMPORTRANGE resolves,
  // "#REF!" on a broken reference). These are absence of data, not data: passed through
  // they break date/numeric columns on insert and read as completed TNA milestones.
  const SHEET_ERRORS = ['#n/a', '#ref!', '#value!', '#div/0!', '#name?', '#null!', '#num!',
    '#error!', '#calc!', '#spill!'];
  function isSheetError(v) { return SHEET_ERRORS.indexOf(String(v == null ? '' : v).trim().toLowerCase()) > -1; }

  function text(v) {
    if (isSheetError(v)) return null;
    const s = String(v == null ? '' : v).trim();
    return s || null;
  }
  function number(v) { const s = text(v); if (!s) return 0; const n = Number(s.replace(/,/g, '')); return isFinite(n) ? n : 0; }
  function integer(v) { return Math.trunc(number(v)); }
  function boolean(v) { return ['true', 'yes', 'y', '1'].indexOf(String(text(v) || '').toLowerCase()) > -1; }
  function timestamp(v) {
    const s = text(v); if (!s) return null;
    const parsed = new Date(s.replace(' ', 'T') + (s.indexOf('Z') > -1 ? '' : '+05:30'));
    return isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  function date(v) {
    const s = text(v); if (!s) return null;
    const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
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
  function sha256(value) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value)
    .map((byte) => ('0' + (byte & 255).toString(16)).slice(-2)).join(''); }
  function chunk(items, size) { const chunks = []; for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size)); return chunks; }

  return { syncAll: syncAll, onEdit: onEdit, install: install };
})();
