// Vendor Commercial Approval — the team's Google Form "COMMERCIAL APPROVAL FORM", field for
// field. Plain module: the server actions, the page and the approval queue all read these.

export type CommercialBusinessType = 'garment' | 'fabric';
export type CommercialRequestType = 'hold_waiver' | 'cost_increment' | 'cash_discount' | 'dn_removal' | 'credit_note';

export const BUSINESS_TYPES: { key: CommercialBusinessType; label: string; hint: string }[] = [
  { key: 'garment', label: 'Garment manufacturer', hint: 'Job / E-FOB / FOB' },
  { key: 'fabric', label: 'Fabric processing / supplier', hint: 'Greige supplier / dyer' },
];

/** The form names the hold waiver after what is held: goods for a garment vendor, fabric for a supplier. */
export const requestTypeLabel = (t: CommercialRequestType, b?: CommercialBusinessType | null): string =>
  t === 'hold_waiver' ? `Waiver for ${b === 'fabric' ? 'fabric' : b === 'garment' ? 'goods' : 'goods / fabric'} held by SAADAA` : REQUEST_TYPE_LABEL[t];

export const REQUEST_TYPES: { key: CommercialRequestType; label: string }[] = [
  { key: 'hold_waiver', label: 'Waiver for goods / fabric held by SAADAA' },
  { key: 'cost_increment', label: 'Commercial approval / cost increment' },
  { key: 'cash_discount', label: 'Cash discount (CD)' },
  { key: 'dn_removal', label: 'Debit note (DN) removal' },
  { key: 'credit_note', label: 'Credit note request' },
];

export const REQUEST_TYPE_LABEL: Record<CommercialRequestType, string> = Object.fromEntries(
  REQUEST_TYPES.map((r) => [r.key, r.label]),
) as Record<CommercialRequestType, string>;

/** Reasons for a cost increment, as the form lists them for each business type ("Other" is free text). */
export const COST_REASONS: Record<CommercialBusinessType, { key: string; label: string }[]> = {
  garment: [
    { key: 'fabric_width_short', label: 'Fabric width short' },
    { key: 'dark_edges', label: 'Dark edges — difference in cuttable width' },
    { key: 'fabric_defect', label: 'Defect in fabric' },
    { key: 'trim_add_ons', label: 'Add-ons in product trims' },
    { key: 'silhouette_change', label: 'Change in product silhouette / design' },
    { key: 'trim_quality_change', label: 'Change in trim quality' },
    { key: 'finishing_add_ons', label: 'Add-ons in product finishing (washing / other finish)' },
    { key: 'unequal_ratio', label: 'Increase in average due to unequal ratio' },
    { key: 'other', label: 'Other' },
  ],
  fabric: [
    { key: 'dye_rate', label: 'Increase in dye rate' },
    { key: 'fabric_finishing', label: 'Add-ons in fabric finishing / washing' },
    { key: 'greige_yarn_rate', label: 'Increase in greige / yarn rate' },
    { key: 'other', label: 'Other' },
  ],
};

export function costReasonLabel(b: CommercialBusinessType, key: string | null, other?: string | null): string {
  if (!key) return '—';
  if (key === 'other') return other ? `Other — ${other}` : 'Other';
  return COST_REASONS[b].find((r) => r.key === key)?.label ?? key;
}

/** What the free-text box is called for each request type (every request carries one). */
export const REMARKS_LABEL: Record<CommercialRequestType, string> = {
  hold_waiver: 'Reason for hold',
  cost_increment: 'Remarks',
  cash_discount: 'Remarks',
  dn_removal: 'Reason for DN removal',
  credit_note: 'Reason for credit note',
};

/** Which request types take files, and what the form calls them. */
export const ATTACHMENT_LABEL: Partial<Record<CommercialRequestType, string>> = {
  cash_discount: 'Invoice copy',
  dn_removal: 'Proof or related documents',
  credit_note: 'Proof or related documents',
};

export const COMMERCIAL_BUCKET = 'commercial-approvals';
export const COMMERCIAL_MAX_BYTES = 25 * 1024 * 1024;
export const COMMERCIAL_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'xlsx', 'xls', 'csv', 'doc', 'docx', 'zip'] as const;

export function commercialFileError(name: string, size: number): string | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name.trim())?.[1]?.toLowerCase() ?? '';
  if (!(COMMERCIAL_EXTENSIONS as readonly string[]).includes(ext)) return `This file type is not accepted. Use ${COMMERCIAL_EXTENSIONS.map((e) => e.toUpperCase()).join(', ')}.`;
  if (!(size > 0)) return 'The file is empty.';
  if (size > COMMERCIAL_MAX_BYTES) return 'The file is larger than 25 MB.';
  return null;
}

export type CommercialAttachment = { path: string; name: string; size: number | null };

const inr = (v: number | null | undefined) => (v == null ? null : `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(v)}`);

/** The request's key facts on one line — the approval card and the request list read this. */
export function commercialSummary(r: {
  business_type: CommercialBusinessType;
  request_type: CommercialRequestType;
  po_numbers: string;
  hold_qty: number | null;
  hold_days: number | null;
  ready_date: string | null;
  cost_reason: string | null;
  cost_reason_other: string | null;
  increment_amount: number | null;
  invoice_number: string | null;
  invoice_amount: number | null;
  rg_pending: string | null;
  debit_note_number: string | null;
  credit_amount: number | null;
  attachments?: CommercialAttachment[] | null;
}): string {
  const parts: (string | null)[] = [BUSINESS_TYPES.find((b) => b.key === r.business_type)?.label ?? r.business_type, `PO ${r.po_numbers}`];
  if (r.request_type === 'hold_waiver') parts.push(r.hold_qty != null ? `${new Intl.NumberFormat('en-IN').format(r.hold_qty)} held` : null, r.hold_days != null ? `${r.hold_days} days asked` : null, r.ready_date ? `ready ${r.ready_date}` : null);
  if (r.request_type === 'cost_increment') parts.push(costReasonLabel(r.business_type, r.cost_reason, r.cost_reason_other), r.increment_amount != null ? `+${inr(r.increment_amount)} asked` : null);
  if (r.request_type === 'cash_discount') parts.push(r.invoice_number ? `invoice ${r.invoice_number}` : null, inr(r.invoice_amount), r.rg_pending ? `RG pending ${r.rg_pending}` : null);
  if (r.request_type === 'dn_removal') parts.push(r.debit_note_number ? `DN ${r.debit_note_number}` : null);
  if (r.request_type === 'credit_note') parts.push(r.credit_amount != null ? `credit ${inr(r.credit_amount)}` : null);
  const n = r.attachments?.length ?? 0;
  if (n) parts.push(`${n} file${n === 1 ? '' : 's'}`);
  return parts.filter(Boolean).join(' · ');
}
