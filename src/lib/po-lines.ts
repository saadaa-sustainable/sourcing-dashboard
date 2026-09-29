/**
 * Spec 7.2 — SKU-level quantity entry for a PO.
 *
 * The old way (add a row, type the colour, type the size, type the quantity, repeat) was
 * rejected: the team already has the numbers in Excel. This module is the pure part of the
 * three accepted ways in — paste, matrix, CSV — so all three land on the same rows and the
 * parsing is unit-tested rather than discovered in production.
 *
 * Paste handles both shapes people actually copy:
 *   • a LIST     — colour, size, qty (any column order when a header row is present)
 *   • a MATRIX   — sizes across the top, one colour per row, quantities in the cells
 * Tabs, commas and multiple spaces all separate; ₹, thousands separators and blank cells
 * are tolerated. Nothing is silently dropped: every unusable cell comes back as an issue.
 */

export type PoLineDraft = { product_variant: string; size: string; qty: number };

export type ParseIssue = { row: number; text: string; reason: string };

export type ParseResult = {
  shape: 'list' | 'matrix' | 'empty';
  rows: PoLineDraft[];
  issues: ParseIssue[];
  /** Column order the list parser settled on, for the "what we read" line in the UI. */
  columns?: { variant: number; size: number; qty: number };
};

/** Sizes the team uses. Anything else is still accepted — this list only helps detection. */
export const KNOWN_SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', 'FREE', 'NA'];

const SIZE_SET = new Set(KNOWN_SIZES);

/** "2,400" / "₹2400" / " 2400 " → 2400; anything not a number → null. */
export function toQty(raw: string): number | null {
  const s = raw.replace(/[₹,\s]/g, '').replace(/\.0+$/, '');
  if (!s) return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n) : null;
}

const norm = (s: string) => s.trim();
const upper = (s: string) => norm(s).toUpperCase();

/** Split a pasted block into cells: tabs win, then commas, then runs of 2+ spaces. */
function splitRows(text: string): string[][] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim() !== '');
  return lines.map((line) => {
    if (line.includes('\t')) return line.split('\t').map(norm);
    if (line.includes(',')) return line.split(',').map(norm);
    return line.split(/\s{2,}/).map(norm);
  });
}

const VARIANT_WORDS = ['variant', 'colour', 'color', 'sku', 'style', 'product'];
const SIZE_WORDS = ['size'];
const QTY_WORDS = ['qty', 'quantity', 'pcs', 'pieces', 'nos'];

const headerIndex = (cells: string[], words: string[]) =>
  cells.findIndex((c) => words.some((w) => upper(c).includes(w.toUpperCase())));

/**
 * A size heading as the team writes it: "S", "(3) M", "2XL ", "Size XL" → the size itself.
 * The bracketed number is the sheet's column index and means nothing here.
 */
export function sizeOfHeading(raw: string): string | null {
  const s = upper(raw).replace(/^\(\s*\d+\s*\)\s*/, '').replace(/^SIZE\s+/, '').replace(/\s+/g, '');
  return SIZE_SET.has(s) ? s : null;
}

/**
 * Where the header row is and what each column holds, for a size-across-the-top grid.
 * The header may sit a few rows down — the team's PO sheet has the product name and a
 * per-size consumption row above it — and may carry identifier columns on the left
 * (vendor code, product code, dyed fabric SKU, colour) and totals on the right.
 */
type MatrixLayout = {
  header: number;
  sizes: { col: number; size: string }[];
  variantCol: number; // a column that already holds the colour / variant code
  productCol: number; // PRODUCT CODE
  dyedCol: number; // DYED FABRIC SKU — its last segment is the colour code
  colourCol: number; // COLOR / COLOUR — a colour name
};

const has = (c: string, ...words: string[]) => words.some((w) => upper(c).includes(w));

