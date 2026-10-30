import type { PoApproval } from './forms/types';

export const PO_BOARD_STAGES = [
  { key: 'draft', label: 'Draft' },
  { key: 'rework', label: 'Rework' },
  { key: 'pending', label: 'Pending approval' },
  { key: 'approved', label: 'Approved, not yet on EasyEcom' },
  { key: 'on-easycom', label: 'On EasyEcom, receiving not started' },
  { key: 'receiving', label: 'Receiving in progress' },
] as const;

export type PoGrnReceipt = { po_number: string | null; po_ref_num: string | null; received_quantity: number | string | null };
export function poGrnReceiptIndex(receipts: PoGrnReceipt[]) {
  const poNumbers = new Set<string>();
  const references = new Set<string>();
  for (const receipt of receipts) {
    if (!(Number(receipt.received_quantity) > 0)) continue;
    const number = receipt.po_number?.trim();
    const reference = receipt.po_ref_num?.trim();
    if (number) poNumbers.add(number);
    if (reference) references.add(reference);
  }
  return {poNumbers, references};
}
export function hasPoGrnReceipt(
  po: { easycom_po_no: string | null; po_ref_num?: string | null },
  index: ReturnType<typeof poGrnReceiptIndex>,
) {
  const number = po.easycom_po_no?.trim();
  const reference = po.po_ref_num?.trim();
  return Boolean((number && index.poNumbers.has(number)) || (reference && index.references.has(reference)));
}
export function poBoardStage(
  po: Pick<PoApproval, 'status' | 'po_issued_at' | 'easycom_po_no'> & { po_ref_num?: string | null; first_actual_delivery_date?: string | null },
  hasReceivedGrn = false,
): typeof PO_BOARD_STAGES[number]['key'] | null {
  if (po.status === 'draft') return 'draft';
  if (po.status === 'rework') return 'rework';
  if (po.status === 'submitted' || po.status === 'pending_l2') return 'pending';
  if (po.status !== 'approved') return null;
  if (hasReceivedGrn) return 'receiving';
  if (!po.po_issued_at && !po.easycom_po_no?.trim() && !po.po_ref_num?.trim()) return 'approved';
  return 'on-easycom';
}
