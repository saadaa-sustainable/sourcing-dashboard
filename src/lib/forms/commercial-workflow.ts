import type { CommercialRequestType } from './commercial';

export type CommercialDetails = Record<string, string>;
export type CommercialExtraField = { key: string; label: string; type?: 'number' | 'date'; options?: string[]; required?: boolean; readOnly?: boolean };
export function holdWaiverDays(details: CommercialDetails): number | null {
  if (!validCommercialDate(details.hold_start ?? '') || !validCommercialDate(details.hold_end ?? '')) return null;
  const days = (Date.parse(details.hold_end) - Date.parse(details.hold_start)) / 86400000;
  return days >= 0 ? days : null;
}
export function grnDelayDays(details: CommercialDetails): number | null {
  return holdWaiverDays({ hold_start: details.delivery_date ?? '', hold_end: details.grn_date ?? '' });
}
export function fabricConsumptionIncrease(initial: string, revised: string) {
  if (!initial.trim() || !revised.trim()) return null;
  const base = Number(initial), next = Number(revised);
  const increase = next - base;
  const percent = increase / base * 100;
  return base > 0 && next >= 0 && Number.isFinite(increase) && Number.isFinite(percent)
    ? { amount: Number(increase.toPrecision(12)), percent: Number(percent.toPrecision(12)) } : null;
}
export const COMMERCIAL_EXTRA_FIELDS: Record<CommercialRequestType, CommercialExtraField[]> = {
  surplus_fabric_consumption: [
    { key: 'initial_consumption', label: 'Initial Average Fabric Consumption', type: 'number', required: true },
    { key: 'revised_consumption', label: 'Revised Fabric Consumption', type: 'number', required: true },
    { key: 'increased_consumption', label: 'Increased Fabric Consumption', type: 'number', readOnly: true },
    { key: 'consumption_increase_percent', label: 'Fabric Consumption Increase (%)', type: 'number', readOnly: true },
  ],
  grn_delay_waiver: [
    { key: 'challan_no', label: 'Challan no', required: true },
    { key: 'grn_no', label: 'GRN no', required: true },
    { key: 'delayed_qty', label: 'Total GRN delayed qty', type: 'number', required: true },
    { key: 'quantity_unit', label: 'Quantity unit', options: ['pieces', 'metres', 'kg'], required: true },
    { key: 'delivery_date', label: 'Goods delivery date', type: 'date', required: true },
    { key: 'grn_date', label: 'GRN date', type: 'date', required: true },
    { key: 'grn_delay_days', label: 'GRN Delay Days', type: 'number', readOnly: true },
  ],
  hold_waiver: [
    { key: 'quantity_unit', label: 'Quantity unit', options: ['pieces', 'metres', 'kg'], required: true },
    { key: 'hold_start', label: 'Hold start date', type: 'date', required: true },
    { key: 'hold_end', label: 'Hold end date', type: 'date', required: true },
    { key: 'hold_requested_by', label: 'SAADAA person requesting hold', required: true },
    { key: 'waiver_basis', label: 'Waiver being requested' },
    { key: 'requested_amount', label: 'Requested compensation amount (INR)', type: 'number' },
  ],
  cost_increment: [
    { key: 'affected_items', label: 'Affected PO lines / materials' },
    { key: 'quantity_unit', label: 'Rate unit', options: ['pieces', 'metres', 'kg'] },
    { key: 'current_rate', label: 'Current rate per unit (INR)', type: 'number' },
    { key: 'affected_quantity', label: 'Affected quantity', type: 'number' },
  ],
  cash_discount: [
    { key: 'cd_percent', label: 'Requested cash discount (%)', type: 'number' },
    { key: 'payment_deadline', label: 'Payment deadline', type: 'date' },
    { key: 'payment_terms', label: 'Payment terms' },
  ],
  dn_removal: [
    { key: 'dn_date', label: 'Debit note date', type: 'date', required: true },
    { key: 'dn_amount', label: 'Original debit note amount (INR)', type: 'number', required: true },
    { key: 'requested_amount', label: 'Amount to remove (INR)', type: 'number', required: true },
    { key: 'related_invoice', label: 'Related invoice number' },
  ],
  credit_note: [
    { key: 'issuer', label: 'Credit note issued by', options: ['Vendor to SAADAA', 'SAADAA to vendor'], required: true },
    { key: 'related_invoice', label: 'Related invoice / debit note', required: true },
    { key: 'tax_basis', label: 'Amount basis', options: ['Including tax', 'Excluding tax'], required: true },
  ],
};

