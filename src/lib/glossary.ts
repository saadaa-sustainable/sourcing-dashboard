/**
 * Names this dashboard invented, in plain words.
 *
 * Deliberately NOT a dictionary of the trade. DOQ, EE, TNA, FOB, GRN, SKU and the rest are
 * what the team says every day and they need no explaining; renaming them would only make the
 * screens harder to read.
 *
 * The confusion comes from the other direction: headings coined in this project that exist
 * nowhere in the base data. Nobody has heard them in a meeting, so a reader has no way to
 * work out what they mean, and — as "Capital at Risk" showed — a coined name can also quietly
 * change what a number counts. Every one of them has to earn its place by being obvious on
 * sight.
 *
 * Rules for anything added here:
 *  - If a base-data term already says it, use that term and do not coin a new one.
 *  - A coined name must say what the number counts, in the unit it counts in.
 *  - If the name still needs a sentence of explanation to be understood, it is the wrong
 *    name. Fix the name rather than adding the sentence.
 */
export type CoinedTerm = {
  /** The heading as it appears on screen. */
  term: string;
  /** Where the reader meets it. */
  where: string;
  /** What it actually counts or measures, in plain words. */
  meaning: string;
  /** Base-data wording it maps to, when there is one. */
  basedOn?: string;
};

export const COINED_TERMS: CoinedTerm[] = [
  {
    term: 'Objectives',
    where: 'Main dashboard, first tab',
    meaning:
      'The five standing problems worth checking every day: high risk purchase orders, overdue purchase orders, stock out risk, out of stock, and on time in full.',
  },
  {
    term: 'Open orders today',
    where: 'Main dashboard, second tab',
    meaning:
      'Everything still on order: how many purchase orders are open, what quantity and value sit behind them, and the delivery charts.',
  },
  {
    term: 'Will we run out',
    where: 'Main dashboard tab',
    meaning:
      'Replenishment pressure and what is landing: whether stock plus what is on order covers demand.',
  },
  {
    term: 'Buying to plan',
    where: 'Main dashboard tab',
    meaning:
      'How much of the buying plan has actually been committed, plus approval and closure progress against it.',
  },
  {
    term: 'Who we buy from',
    where: 'Main dashboard tab',
    meaning: 'Vendor capacity against demand, how concentrated the book is, and who delivers on time.',
  },
  {
    term: 'Trust the numbers',
    where: 'Main dashboard tab',
    meaning:
      'The master data and feeds behind every figure: how fresh each sync is, and anything still on order that should not be.',
  },
  {
    term: 'Stock Out Risk',
    where: 'Objectives',
    meaning:
      'Variants that will run out before new goods can arrive: either nothing in stock and nothing on order, or cover that runs out inside the 45-day lead time.',
    basedOn: 'current stock, in process, daily demand',
  },
  {
    term: 'Nothing on order',
    where: 'Urgent Replenishment',
    meaning:
      'A count of product codes whose purchase order lines have all been received, so nothing is left on order. Not a count of purchase orders, not a quantity, and not a stock figure.',
  },
  {
    term: 'In Process (365d)',
    where: 'Urgent Replenishment',
    meaning:
      'A count of open purchase order lines with quantity due within the next 365 days, including lines already overdue.',
  },
  {
    term: 'Live coverage',
    where: 'Buying to plan',
    meaning:
      'Two figures side by side for the current month: how much of the buying plan value has been issued, and how much of the planned inward quantity has actually been received.',
  },
  {
    term: 'Buying Plan Realization',
    where: 'Buying to plan',
    meaning:
      'Planned buying value against purchase order value actually issued, by month and weave.',
  },
  {
    term: 'Sales class',
    where: 'Stock screens',
    meaning:
      'The A to D banding by how fast a variant sells. A sells fastest, D slowest. Separate from the product state: a D product is a slow seller, not one being discontinued.',
    basedOn: 'A, B, C, D',
  },
  {
    term: '100% and over Utilised',
    where: 'Vendor Capacity',
    meaning:
      'A vendor whose in-process quantity has reached or passed its monthly purchase order capacity.',
  },
  {
    term: 'Standard Cost Base',
    where: 'Standard Cost cards',
    meaning:
      'The full cost record behind a rate: the make-up build-up, fabric cost, final cost and the history of accepted rates.',
  },
  {
    term: 'Cost Details',
    where: 'Standard Cost cards',
    meaning: 'Opens that product or material on its own page, where the cost can be read and changed.',
  },
];

/**
 * Coined names removed after review, kept so they are not reinvented.
 * "Capital at Risk" was never agreed and its percentile rule also hid high-risk purchase
 * orders of ordinary value, so both the name and the logic went.
 */
export const RETIRED_TERMS = ['Capital at Risk'];
