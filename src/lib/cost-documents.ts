/*
 * Standard Cost document attachments — shared definitions (plain module: imported by the
 * server actions, the loader and the client section alike).
 */

export const COST_DOC_BUCKET = 'cost-documents';
export const COST_DOC_MAX_BYTES = 25 * 1024 * 1024;

/** CAD / marker files, drawings, the input sheet and images. */
export const COST_DOC_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'dxf', 'plt', 'hpgl', 'mrk', 'cut', 'xlsx', 'xls', 'csv', 'zip'] as const;

export type CostDocGroup = 'single_piece' | 'full_layer_58' | 'full_layer_56' | 'standard_ratio' | 'ratio_1_1';

/**
 * The CAD plan library: four primary headers; "Full layer, single size, per width" keeps
 * each width separate (58" and 56").
 */
export const CAD_HEADERS: { key: string; title: string; hint: string; slots: { group: CostDocGroup; label: string }[] }[] = [
  { key: 'single', title: 'Single piece', hint: 'One garment laid out on its own.', slots: [{ group: 'single_piece', label: 'Single piece' }] },
  {
    key: 'full_layer',
    title: 'Full layer · single size per width',
    hint: 'A full lay of one size, planned for each fabric width — 58″ and 56″ kept separate.',
    slots: [
      { group: 'full_layer_58', label: '58″ width' },
      { group: 'full_layer_56', label: '56″ width' },
    ],
  },
  { key: 'standard_ratio', title: 'Standard ratio', hint: 'The standard size-ratio lay.', slots: [{ group: 'standard_ratio', label: 'Standard ratio' }] },
  { key: 'ratio_1_1', title: '1:1 size ratio', hint: 'Every size once, in a 1:1 ratio.', slots: [{ group: 'ratio_1_1', label: '1:1 size ratio' }] },
];

export const COST_DOC_GROUP_LABEL: Record<CostDocGroup, string> = {
  single_piece: 'Single piece',
  full_layer_58: 'Full layer · 58″ width',
  full_layer_56: 'Full layer · 56″ width',
  standard_ratio: 'Standard ratio',
  ratio_1_1: '1:1 size ratio',
};

export const isCostDocGroup = (v: string): v is CostDocGroup => v in COST_DOC_GROUP_LABEL;

export type CostDocument = {
  id: number;
  product_code: string;
  doc_group: CostDocGroup;
  file_name: string;
  file_size: number | null;
  remark: string | null;
  created_by: string | null;
  created_at: string;
};

/** Extension of a file name (lower case), or ''. */
export function fileExt(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(name.trim());
  return m ? m[1].toLowerCase() : '';
}

export function costDocFileError(name: string, size: number): string | null {
  if (!(COST_DOC_EXTENSIONS as readonly string[]).includes(fileExt(name))) {
    return `This file type is not accepted. Use ${COST_DOC_EXTENSIONS.map((e) => e.toUpperCase()).join(', ')}.`;
  }
  if (!(size > 0)) return 'The file is empty.';
  if (size > COST_DOC_MAX_BYTES) return 'The file is larger than 25 MB.';
  return null;
}
