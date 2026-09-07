/**
 * Data-source themes — colour-code every field / column / table by where its
 * data actually comes from, so a reader can see the provenance at a glance
 * (inspired by the Daily Tracker's per-column source bars + legend).
 *
 * Raw-pipeline taxonomy (the team's choice): EasyEcom · BigQuery · GCP ·
 * Google Form/Sheet · Dashboard (Supabase), plus a neutral "Computed" for values
 * derived from the others. Colours are picked to stay distinct in light theme.
 */
export type DataSourceKey =
  | 'easyecom'
  | 'bigquery'
  | 'gcp'
  | 'form'
  | 'supabase'
  | 'computed';

export const DATA_SOURCES: Record<
  DataSourceKey,
  { label: string; color: string; description: string }
> = {
  easyecom: {
    label: 'EasyEcom',
    color: '#3b6fd4', // blue
    description: 'System of record in EasyEcom — purchase orders, GRN, product & vendor master. Synced via GCP/BigQuery.',
  },
  bigquery: {
    label: 'BigQuery',
    color: '#20a88f', // teal
    description: 'Assembled in BigQuery — inventory / DOQ snapshots, sales windows, cutting register, manual adjustments.',
  },
  gcp: {
    label: 'GCP pipeline',
    color: '#7a5cf0', // violet
    description: 'Produced by the GCP data pipeline (Apps Script / BigQuery jobs) before landing in the dashboard.',
  },
  form: {
    label: 'Google Form / Sheet',
    color: '#e68950', // orange
    description: 'Captured in a Google Form or Sheet — TNA actuals, PO Details, sheet-driven masters.',
  },
  supabase: {
    label: 'Entered in dashboard',
    color: '#c0397b', // magenta
    description: 'Typed into the dashboard itself (Supabase sd_* tables) — buying plan, standard cost, approvals, capacity, receivable & inward plans.',
  },
  computed: {
    label: 'Computed',
    color: '#9a9384', // neutral grey
    description: 'Derived/calculated from the other sources — not stored, recomputed on load.',
  },
};

/** Distinct sources in first-appearance order — for a table/page legend. */
export function sourceOrder(keys: (DataSourceKey | undefined)[]): DataSourceKey[] {
  const seen: DataSourceKey[] = [];
  for (const k of keys) if (k && !seen.includes(k)) seen.push(k);
  return seen;
}
