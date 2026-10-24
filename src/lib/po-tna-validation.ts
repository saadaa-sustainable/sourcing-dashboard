export const REQUIRED_PO_TNA_FIELDS = [
  ['tna_days_pp_sample', 'PP sample'],
  ['tna_days_gpt', 'GPT'],
  ['tna_days_cutting', 'Cutting start'],
  ['tna_days_inline_qc', 'Inline QC'],
  ['tna_days_first_delivery', 'First delivery'],
  ['tna_days_po_closing', 'PO closing'],
] as const;
export function invalidPoTnaFields(values: Partial<Record<typeof REQUIRED_PO_TNA_FIELDS[number][0], unknown>>) {
  return REQUIRED_PO_TNA_FIELDS.filter(([key]) => {
    const raw = values[key];
    if (raw == null || String(raw).trim() === '') return true;
    const value = Number(raw);
    return !Number.isFinite(value) || !Number.isInteger(value) || value < 0;
  }).map(([, label]) => label);
}
