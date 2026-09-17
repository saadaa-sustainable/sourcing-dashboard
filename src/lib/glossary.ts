/**
 * Every short form this dashboard uses, in plain words.
 *
 * Why this file exists: none of these terms was written out anywhere in the product. Someone
 * who has not sat in the meetings reads "DOQ 45" or "PO Not Closed on EE" and has to ask, and
 * a person who has to ask twice stops using the screen. One definition lives here and every
 * screen points at it, so the wording cannot drift apart between pages.
 *
 * Rules for adding a term:
 *  - Write it for someone on their first week, not for the person who coined it.
 *  - Say what it IS, then what it is used for. No other short forms inside the definition.
 *  - If nobody can say what it stands for, set `needsDefinition` rather than inventing one.
 *    A wrong expansion is worse than an honest gap, because it gets repeated.
 */
export type GlossaryTerm = {
  term: string;
  expansion: string;
  meaning: string;
  /** True while the team still has to confirm what this stands for. */
  needsDefinition?: boolean;
};

export const GLOSSARY: GlossaryTerm[] = [
  {
    term: 'PO',
    expansion: 'Purchase Order',
    meaning:
      'One order placed on a vendor. A PO covers several products and sizes, so one PO usually has many lines.',
  },
  {
    term: 'TNA',
    expansion: 'Time and Action',
    meaning:
      'The production calendar for a PO: each stage, from sample through cutting to delivery, has a planned date. A stage whose planned date has passed with no actual date is what makes a PO High Risk.',
  },
  {
    term: 'EDD',
    expansion: 'Expected Delivery Date',
    meaning:
      'The date goods are due from the vendor. A PO past its EDD with quantity still pending is Overdue.',
  },
  {
    term: 'GRN',
    expansion: 'Goods Receipt Note',
    meaning:
      'The record raised when goods physically arrive at the warehouse. Everything the dashboard calls "received" is counted from these.',
  },
  {
    term: 'OTIF',
    expansion: 'On Time In Full',
    meaning:
      'A completed PO counts as OTIF only if it arrived on or before its expected date AND nothing was left short. On time but short does not count, and neither does complete but late.',
  },
  {
    term: 'SKU',
    expansion: 'Stock Keeping Unit',
    meaning:
      'One sellable item at its finest level: a product in one colour and one size. A product code covers many SKUs.',
  },
  {
    term: 'FOB',
    expansion: 'Free On Board',
    meaning:
      'The vendor buys the fabric and trims and delivers a finished garment, so the price covers the whole garment.',
  },
  {
    term: 'Job work',
    expansion: 'Job work (cut, make and trim)',
    meaning:
      'We supply the fabric and the vendor only stitches. The rate covers labour, not the garment, which is why job-work rates are far lower than FOB and the two must never be added together as if they were the same money.',
  },
  {
    term: 'CMTP',
    expansion: 'Cut, Make, Trim, Pack',
    meaning:
      'The make-up cost of a garment built up from its heads: labour, cutting, finishing, trims and packing. Added to fabric cost, it gives the final standard cost.',
  },
  {
    term: 'NPD',
    expansion: 'New Product Development',
    meaning:
      'A product still being developed. "NPD - Not Launched Yet" has never been on sale, so it cannot be short against demand it does not yet have.',
  },
  {
    term: 'OOS',
    expansion: 'Out of Stock',
    meaning: 'No sellable stock on hand for that variant.',
  },
  {
    term: 'ROP',
    expansion: 'Re-Order Point',
    meaning:
      'The stock level at which a fresh order should be placed so goods arrive before the shelf empties.',
  },
  {
    term: 'A, B, C, D',
    expansion: 'Sales class',
    meaning:
      'How fast a variant sells: A is the fastest, D the slowest. It is separate from the product state. A product being discontinued is a state, not a class, and a D product is a slow seller, not one on its way out.',
  },
  {
    term: 'EasyCom',
    expansion: 'EasyEcom',
    meaning:
      'The system of record for purchase orders and stock. When a screen says a PO is not closed there, it means the goods are in but the order has not been marked finished.',
  },
  {
    term: 'SLA',
    expansion: 'Service Level Agreement',
    meaning:
      'The number of days a step is allowed to take before it counts as late. Closure SLA days is set in Rules Master.',
  },
  {
    term: 'PPM',
    expansion: 'Pre-Production Meeting',
    meaning:
      'The check held with the vendor before bulk production starts, covering the sample, fabric and trims.',
  },
  {
    term: 'DOQ',
    expansion: 'not yet confirmed',
    meaning:
      'Used across the replenishment and stock screens as DOQ 15, 30, 45 and 365. Nobody has written down what the letters stand for, so it is left undefined here rather than guessed at.',
    needsDefinition: true,
  },
  {
    term: 'IPDOQ',
    expansion: 'not yet confirmed',
    meaning:
      'In-process DOQ: the 45-day figure, or the higher of the 45 and 365-day figures when the 45-day window was mostly out of stock. Depends on DOQ, which is itself unconfirmed.',
    needsDefinition: true,
  },
  {
    term: 'E-FOB',
    expansion: 'not yet confirmed',
    meaning:
      'A third PO type sitting between job work and FOB, priced close to FOB and carrying a 45-day lead time against FOB’s 75. What the E stands for has not been written down.',
    needsDefinition: true,
  },
  {
    term: 'COM status',
    expansion: 'not yet confirmed',
    meaning:
      'A grouping key that joins a product state and a sales class, for example "Ongoing-A". What COM stands for has not been written down.',
    needsDefinition: true,
  },
];

/** Terms the team still has to define, so the gaps are visible rather than quietly carried. */
export const UNDEFINED_TERMS = GLOSSARY.filter((t) => t.needsDefinition);
