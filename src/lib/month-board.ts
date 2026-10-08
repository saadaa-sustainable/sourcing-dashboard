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
  /** The month's overview (opened from the card): headline ring, tiles, analysis sections. */
  detail?: MonthBoardDetail;
};

/** One block of the month overview. */
export type MonthDetailSection =
  | {
      kind: 'bars';
      title: string;
      hint?: string;
      /** pct 0-100 (never above); `value` is the printed figure. */
      bars: { label: string; value: string; pct: number; tone?: MonthBoardColumn['tone'] }[];
      empty?: string;
    }
  | {
      kind: 'table';
      title: string;
      hint?: string;
      columns: { label: string; num?: boolean }[];
      rows: { cells: string[]; tone?: MonthBoardColumn['tone']; href?: string }[];
      empty?: string;
      /** Filter chips over the rows (by tone). */
      filters?: { label: string; tone: MonthBoardColumn['tone'] }[];
    }
  | {
      kind: 'timeline';
      title: string;
      hint?: string;
      events: { when: string; what: string; note?: string; tone?: MonthBoardColumn['tone'] }[];
      empty?: string;
    };

export type MonthBoardDetail = {
  /** e.g. "Buying Plan · FG" */
  kicker: string;
  /** One-line description under the title. */
  lede?: string;
  ring?: { pct: number; label: string; caption: string; sub?: string; over?: boolean };
  tiles: { label: string; value: string }[];
  sections: MonthDetailSection[];
};

export type MonthBoardData = {
  columns: MonthBoardColumn[];
  cards: MonthBoardCard[];
  totals: { value: string; label: string }[];
  /** "plans" / "months" */
  unit: string;
  /** What one card is, singular: "month" (default) or "week". */
  noun?: string;
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
