import { parseCsv } from './csv';

/**
 * Reading the team's cost sheet.
 *
 * The cost sheet is the document the costs are actually agreed on, and its link is already
 * filled in on every PO. Re-typing four numbers off it into the form is how they drift: the
 * sheet says 187.20 and the PO ends up saying 187, or 180, or last month's figure.
 *
 * So we read it. The sheet is laid out as two label/value blocks — a per-size grid on the
 * left with a "PO AVG" column, and a CMTP build-up on the right where the value sits beside
 * its label — and the figures are found by LABEL, never by cell position, because a sheet
 * grows rows as often as anyone adds a trim line.
 *
 * Nothing here decides anything: the numbers are handed to the form for a person to look at
 * and change. A figure that cannot be found stays null and is reported, never guessed.
 */

export type CostSheetFigures = {
  /** The PO reference written at the top of the sheet, if there is one. */
  poRef: string | null;
  productName: string | null;
  /** FINAL PRICE — what the PO pays per piece. */
  rate: number | null;
  /** FINAL CMTP, else the CMTP row. */
  cmCost: number | null;
  /** FABRIC COST — the finished fabric in the garment. */
  fabricCost: number | null;
  /** GREIGE RATE — often blank, and blank is an answer. */
  greyCost: number | null;
  /** DYED FABRIC COST per metre. */
  dyedFabricRate: number | null;
  totalGarmentCost: number | null;
  marginPct: number | null;
  paymentTermsDays: number | null;
  avgConsumption: number | null;
  /** FINAL PRICE per size, when the sheet carries a size row. */
  sizes: { size: string; finalPrice: number | null }[];
  /** Which column the averages were read from — "PO AVG" when the sheet has one. */
  avgColumnLabel: string | null;
  /** Anything the reader could not find or had to assume. */
  warnings: string[];
};

const EMPTY: CostSheetFigures = {
  poRef: null,
  productName: null,
  rate: null,
  cmCost: null,
  fabricCost: null,
  greyCost: null,
  dyedFabricRate: null,
  totalGarmentCost: null,
  marginPct: null,
  paymentTermsDays: null,
  avgConsumption: null,
  sizes: [],
  avgColumnLabel: null,
  warnings: [],
};

/** What `readCostSheet` hands back. Declared here because a 'use server' module cannot
 *  export a type — only async actions. */
export type CostSheetReadResult =
  | { ok: true; figures: CostSheetFigures; source: 'link' | 'paste' }
  | { ok: false; error: string };

/** Labels are compared with spacing, case and punctuation ignored — sheets are hand-typed. */
const norm = (v: string | undefined) =>
  (v ?? '')
    .replace(/ /g, ' ')
    .toUpperCase()
    .replace(/[^A-Z0-9%]+/g, ' ')
    .trim();

