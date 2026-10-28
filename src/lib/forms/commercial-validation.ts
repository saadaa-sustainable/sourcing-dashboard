import { BUSINESS_TYPES, COST_REASONS, REQUEST_TYPES, ATTACHMENT_LABEL, type CommercialAttachment, type CommercialBusinessType, type CommercialRequestType } from './commercial';
import { validateCommercialDetails, validCommercialDate } from './commercial-workflow';

// Paths this module hands out: <vendor>/<uuid>.<ext>. Nothing else is accepted back.
const PATH_RE = /^[A-Za-z0-9_-]{1,40}\/[0-9a-f-]{36}\.[a-z0-9]{1,5}$/;
export const safeCode = (code: string) => code.trim().toUpperCase().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'vendor';

const text = (v: FormDataEntryValue | null) => String(v ?? '').trim() || null;
const amount = (v: FormDataEntryValue | null) => {
  const s = String(v ?? '').replace(/[,₹\s]/g, '').replace(/^rs\.?/i, '');
  if (!s) return { ok: true as const, v: null };
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? { ok: true as const, v: n } : { ok: false as const };
};
const isoDate = (v: FormDataEntryValue | null) => {
  const s = String(v ?? '').trim();
  return validCommercialDate(s) ? s : null;
};

type Fields = {
  details: import('./commercial-workflow').CommercialDetails;
  business_type: CommercialBusinessType;
  vendor_code: string;
  vendor_name: string | null;
  po_numbers: string;
  request_type: CommercialRequestType;
  hold_qty: number | null;
  hold_days: number | null;
  ready_date: string | null;
  hold_reason: string | null;
  cost_reason: string | null;
  cost_reason_other: string | null;
  increment_amount: number | null;
  owner_name: string | null;
  owner_contact: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  invoice_amount: number | null;
  rg_pending: string | null;
  debit_note_number: string | null;
  credit_amount: number | null;
  remarks: string;
  attachments: CommercialAttachment[];
};