function findMatrix(cells: string[][]): MatrixLayout | null {
  for (let h = 0; h < Math.min(cells.length - 1, 8); h++) {
    const head = cells[h];
    const sizes = head.map((c, col) => ({ col, size: sizeOfHeading(c) })).filter((x): x is { col: number; size: string } => !!x.size);
    if (sizes.length < 2) continue;
    // The non-size headings must be few: identifier columns, a total or two. A list with a
    // "Size" column and lots of other columns is not a matrix.
    const nonSize = head.filter((c, i) => norm(c) && !sizes.some((s) => s.col === i));
    const firstSize = sizes[0].col;
    if (nonSize.length > firstSize + 3) continue;
    const idx = (...words: string[]) => head.findIndex((c, i) => i < firstSize && has(c, ...words));
    const productCol = idx('PRODUCT');
    const dyedCol = idx('DYED', 'FABRIC SKU');
    let colourCol = idx('COLOUR', 'COLOR');
    let variantCol = head.findIndex((c, i) => i < firstSize && has(c, 'VARIANT', 'SKU', 'STYLE') && i !== dyedCol);
    // No named identifier column at all (the plain "Colour  S  M  L" paste): the cell left
    // of the first size holds the code.
    if (variantCol < 0 && productCol < 0 && colourCol < 0 && dyedCol < 0) variantCol = firstSize > 0 ? firstSize - 1 : -1;
    // "Colour  S  M  L" with codes down the side: the colour column holds the code itself.
    if (variantCol < 0 && productCol < 0 && dyedCol < 0 && colourCol >= 0) { variantCol = colourCol; colourCol = -1; }
    if (variantCol < 0 && productCol < 0 && colourCol < 0) continue;
    return { header: h, sizes, variantCol, productCol, dyedCol, colourCol };
  }
  return null;
}

/** Colour name → variant code, e.g. { 'OLIVE GREEN': 'SDAVLKOG' } — from the product master. */
export type ColourMap = Record<string, string>;

/**
 * Work out the variant code for a grid row. Prefers a code that is already there; then
 * product code + the colour code at the end of the dyed-fabric SKU (20CF/63/OG → OG);
 * then the colour name looked up in the product master.
 */
function variantOfRow(line: string[], m: MatrixLayout, colours: ColourMap): { variant: string; why?: string } {
  const cell = (i: number) => (i >= 0 ? norm(line[i] ?? '') : '');
  const code = upper(cell(m.variantCol));
  if (code && !/\s/.test(code)) return { variant: code };
  const product = upper(cell(m.productCol));
  const dyed = upper(cell(m.dyedCol));
  const colour = upper(cell(m.colourCol));
  if (product && dyed.includes('/')) return { variant: product + dyed.slice(dyed.lastIndexOf('/') + 1) };
  if (colour && colours[colour]) return { variant: colours[colour] };
  if (product && colour) {
    const hit = Object.keys(colours).find((k) => k === colour);
    if (hit) return { variant: colours[hit] };
    return { variant: '', why: `colour "${colour}" is not on ${product}'s colour list — add the DYED FABRIC SKU column or use the variant code` };
  }
  if (product) return { variant: '', why: 'a product code but no colour' };
  return { variant: '', why: 'no colour / variant' };
}

/**
 * Parse pasted / uploaded text into PO lines. Never throws.
 * `colours` (optional) maps colour NAMES to variant codes for the product being ordered,
 * so the team's sheet — which names the colour rather than coding it — reads straight in.
 */