/** A number as a sheet writes it: "1,234.50", "Rs 120", "15%", "(45)". Blank stays null. */
export function sheetNumber(raw: string | undefined): number | null {
  const s = (raw ?? '').replace(/ /g, ' ').trim();
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s);
  const cleaned = s.replace(/[(),₹$]|INR|RS\.?/gi, '').replace(/%/g, '').trim();
  if (!cleaned || !/[0-9]/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

const SIZE_WORDS = new Set(['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', 'XXL', 'XXXL', 'FREE']);

/**
 * Split the sheet into cells, whichever way it arrived.
 *
 * A downloaded sheet is CSV; a sheet copied out of Google Sheets is TAB-separated, and
 * running that through a comma parser yields one enormous cell per line — every label match
 * then fails and the reader reports a sheet it cannot understand. Pasting is the common
 * route (most sheets are not link-shared), so both have to work.
 */
function toRows(text: string): string[][] {
  const sample = text.slice(0, 5000);
  const tabs = (sample.match(/\t/g) ?? []).length;
  const commas = (sample.match(/,/g) ?? []).length;
  if (tabs > 0 && tabs >= commas) {
    return text
      .split(/\r?\n/)
      .map((line) => line.split('\t').map((cell) => cell.replace(/^"([\s\S]*)"$/, '$1')));
  }
  return parseCsv(text);
}

/**
 * Pull the agreed figures out of a cost sheet exported as CSV.
 *
 * Give it the sheet's own CSV (the Google Sheets `export?format=csv` of the tab, or a
 * paste). Empty input and a sheet in an unexpected shape both come back with every figure
 * null and a warning saying so — the caller shows that rather than filling anything in.
 */
export function parseCostSheet(csvText: string): CostSheetFigures {
  const rows = toRows(csvText ?? '').map((r) => r.map((c) => (c ?? '').trim()));
  if (!rows.length) return { ...EMPTY, warnings: ['The cost sheet was empty.'] };

  const warnings: string[] = [];

  // The averages column. The sheet labels it "PO AVG"; without it we fall back to the last
  // number on each row, which is the same cell in every sheet seen so far — but say so.
  let avgCol: number | null = null;
  let avgColumnLabel: string | null = null;
  outer: for (const row of rows.slice(0, 8)) {
    for (let c = 0; c < row.length; c += 1) {
      const t = norm(row[c]);
      if (t === 'PO AVG' || t === 'AVG' || t === 'AVERAGE' || t === 'PO AVERAGE') {
        avgCol = c;
        avgColumnLabel = row[c].trim();
        break outer;
      }
    }
  }
  if (avgCol == null) warnings.push('No "PO AVG" column — read the last figure on each row instead.');

  /** The value for a label: the averages column for the left grid, the next filled cell for
   *  the right-hand build-up (where the number sits beside its label). */
  const valueFor = (match: (label: string) => boolean): number | null => {
    for (const row of rows) {
      for (let c = 0; c < row.length; c += 1) {
        if (!match(norm(row[c]))) continue;
        if (c === 0) {
          // The averages column, and nothing else: a blank row must read as blank. Rows run
          // clear across the sheet, so the right-hand CMTP block sits on the same lines —
          // scanning for "the last number on the row" would pick up a trim charge.
          if (avgCol != null) return sheetNumber(row[avgCol]);
          // No averages column: take the last number of the LEFT block, stopping at the
          // first label cell, which is where the next block begins.
          let last: number | null = null;
          for (let k = 1; k < row.length; k += 1) {
            const cell = row[k];
            if (!cell) continue;
            const v = sheetNumber(cell);
            if (v == null) break; // a label — the left block has ended
            last = v;
          }
          return last;
        }
        for (let k = c + 1; k < row.length; k += 1) {
          const v = sheetNumber(row[k]);
          if (v != null) return v;
        }
        return null;
      }
    }
    return null;
  };

  const exact = (label: string) => (t: string) => t === label;
  const has = (...words: string[]) => (t: string) => words.every((w) => t.includes(w));

  // FINAL PRICE is the rate; TOTAL is the computed cost before the final agreed figure, so
  // it is only a fallback.
  const rate = valueFor(has('FINAL', 'PRICE')) ?? valueFor(exact('TOTAL'));
  if (valueFor(has('FINAL', 'PRICE')) == null && rate != null) {
    warnings.push('No FINAL PRICE row — used the TOTAL row as the rate.');
  }

  // "DYED FABRIC COST" also contains "FABRIC COST", so the plain row is matched exactly.
  const fabricCost = valueFor(exact('FABRIC COST'));
  const dyedFabricRate = valueFor(has('DYED', 'FABRIC', 'COST'));
  const cmCost = valueFor(has('FINAL', 'CMTP')) ?? valueFor(exact('CMTP'));
  const greyCost = valueFor(has('GREIGE')) ?? valueFor(has('GREY', 'RATE'));
  const totalGarmentCost = valueFor(has('TOTAL', 'GARMENT', 'COST'));
  const avgConsumption = valueFor(has('CONSUMPTION'));
  const paymentTermsDays = valueFor(has('PAYMENT', 'TERMS'));

  // Margin: the vendor-margin line first; failing that, the percentage written into the
  // left grid's own label, e.g. "MARGIN (15%)".
  let marginPct = valueFor(has('VENDOR', 'MARGIN'));
  if (marginPct == null) {
    for (const row of rows) {
      const m = /MARGIN[^0-9]*([0-9]+(?:\.[0-9]+)?)\s*%/.exec(norm(row[0]));
      if (m) {
        marginPct = Number(m[1]);
        break;
      }
    }
  }

  // The size row, and the final price under each size.
  let sizes: CostSheetFigures['sizes'] = [];
  let productName: string | null = null;
  const sizeRowIdx = rows.findIndex(
    (row) => row.filter((c) => SIZE_WORDS.has(norm(c))).length >= 3,
  );
  if (sizeRowIdx >= 0) {
    const sizeRow = rows[sizeRowIdx];
    productName = sizeRow[0]?.trim() || null;
    const priceRow = rows.find((row) => has('FINAL', 'PRICE')(norm(row[0])));
    sizes = sizeRow
      .map((cell, c) => ({ size: cell.trim().toUpperCase(), c }))
      .filter((s) => SIZE_WORDS.has(norm(s.size)))
      .map((s) => ({ size: s.size, finalPrice: priceRow ? sheetNumber(priceRow[s.c]) : null }));
  }

  // The reference written at the top — a PO reference has slashes in it.
  const poRef = rows.slice(0, 3).map((r) => r[0]?.trim()).find((v) => v && v.includes('/')) ?? null;

  if (rate == null) warnings.push('No FINAL PRICE / TOTAL row was found — the rate could not be read.');
  if (cmCost == null) warnings.push('No CMTP row was found.');
  if (fabricCost == null) warnings.push('No FABRIC COST row was found.');

  return {
    poRef,
    productName,
    rate,
    cmCost,
    fabricCost,
    greyCost,
    dyedFabricRate,
    totalGarmentCost,
    marginPct,
    paymentTermsDays,
    avgConsumption,
    sizes,
    avgColumnLabel,
    warnings,
  };
}

/**
 * The CSV export address of a Google Sheets link, so a shared sheet can be read as it
 * stands. Returns null for anything that is not a Google Sheets URL — a link to a PDF or a
 * folder has to be pasted instead.
 */
export function costSheetCsvUrl(link: string | null | undefined): string | null {
  const url = (link ?? '').trim();
  if (!url) return null;
  const id = /docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(url)?.[1];
  if (!id) return null;
  // Keep the tab the person actually linked to; gid=0 is only a guess when none is given.
  const gid = /[#&?]gid=([0-9]+)/.exec(url)?.[1];
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${gid}` : ''}`;
}
