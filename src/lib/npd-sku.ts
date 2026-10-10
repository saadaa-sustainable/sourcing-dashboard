/**
 * Reading the colour codes out of an NPD Tracker V7 "SKU code" cell, for PO Approval's SKU grid
 * (a product added from NPD has no colours in EasyEcom yet).
 *
 * The cell is typed by hand in three shapes, all seen on the tracker:
 *   "MCSKRM"                          one colour code
 *   "MRESHBG,MRESHYE,MRESHDA"         full colour codes, comma / space separated
 *   "UHFTPWT JB MG MB RT OW DO DM"    one full code, then the other colours as suffixes on the
 *                                     same base (UHFTP + JB → UHFTPJB)
 * Anything that fits none of these is returned in `unread` so the screen can say so; it is never
 * guessed into a code. The team checks the list and can always paste their own codes.
 */

export type NpdSkuRead = {
  /** Colour codes (product variants), upper-cased, in the order written. */
  variants: string[];
  /** Pieces of the cell that could not be read as a code. */
  unread: string[];
};

const CODE = /^[A-Z0-9]{4,}$/;
const SUFFIX = /^[A-Z0-9]{1,3}$/;

export function readNpdSkuCodes(raw: string | null | undefined): NpdSkuRead {
  const tokens = (raw ?? '')
    .toUpperCase()
    .split(/[\s,;/|]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (!tokens.length) return { variants: [], unread: [] };

  const out: string[] = [];
  const unread: string[] = [];
  const push = (v: string) => {
    if (!out.includes(v)) out.push(v);
  };

  // Shape 3: first token a full code, the rest short suffixes of one length.
  const [first, ...rest] = tokens;
  const suffixes = rest.filter((t) => SUFFIX.test(t));
  if (CODE.test(first) && rest.length > 0 && suffixes.length > 0 && rest.every((t) => SUFFIX.test(t) || CODE.test(t))) {
    // The suffix length most of them share (2 on the tracker today).
    const counts = new Map<number, number>();
    for (const s of suffixes) counts.set(s.length, (counts.get(s.length) ?? 0) + 1);
    const k = [...counts].sort((a, b) => b[1] - a[1])[0][0];
    const base = first.length > k ? first.slice(0, first.length - k) : '';
    push(first);
    for (const t of rest) {
      if (CODE.test(t)) push(t);
      else if (base && t.length === k) push(base + t);
      else unread.push(t);
    }
    return { variants: out, unread };
  }

  // Shapes 1 and 2: every token is a full code.
  for (const t of tokens) {
    if (CODE.test(t)) push(t);
    else unread.push(t);
  }
  return { variants: out, unread };
}

/** NPD's size cell ("S,M,L,XL" / "M") as upper-cased sizes. */
export function readNpdSizes(raw: string | null | undefined): string[] {
  return [...new Set((raw ?? '').toUpperCase().split(/[\s,;/|]+/).map((s) => s.trim()).filter(Boolean))];
}

/** NPD's colours_by_code JSON ([{"color":"BOTTLE GREEN","code":"BG"}]) as code → colour name. */
export function readNpdColours(raw: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  try {
    const list = JSON.parse(raw) as { color?: string; code?: string }[];
    if (!Array.isArray(list)) return out;
    for (const c of list) {
      const code = (c.code ?? '').trim().toUpperCase();
      const name = (c.color ?? '').trim();
      if (code && name) out[code] = name;
    }
  } catch {
    /* not JSON: no names */
  }
  return out;
}