export function validCommercialDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

/** Reject unknown fields and invalid values; draft saves may omit required values. */
export function validateCommercialDetails(type: CommercialRequestType, input: unknown, draft = false): CommercialDetails {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid commercial details.');
  const output: CommercialDetails = {};
  for (const field of COMMERCIAL_EXTRA_FIELDS[type]) {
    if (field.readOnly) continue;
    const raw = (input as Record<string, unknown>)[field.key];
    if (raw != null && typeof raw !== 'string') throw new Error(`Invalid ${field.label}.`);
    const value = String(raw ?? '').trim();
    if (!draft && field.required && !value) throw new Error(`Enter ${field.label.toLowerCase()}.`);
    if (!value) continue;
    if (value.length > 2000) throw new Error(`${field.label} is too long.`);
    if (field.options && !field.options.includes(value)) throw new Error(`Choose ${field.label.toLowerCase()}.`);
    if (field.type === 'date' && !validCommercialDate(value)) throw new Error(`Enter a valid ${field.label.toLowerCase()}.`);
    if (field.type === 'number' && (!Number.isFinite(Number(value)) || Number(value) < 0)) throw new Error(`${field.label} must be a non-negative number.`);
    output[field.key] = value;
  }
  if (Number(output.cd_percent) > 100) throw new Error('Cash discount cannot exceed 100%.');
  if (type === 'surplus_fabric_consumption') {
    if (output.initial_consumption && Number(output.initial_consumption) <= 0) throw new Error('Initial average fabric consumption must be greater than zero.');
    const increase = fabricConsumptionIncrease(output.initial_consumption ?? '', output.revised_consumption ?? '');
    if (!draft && (!increase || increase.percent <= 1)) throw new Error('The increase in average fabric consumption must be greater than 1%.');
    if (increase) {
      output.increased_consumption = String(increase.amount);
      output.consumption_increase_percent = String(increase.percent);
    }
  }
  if (!draft && type === 'cash_discount' && output.cd_percent && Number(output.cd_percent) <= 0) throw new Error('Cash discount must be greater than zero.');
  if (!draft && type === 'dn_removal' && Number(output.requested_amount) <= 0) throw new Error('Removal amount must be greater than zero.');
  if (output.hold_start && output.hold_end && output.hold_end < output.hold_start) throw new Error('Hold end must be on or after hold start.');
  if (type === 'grn_delay_waiver') {
    const days = grnDelayDays(output);
    if (days != null) output.grn_delay_days = String(days);
    if (output.delayed_qty && Number(output.delayed_qty) <= 0) throw new Error('Total GRN delayed qty must be greater than zero.');
    if (!draft && (days == null || days <= 7)) throw new Error('GRN date must be more than 7 days after the goods delivery date.');
  }
  if (output.dn_amount && output.requested_amount && Number(output.requested_amount) > Number(output.dn_amount)) throw new Error('Removal amount cannot exceed the debit note amount.');
  return output;
}

export function commercialImpact(type: CommercialRequestType, details: CommercialDetails, increment: number | null, invoice: number | null, credit: number | null): number | null {
  if (type === 'hold_waiver') return null;
  const value = type === 'cost_increment' ? increment != null && details.affected_quantity ? increment * Number(details.affected_quantity) : null
    : type === 'cash_discount' ? invoice != null && details.cd_percent ? invoice * Number(details.cd_percent) / 100 : null
      : type === 'credit_note' ? credit : details.requested_amount ? Number(details.requested_amount) : null;
  return value == null || !Number.isFinite(value) ? null : Math.round(value * 100) / 100;
}

export function commercialRequestNumber(id: number, requestedAt?: string | null) {
  return `CAR-${requestedAt?.slice(0, 4) ?? 'LEGACY'}-${String(id).padStart(6, '0')}`;
}

export function mayEditCommercial(email: string, admin: boolean, owner: string | null, status: string) {
  return status !== 'approved' && (admin || email.toLowerCase() === owner?.toLowerCase());
}