/** The fields of a commercial request, read and checked as the form checks them. */
export function commercialFields(formData: FormData, draft = false): { ok: true; v: Fields } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  const business = String(formData.get('business_type') ?? '') as CommercialBusinessType;
  const type = String(formData.get('request_type') ?? '') as CommercialRequestType;
  const vendorCode = String(formData.get('vendor_code') ?? '').trim().toUpperCase();
  const poNumbers = String(formData.get('po_numbers') ?? '').trim();
  const remarks = String(formData.get('remarks') ?? '').trim();
  if (!BUSINESS_TYPES.some((b) => b.key === business)) return bad('Pick the business type.');
  if (!vendorCode) return bad('Enter the vendor code.');
  if (!text(formData.get('vendor_name'))) return bad('Enter the firm name.');
  if (!poNumbers) return bad('Choose a purchase order.');
  if (!REQUEST_TYPES.some((r) => r.key === type)) return bad('Pick the type of request.');
  if (!draft && !['hold_waiver', 'grn_delay_waiver', 'surplus_fabric_consumption'].includes(type) && !remarks) return bad('Write the reason / remarks.');

  let details;
  try { details = validateCommercialDetails(type, JSON.parse(String(formData.get('details') ?? '{}')), draft); }
  catch (error) { return bad(error instanceof Error ? error.message : 'Invalid commercial details.'); }
  const v: Fields = {
    details,
    business_type: business,
    vendor_code: vendorCode,
    vendor_name: text(formData.get('vendor_name')),
    po_numbers: poNumbers.slice(0, 2000),
    request_type: type,
    hold_qty: null,
    hold_days: null,
    ready_date: null,
    hold_reason: null,
    cost_reason: null,
    cost_reason_other: null,
    increment_amount: null,
    owner_name: null,
    owner_contact: null,
    invoice_number: null,
    invoice_date: null,
    invoice_amount: null,
    rg_pending: null,
    debit_note_number: null,
    credit_amount: null,
    remarks: remarks.slice(0, 4000),
    attachments: [],
  };

  if (type === 'hold_waiver') {
    const qty = amount(formData.get('hold_qty'));
    const days = Number(String(formData.get('hold_days') ?? '').trim());
    if (!qty.ok || (!draft && (qty.v == null || qty.v <= 0))) return bad('Enter the total hold quantity.');
    if (!Number.isInteger(days) || days < 0 || (!draft && String(formData.get('hold_days') ?? '').trim() === '')) return bad('Enter the total days hold asked by the SAADAA team (a whole number).');
    v.hold_qty = qty.v;
    v.hold_days = String(formData.get('hold_days') ?? '').trim() ? days : null;
    v.ready_date = isoDate(formData.get('ready_date'));
    v.hold_reason = remarks;
  } else if (type === 'cost_increment') {
    const reason = String(formData.get('cost_reason') ?? '');
    if ((!draft || reason) && (!reason || reason.split(',').some((key) => !COST_REASONS[business].some((r) => r.key === key)))) return bad('Pick the reason for commercial approval.');
    const other = text(formData.get('cost_reason_other'));
    if (!draft && reason.split(',').includes('other') && !other) return bad('Enter the other reason for commercial approval.');
    const inc = amount(formData.get('increment_amount'));
    if (!inc.ok || (!draft && (inc.v == null || inc.v <= 0))) return bad('Enter an increment amount greater than zero.');
    v.cost_reason = reason;
    v.cost_reason_other = reason.split(',').includes('other') ? other : null;
    v.increment_amount = inc.v;
  } else if (type === 'cash_discount') {
    const amt = amount(formData.get('invoice_amount'));
    if (!amt.ok) return bad('The invoice amount must be a number.');
    v.owner_name = text(formData.get('owner_name'));
    v.owner_contact = text(formData.get('owner_contact'));
    v.invoice_number = text(formData.get('invoice_number'));
    v.invoice_date = isoDate(formData.get('invoice_date'));
    v.invoice_amount = amt.v;
    v.rg_pending = text(formData.get('rg_pending'));
  } else if (type === 'dn_removal') {
    v.debit_note_number = text(formData.get('debit_note_number'));
  } else if (type === 'credit_note') {
    const amt = amount(formData.get('credit_amount'));
    if (!amt.ok || (!draft && (amt.v == null || amt.v <= 0))) return bad('Enter a credit note amount greater than zero.');
    v.credit_amount = amt.v;
  }

  // Files the browser uploaded through startCommercialUpload, kept only where the form takes them.
  let files: CommercialAttachment[] = [];
  try {
    const parsed = JSON.parse(String(formData.get('attachments') ?? '[]')) as CommercialAttachment[];
    files = Array.isArray(parsed) ? parsed : [];
  } catch {
    files = [];
  }
  if (files.length > 10) return bad('Attach at most 10 files.');
  if (ATTACHMENT_LABEL[type]) {
    for (const f of files) {
      if (!f || typeof f.path !== 'string' || !PATH_RE.test(f.path) || !f.path.startsWith(safeCode(vendorCode) + '/')) return bad('Attach the files again.');
    }
    v.attachments = files.slice(0, 10).map((f) => ({ path: f.path, name: String(f.name ?? 'file').slice(0, 200), size: Number(f.size) || null }));
  }
  if (!draft) {
    if (type === 'hold_waiver' && !v.attachments.length) return bad('Attach hold instructions / supporting communication.');
    if (type === 'hold_waiver' && !v.ready_date) return bad('Enter the goods / fabric ready date.');
    if (type === 'cash_discount' && (!v.owner_name || !v.owner_contact || !v.invoice_number || !v.invoice_date || !v.rg_pending)) return bad('Complete owner, invoice and RG pending details.');
    if (type === 'cash_discount' && !/^[+()\d\s-]{7,25}$/.test(v.owner_contact!)) return bad('Enter a valid owner contact number.');
    if (type === 'dn_removal' && !v.debit_note_number) return bad('Enter the debit note number.');
    if (['dn_removal', 'credit_note', 'surplus_fabric_consumption'].includes(type) && !v.attachments.length) return bad('Attach the supporting proof.');
  }
  return { ok: true, v };
}

