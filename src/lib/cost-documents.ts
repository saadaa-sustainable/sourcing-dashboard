/*
 * Standard Cost document attachments — shared definitions (plain module: imported by the
 * server actions, the loader and the client section alike).
 */

export const COST_DOC_BUCKET = 'cost-documents';
export const COST_DOC_MAX_BYTES = 25 * 1024 * 1024;

/** CAD / marker files, drawings, the input sheet and images. */
export const COST_DOC_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'dxf', 'plt', 'hpgl', 'mrk', 'cut', 'xlsx', 'xls', 'csv', 'zip'] as const;

export type CostDocGroup = 'single_piece' | 'full_layer' | 'standard_ratio' | 'ratio_1_1';

/**
 * The CAD plan library: four primary headers. Every card takes files (several at once) and/or
 * shared links (user, 2026-10-09); "Full layer · single size per width" also asks for the
 * fabric width of each entry — as many widths as the product is cut in.
 */
export const CAD_HEADERS: { key: CostDocGroup; title: string; hint: string; byWidth: boolean }[] = [
  { key: 'single_piece', title: 'Single piece', hint: 'One garment laid out on its own.', byWidth: false },
  { key: 'full_layer', title: 'Full layer · single size per width', hint: 'A full lay of one size for each fabric width.', byWidth: true },
  { key: 'standard_ratio', title: 'Standard ratio', hint: 'The standard size-ratio lay.', byWidth: false },
  { key: 'ratio_1_1', title: '1:1 size ratio', hint: 'Every size once, in a 1:1 ratio.', byWidth: false },
];

/** Fabric widths offered when adding a Full layer plan (any other width can be typed). */
export const COMMON_WIDTHS = ['44', '54', '56', '58', '60', '63', '72'];

/** "58" → "58″"; anything already carrying a unit is shown as typed. */
export const widthLabel = (w: string | null) => (!w ? '—' : /^\d+(\.\d+)?$/.test(w.trim()) ? `${w.trim()}″` : w.trim());

export const COST_DOC_GROUP_LABEL: Record<CostDocGroup, string> = {
  single_piece: 'Single piece',
  full_layer: 'Full layer · single size per width',
  standard_ratio: 'Standard ratio',
  ratio_1_1: '1:1 size ratio',
};

/** Width as stored: trimmed, a trailing inch mark / "in" dropped, at most 20 characters. */
export const cleanWidth = (w: string) => w.trim().replace(/\s*(["″]|in(ch(es)?)?)$/i, '').slice(0, 20);

export const isCostDocGroup = (v: string): v is CostDocGroup => v in COST_DOC_GROUP_LABEL;

export type CostDocument = {
  id: number;
  product_code: string;
  doc_group: CostDocGroup;
  /** Uploaded file; null for a shared link. */
  file_name: string | null;
  /** Full layer: the fabric width (e.g. '58'). A shared link instead of a file. */
  width: string | null;
  link_url: string | null;
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
