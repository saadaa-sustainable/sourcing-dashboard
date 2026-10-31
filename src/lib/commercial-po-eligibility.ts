/** Purchase orders created after 31 March 2026 (whole calendar date). */
export const COMMERCIAL_PO_CREATED_FROM = '2026-04-01';
export function isCommercialPoEligible(po: { po_date: string | null; po_status: string | null }) {
  const day = po.po_date?.slice(0, 10);
  return (po.po_status === 'Approved' || po.po_status === 'Completed') &&
    Boolean(day && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && day >= COMMERCIAL_PO_CREATED_FROM);
}
