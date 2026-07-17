// Google Sheets surfaces formula failures as literal error strings. IMPORTRANGE in
// particular emits "#N/A" for every cell while a source sheet is still resolving, so
// these values arrive in the CSV/API payload as ordinary text and must be treated as
// "no value" rather than data. Left unhandled they read as a filled-in date, which
// silently pushes POs into the wrong TNA stage.
const SHEET_ERRORS = new Set([
  '#n/a', '#ref!', '#value!', '#div/0!', '#name?', '#null!', '#num!', '#error!', '#calc!', '#spill!',
]);

export function isSheetError(value: unknown) {
  return SHEET_ERRORS.has(String(value ?? '').trim().toLowerCase());
}

/** Trimmed text, or null for blanks and spreadsheet error sentinels. */
export function sheetText(value: unknown) {
  if (isSheetError(value)) return null;
  return String(value ?? '').trim() || null;
}

/** Finite number, or 0 for blanks, sentinels and unparseable text. */
export function sheetNumber(value: unknown) {
  const raw = sheetText(value);
  if (!raw) return 0;
  const parsed = Number(raw.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function sheetBoolean(value: unknown) {
  return ['true', 'yes', 'y', '1'].includes(String(sheetText(value) ?? '').toLowerCase());
}

/**
 * Normalises a sheet date to ISO `yyyy-mm-dd`, or null when the cell does not hold a
 * real calendar date. Accepts `dd/mm/yyyy` (the TNA tracker's format) and ISO-ish input.
 * Anything else — including "#N/A" and impossible dates like 31/02 — returns null so the
 * value never masquerades as a completed milestone.
 */
export function sheetDate(value: unknown) {
  const raw = sheetText(value);
  if (!raw) return null;
  const dmy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const iso = dmy
    ? `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`
    : raw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  const roundTrips = probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
  return roundTrips ? iso : null;
}

/** Normalises a sheet timestamp to an ISO instant, or null when unparseable. */
export function sheetTimestamp(value: unknown) {
  const raw = sheetText(value);
  if (!raw) return null;
  const parsed = new Date(raw.replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
