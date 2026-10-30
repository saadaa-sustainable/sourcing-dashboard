export const PO_REWORK_SECTIONS = [
  { key: 'cost', label: 'Cost' },
  { key: 'tna', label: 'TNA' },
  { key: 'sku', label: 'SKU quantities' },
] as const;
export type PoReworkSection = typeof PO_REWORK_SECTIONS[number]['key'];
type ReworkPo = { status?: unknown; rework_sections?: unknown };
export function parsePoReworkSections(value: unknown): PoReworkSection[] | null {
  if (!Array.isArray(value) || !value.length ||
    value.some((key) => !PO_REWORK_SECTIONS.some((section) => section.key === key))) return null;
  return PO_REWORK_SECTIONS.filter((section) => value.includes(section.key)).map((section) => section.key);
}
export function scopedPoRework(po: ReworkPo | null | undefined) {
  return po?.status === 'rework' ? parsePoReworkSections(po.rework_sections) : null;
}
export function canEditPoSection(po: ReworkPo | null | undefined, section: PoReworkSection) {
  const sections = scopedPoRework(po);
  return !sections || sections.includes(section);
}
export function poReworkLabel(value: unknown) {
  const sections = parsePoReworkSections(value);
  return PO_REWORK_SECTIONS.filter((section) => sections?.includes(section.key)).map((section) => section.label).join(', ');
}
export const PO_COST_FIELDS = ['cost_sheet_url', 'rate', 'grey_cost', 'finished_fabric_cost', 'cm_cost', 'margin_pct'];
export function poReworkFieldAllowed(key: string, sections: PoReworkSection[]) {
  return (sections.includes('cost') && PO_COST_FIELDS.includes(key)) ||
    (sections.includes('tna') && (key === 'tna_sheet_url' || key.startsWith('tna_days_') ||
      ['tna_base_date', 'cs_pp_sample_due', 'cs_gpt_due', 'cs_cutting_start', 'cs_inline_qc_due', 'critical_path_first_delivery', 'po_closing_date'].includes(key)));
}

export function awaitingTnaReworkSave(po: { status?: unknown; rework_sections?: unknown; tna_rework_saved_at?: unknown; reworked_at?: unknown } | null | undefined) {
  if (!scopedPoRework(po)?.includes('tna')) return false;
  // Keep the existing workflow usable until the saved-state migration is deployed.
  if (!Object.prototype.hasOwnProperty.call(po, 'tna_rework_saved_at')) return false;
  const saved = typeof po?.tna_rework_saved_at === 'string' ? Date.parse(po.tna_rework_saved_at) : NaN;
  const sent = typeof po?.reworked_at === 'string' ? Date.parse(po.reworked_at) : NaN;
  return !Number.isFinite(saved) || (Number.isFinite(sent) && saved < sent);
}
