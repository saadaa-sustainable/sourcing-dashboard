import { CAD_HEADERS, COST_DOC_MAX_BYTES, type CostDocGroup } from './cost-documents';
export const PO_CAD_BUCKET = 'po-cad-plans';
export const PO_CAD_MAX_BYTES = COST_DOC_MAX_BYTES;
export type PoCadDocument = {
  id: number; po_id: number; file_name: string; file_path: string; file_size: number;
  doc_group: CostDocGroup; width: string | null; remark: string | null;
  created_by: string; created_at: string; uploaded_at: string | null; removed_at: string | null; removed_by: string | null;
};
export type PoCadUploadInput = { name: string; size: number; group: string; width: string; remark: string };
export function poCadFileError(input: PoCadUploadInput): string | null {
  if (!input.name?.trim() || input.name.length > 255 || !/\.pdf$/i.test(input.name)) return 'Choose a CAD PDF file.';
  if (!Number.isInteger(input.size) || input.size <= 0 || input.size > PO_CAD_MAX_BYTES) return 'CAD PDFs must be non-empty and no larger than 25 MB.';
  if (!CAD_HEADERS.some(group => group.key === input.group)) return 'Choose a valid CAD plan type.';
  if (input.group === 'full_layer' && (!input.width?.trim() || input.width.length > 20 || !Number.isFinite(Number(input.width)) || Number(input.width) <= 0)) return 'Enter a positive fabric width in inches for the full-layer plan.';
  if ((input.remark ?? '').length > 2000) return 'Keep the CAD remark within 2,000 characters.';
  return null;
}
