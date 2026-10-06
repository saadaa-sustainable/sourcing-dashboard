/**
 * Vendor Invoices - Accounts — the questions of the team's Google Form, kept in one plain
 * module (no 'use client' / 'use server') so the public page, the server action and the
 * dashboard log all read the same lists and the same branching.
 *
 * Option lists are copied from the form as it stood on 2026-10-06. The vendor codes are
 * the form's own list, not the EasyEcom vendor master: the master also holds test and
 * walk-in rows, and three of the form's codes (SIS, ACA, FLR) are not in it.
 */

export const VI_ASSOCIATIONS = [
  'Fabrication Partner',
  'Fabric Dyeing Partner',
  'Fabric (Greige / Dyed) Supply Partner',
  'Transportation Partner',
  'Trims Partner',
] as const;
export type ViAssociation = (typeof VI_ASSOCIATIONS)[number];

/** The form skips Vendor Code + PO Type for these two (they jump straight to the document). */
const SKIPS_VENDOR_SECTION: ReadonlySet<string> = new Set([
  'Fabric Dyeing Partner',
  'Fabric (Greige / Dyed) Supply Partner',
]);
export const asksVendorSection = (association: string) =>
  !!association && !SKIPS_VENDOR_SECTION.has(association);

export const VI_VENDOR_CODES = [
  'AF', 'AK', 'PC', 'RF', 'SGA', 'VLA', 'SCR', 'HTH', 'KEK', 'SWA', 'NF', 'RIB', 'JSM', 'FIN', 'EFJ', 'PYC',
  'SA', 'SES', 'SHS', 'OP', 'KKK', 'KIZ', 'AFP', 'NFM', 'MCK', 'SIS', 'STN', 'ICN', 'ACA', 'FLR', 'STR',
] as const;

export const VI_PO_TYPES = [
  'JOB ORDER (CMTP Charge)',
  'PRODUCTION ORDER (FOB)',
  'E-FOB (Paid for fabric in start of PO)',
  'Fabrication (PO - PO settlement of fabric Invoice)',
] as const;

export const VI_DOCUMENT_TYPES = ['INVOICE', 'DEBIT NOTE', 'CREDIT NOTE'] as const;
export type ViDocumentType = (typeof VI_DOCUMENT_TYPES)[number];

export const VI_BUCKET = 'vendor-invoices';
export const VI_MAX_BYTES = 10 * 1024 * 1024;

export type VendorInvoice = {
  id: number;
  created_at: string;
  email: string;
  po_ref_num: string;
  association: string;
  vendor_code: string | null;
  po_type: string | null;
  document_type: ViDocumentType;
  invoice_number: string | null;
  invoice_date: string | null;
  invoice_total_qty: number | null;
  invoice_value: number | null;
  grn_number: string | null;
  reference_challan_number: string | null;
  note_date: string | null;
  reference_document_number: string | null;
  file_path: string;
  file_name: string | null;
  submitted_via: string;
  submitted_by_email: string | null;
};

/** What the page sends; every value is a raw string as typed. */
export type ViDraft = {
  email: string;
  po_ref_num: string;
  association: string;
  vendor_code: string;
  po_type: string;
  document_type: string;
  invoice_number: string;
  invoice_date: string;
  invoice_total_qty: string;
  invoice_value: string;
  grn_number: string;
  reference_challan_number: string;
  note_date: string;
  reference_document_number: string;
};

export const emptyViDraft = (): ViDraft => ({
  email: '', po_ref_num: '', association: '', vendor_code: '', po_type: '', document_type: '',
  invoice_number: '', invoice_date: '', invoice_total_qty: '', invoice_value: '', grn_number: '',
  reference_challan_number: '', note_date: '', reference_document_number: '',
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const num = (s: string) => {
  const n = Number(String(s).replace(/,/g, '').trim());
  return s.trim() !== '' && Number.isFinite(n) ? n : null;
};

/**
 * Check a draft against the form's required questions and turn it into the row to insert
 * (minus the file and who-submitted fields). Runs in the browser for instant feedback and
 * again on the server, which is the one that counts.
 */
export function validateViDraft(d: ViDraft):
  | { ok: true; row: Omit<VendorInvoice, 'id' | 'created_at' | 'file_path' | 'file_name' | 'submitted_via' | 'submitted_by_email'> }
  | { ok: false; error: string } {
  const t = (s: string) => String(s ?? '').trim();
  const email = t(d.email).toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, error: 'Enter a valid email address.' };
  const po = t(d.po_ref_num).toUpperCase();
  if (!po) return { ok: false, error: 'Enter the PO No. issued by SAADAA.' };
  if (!(VI_ASSOCIATIONS as readonly string[]).includes(d.association))
    return { ok: false, error: 'Choose your association with SAADAA.' };

  let vendor_code: string | null = null;
  let po_type: string | null = null;
  if (asksVendorSection(d.association)) {
    vendor_code = t(d.vendor_code).toUpperCase();
    if (!vendor_code) return { ok: false, error: 'Choose your vendor code.' };
    if (!(VI_PO_TYPES as readonly string[]).includes(d.po_type)) return { ok: false, error: 'Choose the PO type.' };
    po_type = d.po_type;
  }

  if (!(VI_DOCUMENT_TYPES as readonly string[]).includes(d.document_type))
    return { ok: false, error: 'Choose the type of document.' };
  const document_type = d.document_type as ViDocumentType;

  const base = {
    email, po_ref_num: po, association: d.association, vendor_code, po_type, document_type,
    invoice_number: null, invoice_date: null, invoice_total_qty: null, invoice_value: null,
    grn_number: null, reference_challan_number: null, note_date: null, reference_document_number: null,
  };

  if (document_type === 'INVOICE') {
    const invoice_number = t(d.invoice_number);
    if (!invoice_number) return { ok: false, error: 'Enter the invoice number.' };
    if (!DATE_RE.test(t(d.invoice_date))) return { ok: false, error: 'Enter the invoice date.' };
    const qty = num(d.invoice_total_qty);
    if (qty == null || qty < 0) return { ok: false, error: 'Enter the invoice total qty as a number.' };
    const value = num(d.invoice_value);
    if (value == null || value < 0) return { ok: false, error: 'Enter the invoice value as a number.' };
    const challan = t(d.reference_challan_number);
    if (!challan) return { ok: false, error: 'Enter the reference challan number.' };
    return {
      ok: true,
      row: {
        ...base, invoice_number, invoice_date: t(d.invoice_date), invoice_total_qty: qty, invoice_value: value,
        grn_number: t(d.grn_number) || null, reference_challan_number: challan,
      },
    };
  }

  const label = document_type === 'DEBIT NOTE' ? 'debit note' : 'credit note';
  if (!DATE_RE.test(t(d.note_date))) return { ok: false, error: `Enter the date of the ${label}.` };
  const ref = t(d.reference_document_number);
  if (!ref) return { ok: false, error: 'Enter the reference document number.' };
  return { ok: true, row: { ...base, note_date: t(d.note_date), reference_document_number: ref } };
}