export function parsePastedLines(text: string, colours: ColourMap = {}): ParseResult {
  const cells = splitRows(text ?? '');
  if (!cells.length) return { shape: 'empty', rows: [], issues: [] };

  const m = findMatrix(cells);
  if (m) {
    const rows: PoLineDraft[] = [];
    const issues: ParseIssue[] = [];
    const colourKeys = Object.fromEntries(Object.entries(colours).map(([k, v]) => [upper(k), upper(v)]));
    cells.slice(m.header + 1).forEach((line, i) => {
      const rowNo = m.header + i + 2;
      if (!line.some((c) => norm(c))) return;
      const { variant, why } = variantOfRow(line, m, colourKeys);
      if (!variant) {
        // A totals row (numbers but no identifier) is the sheet's own arithmetic — skip it quietly.
        const onlyNumbers = line.every((c, j) => !norm(c) || m.sizes.some((s) => s.col === j) || toQty(c) != null);
        if (!onlyNumbers || why === 'a product code but no colour' || (why && why.startsWith('colour '))) {
          issues.push({ row: rowNo, text: line.filter(Boolean).join(' | '), reason: why ?? 'no colour / variant' });
        }
        return;
      }
      for (const { col, size } of m.sizes) {
        const raw = line[col] ?? '';
        if (!norm(raw)) continue; // an empty cell is simply "none of that size"
        const qty = toQty(raw);
        if (qty == null) {
          issues.push({ row: rowNo, text: `${variant} / ${size}: ${raw}`, reason: 'quantity is not a number' });
          continue;
        }
        if (qty > 0) rows.push({ product_variant: variant, size, qty });
      }
    });
    return { shape: 'matrix', rows: mergeLines(rows), issues };
  }

  // ---- list shape
  const first = cells[0];
  const hv = headerIndex(first, VARIANT_WORDS);
  const hs = headerIndex(first, SIZE_WORDS);
  const hq = headerIndex(first, QTY_WORDS);
  const hasHeader = hv >= 0 && hs >= 0 && hq >= 0;
  const columns = hasHeader ? { variant: hv, size: hs, qty: hq } : { variant: 0, size: 1, qty: 2 };
  const body = hasHeader ? cells.slice(1) : cells;

  const rows: PoLineDraft[] = [];
  const issues: ParseIssue[] = [];
  body.forEach((line, i) => {
    const rowNo = i + (hasHeader ? 2 : 1);
    const variant = upper(line[columns.variant] ?? '');
    const size = upper(line[columns.size] ?? '');
    const rawQty = line[columns.qty] ?? '';
    if (!variant && !size && !norm(rawQty)) return;
    if (!variant) {
      issues.push({ row: rowNo, text: line.join(' | '), reason: 'no colour / variant' });
      return;
    }
    const qty = toQty(rawQty);
    if (qty == null) {
      issues.push({ row: rowNo, text: line.join(' | '), reason: 'quantity is not a number' });
      return;
    }
    if (qty > 0) rows.push({ product_variant: variant, size, qty });
  });
  return { shape: 'list', rows: mergeLines(rows), issues, columns };
}

/** Same colour + size twice → one line with the quantities added. */
export function mergeLines(rows: PoLineDraft[]): PoLineDraft[] {
  const map = new Map<string, PoLineDraft>();
  for (const r of rows) {
    const key = `${r.product_variant}|${r.size}`;
    const cur = map.get(key);
    if (cur) cur.qty += r.qty;
    else map.set(key, { ...r });
  }
  return [...map.values()];
}

/* ------------------------------------------------------------------ */
/* Matrix view                                                         */
/* ------------------------------------------------------------------ */

/** Lines → a variant × size grid (for the matrix editor), keeping every size that has a line. */
export function toMatrix(
  rows: PoLineDraft[],
  variants: string[],
  sizes: string[],
): { variants: string[]; sizes: string[]; cell: (v: string, s: string) => number | '' } {
  const vs = [...new Set([...variants.map(upper), ...rows.map((r) => r.product_variant)])].filter(Boolean);
  const ss = [...new Set([...sizes.map(upper), ...rows.map((r) => r.size)])].filter(Boolean);
  const map = new Map(rows.map((r) => [`${r.product_variant}|${r.size}`, r.qty]));
  return { variants: vs, sizes: ss, cell: (v, s) => map.get(`${upper(v)}|${upper(s)}`) ?? '' };
}

