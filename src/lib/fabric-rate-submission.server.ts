import { createClient } from '@/lib/supabase/server';

/**
 * Item 5 — monthly fabric-rate submission status. For each fabric in the cost base,
 * whether it has been reviewed THIS month (a rate update or an explicit "no change")
 * and its current live rates. The pending list is the persistent mandatory-task
 * surface: fabrics with no submission for the current month.
 */
export type FabricRateStatus = {
  fabric_code: string;
  grey_rate: number | null;
  finished_rate: number | null;
  submittedThisMonth: boolean;
  noChange: boolean;
  submittedBy: string | null;
  submittedAt: string | null;
};

export type FabricRateSubmissionState = {
  /** First-of-month (YYYY-MM-DD) the current requirement covers. */
  month: string;
  rows: FabricRateStatus[];
  pendingCount: number;
};

function currentMonthStart(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

export async function loadFabricRateSubmissionState(): Promise<FabricRateSubmissionState> {
  const supabase = await createClient();
  const month = currentMonthStart();

  const [{ data: base }, { data: subs }] = await Promise.all([
    supabase
      .from('sd_fabric_cost_base')
      .select('fabric_code, grey_rate, finished_fabric_cost')
      .order('fabric_code'),
    supabase
      .from('sd_fabric_rate_submission')
      .select('fabric_code, no_change, submitted_by, submitted_at')
      .eq('month', month),
  ]);

  const subByCode = new Map(
    (subs ?? []).map((s) => [String(s.fabric_code), s]),
  );

  const rows: FabricRateStatus[] = (base ?? []).map((f) => {
    const sub = subByCode.get(String(f.fabric_code));
    return {
      fabric_code: String(f.fabric_code),
      grey_rate: f.grey_rate == null ? null : Number(f.grey_rate),
      finished_rate: f.finished_fabric_cost == null ? null : Number(f.finished_fabric_cost),
      submittedThisMonth: Boolean(sub),
      noChange: Boolean(sub?.no_change),
      submittedBy: sub?.submitted_by ?? null,
      submittedAt: sub?.submitted_at ?? null,
    };
  });

  return {
    month,
    rows,
    pendingCount: rows.filter((r) => !r.submittedThisMonth).length,
  };
}
