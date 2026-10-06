// The month board (Buying Plan, Vendor Capacity, Inward Plan landing views): one card per month
// in status columns, as Kanban / Cards / List. Plain module: the pages build these on the
// server, the board renders them on the client.

/** A column = a status. `tone` picks the colour: draft blue, pending amber, live green,
 *  back red, closed grey. */
export type MonthBoardColumn = {
  key: string;
  label: string;
  tone: 'draft' | 'pending' | 'live' | 'back' | 'closed';
  hint: string;
};

export type MonthBoardCard = {
  id: string;
  /** YYYY-MM-01, for sorting. */
  month: string;
  /** "Oct 2026" */
  label: string;
  /** e.g. "FG" / "Material" */
  track?: string;
  /** A MonthBoardColumn key. */
  status: string;
  /** The headline figure, top right. */
  big: { value: string; label: string };
  /** One line under the month. */
  sub?: string;
  /** A progress bar: text left, text right, fill 0-100 (never shown above 100). */
  progress?: { left: string; right: string; pct: number; over?: boolean };
  /** Small coloured counts (e.g. 41 pending · 5 approved). */
  split?: { label: string; tone: MonthBoardColumn['tone'] }[];
  facts: string[];
  warn?: { text: string; tone: 'pending' | 'back' };
  actions: { label: string; href: string; primary?: boolean }[];
  /** Values for the List view, in the order of the board's listColumns. */
  list: string[];
};

export type MonthBoardData = {
  columns: MonthBoardColumn[];
  cards: MonthBoardCard[];
  totals: { value: string; label: string }[];
  /** "plans" / "months" */
  unit: string;
  listColumns: { label: string; num?: boolean }[];
};

/** Indian money, short: ₹46.76 L, ₹1.67 Cr. */
export function inrShort(v: number | null | undefined): string {
  if (v == null) return '—';
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`;
  return `₹${Math.round(v).toLocaleString('en-IN')}`;
}

export const num = (v: number | null | undefined) => (v == null ? '—' : Math.round(v).toLocaleString('en-IN'));