/** A grid of typed values → lines, dropping blanks and zeroes. */
export function fromMatrix(grid: Record<string, Record<string, string>>): PoLineDraft[] {
  const rows: PoLineDraft[] = [];
  for (const [variant, bySize] of Object.entries(grid)) {
    for (const [size, raw] of Object.entries(bySize)) {
      const qty = toQty(String(raw ?? ''));
      if (qty != null && qty > 0) rows.push({ product_variant: upper(variant), size: upper(size), qty });
    }
  }
  return mergeLines(rows);
}

/* ------------------------------------------------------------------ */
/* Live match against pending quantity                                 */
/* ------------------------------------------------------------------ */

/* ---- Spec 7.5: quantities suggested from the buying plan ----------- */

/** One SKU and how much of the split it should take. */
export type MixCell = { product_variant: string; size: string; weight: number };

/**
 * Spread a plan quantity across SKUs.
 *
 * The buying plan approves a quantity for a PRODUCT, not per colour and size, so a
 * suggestion has to choose a shape. The weights carry that choice — normally the mix this
 * product was actually bought in before — and where there is no history every cell weighs
 * the same. Either way the pieces are conserved: the rows always add up to the total, with
 * the rounding remainder going to the largest fractions (largest-remainder method), so a
 * suggestion never quietly loses or invents pieces.
 */
export function distributeQty(total: number, cells: MixCell[]): PoLineDraft[] {
  const target = Math.max(0, Math.round(total));
  if (!target || !cells.length) return [];

  const weightSum = cells.reduce((s, c) => s + Math.max(0, c.weight), 0);
  // No history to go on: an even split is the honest default.
  const shares = cells.map((c) => (weightSum > 0 ? (Math.max(0, c.weight) / weightSum) * target : target / cells.length));

  const rows = cells.map((c, i) => ({
    product_variant: c.product_variant,
    size: c.size,
    qty: Math.floor(shares[i]),
    frac: shares[i] - Math.floor(shares[i]),
    i,
  }));
  let left = target - rows.reduce((s, r) => s + r.qty, 0);
  // Largest fractional part first; ties go to the earlier cell so the result is stable.
  const order = [...rows].sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const r of order) {
    if (left <= 0) break;
    r.qty += 1;
    left -= 1;
  }
  return rows
    .filter((r) => r.qty > 0)
    .map((r) => ({ product_variant: r.product_variant, size: r.size, qty: r.qty }));
}

export type SkuPending = { sku: string; product_variant: string; size: string; pendingQty: number };

export type LineCheck = PoLineDraft & {
  sku: string;
  /** Pieces already pending on open POs for this SKU. */
  pendingQty: number;
  /** qty − pendingQty. Positive = this PO orders more than is still outstanding. */
  delta: number;
  /** True when the SKU is not on the product's active variant list. */
  unknownVariant: boolean;
};

export const skuOf = (variant: string, size: string) =>
  size ? `${upper(variant)}_${upper(size)}` : upper(variant);

/**
 * Match the typed lines against what is already pending at SKU level — the comparison the
 * spec asks for ("pending quantity 100 pieces है, आप 200 pieces क्यों बनवा रहे हो").
 */
export function checkLines(
  rows: PoLineDraft[],
  pending: SkuPending[],
  knownVariants: string[] = [],
): { checks: LineCheck[]; totalQty: number; totalPending: number; over: number } {
  const pendingBySku = new Map(pending.map((p) => [upper(p.sku), p.pendingQty]));
  const known = new Set(knownVariants.map(upper));
  const checks = rows.map((r) => {
    const sku = skuOf(r.product_variant, r.size);
    const pendingQty = pendingBySku.get(sku) ?? 0;
    return {
      ...r,
      sku,
      pendingQty,
      delta: r.qty - pendingQty,
      unknownVariant: known.size > 0 && !known.has(upper(r.product_variant)),
    };
  });
  return {
    checks,
    totalQty: checks.reduce((s, c) => s + c.qty, 0),
    totalPending: checks.reduce((s, c) => s + c.pendingQty, 0),
    over: checks.filter((c) => c.delta > 0 && c.pendingQty > 0).length,
  };
}
