import 'server-only';
import { client, pageAll } from './_shared';
import { loadApprovedMaterialCosts, loadApprovedStandardCosts } from './standard-cost';
import { loadReplenishmentByProduct } from './replenishment-oos';
import { addMonths, capacityWeekStart, isPlanFrozen, monthStart } from '../approval';
import {
  inrShort,
  num,
  type MonthBoardCard,
  type MonthBoardColumn,
  type MonthBoardData,
  type MonthDetailSection,
} from '@/lib/month-board';

// The month boards: the landing view of Buying Plan, Vendor Capacity and Inward Plan.
// One card per month (per track for Buying Plan), built from the same tables the month
// screens read, so a card and the screen it opens never disagree. Each card also carries the
// month's overview (ring, tiles, analysis sections) shown when the card is opened.

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const short = (iso: string) => `${MON[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const long = (iso: string) =>
  `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const day = (ts: string | null) => {
  if (!ts) return null;
  const d = new Date(new Date(ts).getTime() + 5.5 * 3600_000); // IST
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
};
const dayYear = (ts: string | null) => {
  if (!ts) return '—';
  const d = new Date(new Date(ts).getTime() + 5.5 * 3600_000);
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
const daysSince = (ts: string) => Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 86_400_000));
const n = (v: unknown) => Number(v) || 0;

type Tone = MonthBoardColumn['tone'];

/** Approval-log rows read as a timeline (newest last). Actors are left out on purpose. */
type LogRow = { entity_type: string; entity_id: string; from_status: string | null; to_status: string | null; notes: string | null; created_at: string };
const STATUS_WORDS: Record<string, [string, Tone]> = {
  submitted: ['Submitted for approval', 'pending'],
  pending_l2: ['Passed to the second approver', 'pending'],
  approved: ['Approved', 'live'],
  rework: ['Sent back for rework', 'back'],
  rejected: ['Rejected', 'back'],
  draft: ['Reopened as draft', 'draft'],
};
function timeline(rows: LogRow[]) {
  return rows
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((r) => {
      const [what, tone] = STATUS_WORDS[r.to_status ?? ''] ?? [r.to_status ?? 'Updated', 'closed' as Tone];
      return { when: dayYear(r.created_at), what, note: r.notes ?? undefined, tone };
    });
}

async function loadLog(types: string[]) {
  const supabase = await client();
  return pageAll<LogRow>(() =>
    supabase
      .from('sd_approval_log')
      .select('entity_type, entity_id, from_status, to_status, notes, created_at')
      .in('entity_type', types)
      .order('id'),
  );
}

/* ------------------------------------------------------------------ */
/* Buying Plan                                                         */
/* ------------------------------------------------------------------ */

type PlanLine = {
  plan_id: number;
  product_code: string | null;
  product_status: string | null;
  job_work_qty: number | null;
  fob_qty: number | null;
  efob_qty: number | null;
  standard_value: number | null;
  line_status: string | null;
  material_type: string | null;
  colour: string | null;
  uom: string | null;
  rework_notes: string | null;
};

export async function loadBuyingPlanBoard(deadlineDay = 7): Promise<MonthBoardData> {
  const supabase = await client();
  const [plans, lines, actuals, costs, catalog, log, matCosts, demand] = await Promise.all([
    pageAll<{ id: number; plan_month: string; plan_type: string | null; status: string; submitted_at: string | null; approved_at: string | null; rework_notes: string | null; rejection_notes: string | null }>(() =>
      supabase.from('sd_buying_plan').select('id, plan_month, plan_type, status, submitted_at, approved_at, rework_notes, rejection_notes').order('id'),
    ),
    pageAll<PlanLine>(() =>
      supabase
        .from('sd_buying_plan_line')
        .select('plan_id, product_code, product_status, job_work_qty, fob_qty, efob_qty, standard_value, line_status, material_type, colour, uom, rework_notes')
        .order('id'),
    ),
    pageAll<{ product_code: string; plan_month: string; issued_qty: number | null; issued_value: number | null; po_count: number | null }>(() =>
      supabase.from('sd_po_actuals_by_product_month').select('product_code, plan_month, issued_qty, issued_value, po_count').order('plan_month').order('product_code'),
    ),
    loadApprovedStandardCosts(),
    pageAll<{ product_code: string; category: string | null }>(() =>
      supabase.from('sd_product_catalog').select('product_code, category').order('product_code'),
    ),
    loadLog(['buying_plan']),
    loadApprovedMaterialCosts(),
    loadReplenishmentByProduct(),
  ]);
  const materialPlans = new Set(plans.filter((p) => p.plan_type === 'material').map((p) => p.id));
  const categoryOf = new Map(catalog.map((c) => [c.product_code.trim().toUpperCase(), c.category || 'Uncategorised']));
  // Same value rule as the plan screen: once submitted, a line's value frozen at submission;
  // while being edited (or when nothing was frozen), its quantities at today's approved cost.
  const editing = new Set(plans.filter((p) => !['submitted', 'pending_l2', 'approved'].includes(p.status)).map((p) => p.id));
  const qtyOf = (l: PlanLine) => n(l.job_work_qty) + n(l.fob_qty) + n(l.efob_qty);
  const lineSplit = (l: PlanLine) => {
    const stored = n(l.standard_value);
    // Material lines are valued at material rates (Job work + Purchase), FG lines at FG rates.
    if (materialPlans.has(l.plan_id)) {
      const m = l.product_code ? matCosts[l.product_code] : undefined;
      if (stored > 0 && (!editing.has(l.plan_id) || !m)) {
        const q = qtyOf(l);
        return { job: q ? (stored * n(l.job_work_qty)) / q : 0, fob: q ? (stored * n(l.fob_qty)) / q : 0, efob: 0 };
      }
      return m ? { job: n(l.job_work_qty) * m.job, fob: n(l.fob_qty) * m.fob, efob: 0 } : { job: 0, fob: 0, efob: 0 };
    }
    const c = l.product_code ? costs[l.product_code] : undefined;
    if (stored > 0 && (!editing.has(l.plan_id) || !c)) {
      const q = qtyOf(l);
      return { job: q ? (stored * n(l.job_work_qty)) / q : 0, fob: q ? (stored * n(l.fob_qty)) / q : 0, efob: q ? (stored * n(l.efob_qty)) / q : 0 };
    }
    return c ? { job: n(l.job_work_qty) * c.job, fob: n(l.fob_qty) * c.fob, efob: n(l.efob_qty) * c.efob } : { job: 0, fob: 0, efob: 0 };
  };
  const lineValue = (l: PlanLine) => {
    const s = lineSplit(l);
    return s.job + s.fob + s.efob;
  };
  const issuedByMonth = new Map<string, number>();
  const actualsByMonth = new Map<string, typeof actuals>();
  for (const a of actuals) {
    issuedByMonth.set(a.plan_month, (issuedByMonth.get(a.plan_month) ?? 0) + n(a.issued_qty));
    actualsByMonth.set(a.plan_month, [...(actualsByMonth.get(a.plan_month) ?? []), a]);
  }

  const trackOf = (p: (typeof plans)[number]) => (p.plan_type === 'material' ? 'material' : 'fg');
  const planFor = (track: string, month: string) => plans.find((x) => trackOf(x) === track && x.plan_month === month);
  const code = (l: PlanLine) => (l.product_code ?? '').trim().toUpperCase();
  type Measure = [string, number, number, (v: number) => string];

  /** This plan against the same track's plan the month before: totals, then product by product. */
  const comparison = (track: string, month: string, mine: PlanLine[]): MonthDetailSection[] => {
    const prevMonth = addMonths(month, -1);
    const prev = planFor(track, prevMonth);
    const title = `Compared with ${short(prevMonth)}`;
    if (!prev) return [{ kind: 'bars', title, bars: [], empty: `There is no ${track === 'fg' ? 'FG' : 'material'} plan for ${long(prevMonth)} to compare with.` }];
    const before = lines.filter((l) => l.plan_id === prev.id && qtyOf(l) > 0);
    const now = mine.filter((l) => qtyOf(l) > 0);
    const sum = (ls: PlanLine[], f: (l: PlanLine) => number) => ls.reduce((s, l) => s + f(l), 0);
    const change = (a: number, b: number) => (b === 0 ? (a === 0 ? '—' : 'new') : `${a >= b ? '+' : '−'}${Math.abs(Math.round(((a - b) / b) * 100))}%`);
    const count = (v: number) => String(v);
    const measures: Measure[] = [
      [track === 'fg' ? 'Products' : 'Materials', new Set(now.map(code)).size, new Set(before.map(code)).size, count],
      [track === 'fg' ? 'Pcs planned' : 'Qty planned', sum(now, qtyOf), sum(before, qtyOf), num],
      ['Plan value', sum(now, lineValue), sum(before, lineValue), inrShort],
      ['Job work', sum(now, (l) => n(l.job_work_qty)), sum(before, (l) => n(l.job_work_qty)), num],
      ...(track === 'fg'
        ? ([
            ['E-FOB', sum(now, (l) => n(l.efob_qty)), sum(before, (l) => n(l.efob_qty)), num],
            ['FOB', sum(now, (l) => n(l.fob_qty)), sum(before, (l) => n(l.fob_qty)), num],
          ] as Measure[])
        : ([['Purchase', sum(now, (l) => n(l.fob_qty)), sum(before, (l) => n(l.fob_qty)), num]] as Measure[])),
    ];
    const prevQty = new Map<string, number>();
    for (const l of before) prevQty.set(code(l), (prevQty.get(code(l)) ?? 0) + qtyOf(l));
    const nowQty = new Map<string, number>();
    for (const l of now) nowQty.set(code(l), (nowQty.get(code(l)) ?? 0) + qtyOf(l));
    const productRows = [...new Set([...prevQty.keys(), ...nowQty.keys()])]
      .map((c) => {
        const a = nowQty.get(c) ?? 0;
        const b = prevQty.get(c) ?? 0;
        const tone: Tone = b === 0 ? 'draft' : a === 0 ? 'back' : a >= b ? 'live' : 'pending';
        return { d: Math.abs(a - b), tone, cells: [c, num(b), num(a), `${a > b ? '+' : '−'}${num(Math.abs(a - b))}`, change(a, b)] };
      })
      .filter((r) => r.d > 0)
      .sort((x, y) => y.d - x.d)
      .map(({ tone, cells }) => ({ tone, cells }));
    return [
      {
        kind: 'table',
        title,
        hint: `This plan against the ${track === 'fg' ? 'FG' : 'material'} plan for ${long(prevMonth)}.`,
        columns: [{ label: 'Measure' }, { label: short(prevMonth), num: true }, { label: short(month), num: true }, { label: 'Change', num: true }],
        rows: measures.map(([label, a, b, fmt]) => ({ cells: [label, fmt(b), fmt(a), change(a, b)] })),
      },
      {
        kind: 'table',
        title: `${track === 'fg' ? 'Product' : 'Material'} changes vs ${short(prevMonth)}`,
        hint: 'Added, dropped, raised or cut compared with last month’s plan, biggest change first.',
        columns: [{ label: track === 'fg' ? 'Product' : 'Material' }, { label: short(prevMonth), num: true }, { label: short(month), num: true }, { label: 'Change', num: true }, { label: '%', num: true }],
        rows: productRows,
        filters: [
          { label: 'New this month', tone: 'draft' },
          { label: 'Raised', tone: 'live' },
          { label: 'Cut', tone: 'pending' },
          { label: 'Dropped', tone: 'back' },
        ],
        empty: 'Same quantities as last month.',
      },
    ];
  };

  /**
   * Needs attention — the SAME four signals as the plan page's Needs attention card, so the two
   * read alike: no approved cost, awaiting approval (submitted, line not yet approved), nothing
   * issued yet (FG), issued over plan (FG). Planned = a line with quantity, not rejected.
   */
  const attention = (
    track: string,
    mine: PlanLine[],
    planStatus: string,
    issuedOf: (code: string) => number,
  ): MonthDetailSection => {
    const rows: { tone: Tone; cells: string[] }[] = [];
    const locked = ['submitted', 'pending_l2', 'approved'].includes(planStatus);
    for (const l of mine) {
      const q = qtyOf(l);
      if (q <= 0 || l.line_status === 'rejected') continue;
      const c = l.product_code ?? '—';
      const got = issuedOf((l.product_code ?? '').trim().toUpperCase());
      if (lineValue(l) <= 0) rows.push({ tone: 'back', cells: [c, 'No approved cost', `${num(q)} ${track === 'fg' ? 'pcs' : 'qty'} cannot be valued until a standard cost is approved`] });
      if (locked && planStatus !== 'approved' && l.line_status !== 'approved') rows.push({ tone: 'pending', cells: [c, 'Approval pending', 'Line waiting for the approver'] });
      if (track === 'fg' && got === 0) rows.push({ tone: 'draft', cells: [c, 'Not started', `${num(q)} pcs planned, nothing issued yet`] });
      if (track === 'fg' && got > q) rows.push({ tone: 'back', cells: [c, 'Over plan', `${num(got)} issued against ${num(q)} planned`] });
    }
    return {
      kind: 'table',
      title: 'Needs attention',
      hint: 'The same checks as the plan page: no approved cost, approval pending, not started, over plan.',
      columns: [{ label: track === 'fg' ? 'Product' : 'Material' }, { label: 'Issue' }, { label: 'Detail' }],
      rows,
      filters: [
        { label: 'Cost / over plan', tone: 'back' },
        { label: 'Approval pending', tone: 'pending' },
        { label: 'Not started', tone: 'draft' },
      ],
      empty: 'Nothing to flag on this plan.',
    };
  };

  /** Other checks the plan page does not count: sent-back lines, product states, empty draft lines. */
  const otherChecks = (track: string, mine: PlanLine[], draft: boolean): MonthDetailSection | null => {
    const rows: { tone: Tone; cells: string[] }[] = [];
    for (const l of mine) {
      const q = qtyOf(l);
      const c = l.product_code ?? '—';
      if (l.line_status === 'rework' || l.line_status === 'rejected')
        rows.push({ tone: 'back', cells: [c, l.line_status === 'rework' ? 'Line sent back' : 'Line rejected', l.rework_notes ?? '—'] });
      const state = (l.product_status ?? '').toLowerCase();
      if (q > 0 && state.includes('discontinu')) rows.push({ tone: 'pending', cells: [c, l.product_status ?? '', `${num(q)} pcs planned for a product being discontinued`] });
      else if (q > 0 && (state.includes('not launched') || state.startsWith('sku create')))
        rows.push({ tone: 'pending', cells: [c, l.product_status ?? '', 'Not launched yet — check it is meant to be bought this month'] });
      if (draft && q <= 0) rows.push({ tone: 'draft', cells: [c, 'No quantity', 'Added to the plan but nothing entered'] });
    }
    if (!rows.length) return null;
    return {
      kind: 'table',
      title: 'Other checks',
      hint: 'Lines sent back or rejected, product states worth a second look, and empty draft lines.',
      columns: [{ label: track === 'fg' ? 'Product' : 'Material' }, { label: 'Check' }, { label: 'Detail' }],
      rows,
    };
  };

  /** Line-by-line approval progress once a plan has been submitted. */
  const lineDecisions = (mine: PlanLine[]): MonthDetailSection | null => {
    const decided = mine.filter((l) => qtyOf(l) > 0 && l.line_status);
    if (!decided.length) return null;
    const count = (st: string[]) => decided.filter((l) => st.includes(l.line_status ?? '')).length;
    const parts: [string, number, Tone][] = [
      ['Approved', count(['approved']), 'live'],
      ['Awaiting review', count(['submitted', 'pending_l2']), 'pending'],
      ['Sent back', count(['rework']), 'back'],
      ['Rejected', count(['rejected']), 'closed'],
    ];
    return {
      kind: 'bars',
      title: 'Line decisions',
      hint: 'Each line is approved on its own; the plan is approved when every line is.',
      bars: parts.filter(([, k]) => k > 0).map(([label, k, tone]) => ({ label, value: `${k} of ${decided.length}`, pct: pct(k, decided.length), tone })),
    };
  };

  /** Days left to submit (negative = overdue), measured to 23:59 IST on the deadline day. */
  const daysToDeadline = (month: string) => {
    const deadline = new Date(`${month.slice(0, 8)}${String(deadlineDay).padStart(2, '0')}T18:29:59Z`).getTime();
    return Math.ceil((deadline - Date.now()) / 86_400_000);
  };

  const cards: MonthBoardCard[] = [];
  for (const p of plans) {
    const track = p.plan_type === 'material' ? 'material' : 'fg';
    const mine = lines.filter((l) => l.plan_id === p.id);
    const qty = mine.reduce((s, l) => s + qtyOf(l), 0);
    const withQty = mine.filter((l) => qtyOf(l) > 0);
    const values = withQty.map(lineValue);
    const unvalued = values.filter((v) => v <= 0).length;
    const total = values.reduce((s, v) => s + v, 0);
    const value = total > 0 ? total : null;
    const products = new Set(withQty.map((l) => l.product_code).filter(Boolean)).size;
    const frozen = isPlanFrozen(p.plan_month);
    const status =
      p.status === 'approved' ? (frozen ? 'closed' : 'live') : p.status === 'submitted' || p.status === 'pending_l2' ? 'pending' : 'draft';
    const facts: string[] = [];
    const deadline = new Date(`${p.plan_month.slice(0, 8)}${String(deadlineDay).padStart(2, '0')}T18:29:59Z`); // 23:59:59 IST
    const onTime = p.submitted_at ? new Date(p.submitted_at) <= deadline : null;
    if (p.submitted_at) {
      facts.push(`Submitted ${day(p.submitted_at)} · ${onTime ? 'on time' : `late (after the ${deadlineDay}th)`}`);
    } else if (status === 'draft') {
      facts.push(`Submit by ${deadlineDay} ${short(p.plan_month).split(' ')[0]}`);
    }
    if (status === 'pending' && p.submitted_at) facts.push(`Waiting ${daysSince(p.submitted_at)} days for approval`);
    if (p.approved_at) facts.push(`Approved ${day(p.approved_at)}`);
    if (frozen && status === 'pending') facts.push('Month is over · still not approved');
    if (frozen && status === 'closed') facts.push('Month over · plan frozen');
    let warn: MonthBoardCard['warn'];
    if (p.status === 'rework') warn = { text: `Sent back for rework${p.rework_notes ? `: ${p.rework_notes}` : ''}`, tone: 'back' };
    else if (p.status === 'rejected') warn = { text: `Rejected${p.rejection_notes ? `: ${p.rejection_notes}` : ''}`, tone: 'back' };
    else if (withQty.length && value == null) warn = { text: 'No line on this plan has a standard value or an approved cost, so its value cannot be shown.', tone: 'pending' };
    else if (unvalued) warn = { text: `${unvalued} line${unvalued === 1 ? ' has' : 's have'} no standard value or approved cost, so the value is understated.`, tone: 'pending' };

    // Issued against the plan = POs for the PLANNED products only (the plan page's rule);
    // POs for other products show under "Issued but not in the plan".
    const monthIssued = new Map((actualsByMonth.get(p.plan_month) ?? []).map((a) => [a.product_code.trim().toUpperCase(), a]));
    const plannedCodes = new Set(withQty.filter((l) => l.line_status !== 'rejected').map((l) => (l.product_code ?? '').trim().toUpperCase()));
    const issuedOf = (code: string) => n(monthIssued.get(code)?.issued_qty);
    const issued = track === 'fg' ? [...plannedCodes].reduce((t, c) => t + issuedOf(c), 0) : null;
    const href = `/buying-plan?month=${p.plan_month}&type=${track}`;
    const actions: MonthBoardCard['actions'] = [
      // A month that is over is view only: its card just opens the plan.
      { label: status === 'draft' && !frozen ? 'Edit plan' : 'Open', href: status === 'draft' && !frozen ? `${href}&mode=input` : href, primary: true },
      // Analysis (approved plan vs POs issued) reads for any FG month: lines not yet approved
      // show as such, and POs issued against them as not budgeted.
      ...(track === 'fg' ? [{ label: 'Analysis', href: `/buying-plan?month=${p.plan_month}&type=analysis` }] : []),
    ];

    /* ---- overview ---- */
    const sections: MonthDetailSection[] = [];
    const tiles: { label: string; value: string }[] = [
      { label: 'Plan value', value: value == null ? '—' : inrShort(value) },
      { label: track === 'fg' ? 'Products' : 'Materials', value: String(products) },
      { label: track === 'fg' ? 'Pcs planned' : 'Qty planned', value: num(qty) },
      {
        label: 'Deadline',
        value:
          status === 'draft'
            ? daysToDeadline(p.plan_month) >= 0
              ? `${deadlineDay} ${short(p.plan_month)} · ${daysToDeadline(p.plan_month)} d left`
              : `${deadlineDay} ${short(p.plan_month)} · overdue ${-daysToDeadline(p.plan_month)} d`
            : `${deadlineDay} ${short(p.plan_month)}`,
      },
      { label: 'Submitted', value: p.submitted_at ? `${day(p.submitted_at)} · ${onTime ? 'on time' : 'late'}` : 'Not yet' },
      {
        label: 'Approved',
        value: p.approved_at ? dayYear(p.approved_at) : status === 'pending' && p.submitted_at ? `Waiting ${daysSince(p.submitted_at)} d` : '—',
      },
    ];
    let ring: NonNullable<MonthBoardCard['detail']>['ring'];
    sections.push(attention(track, mine, p.status, issuedOf));
    const others = otherChecks(track, mine, status === 'draft');
    if (others) sections.push(others);
    const decisions = lineDecisions(mine);
    if (decisions) sections.push(decisions);

    if (track === 'fg') {
      const monthActuals = actualsByMonth.get(p.plan_month) ?? [];
      const issuedByCode = new Map(monthActuals.map((a) => [a.product_code.trim().toUpperCase(), a]));
      const plannedActuals = monthActuals.filter((a) => plannedCodes.has(a.product_code.trim().toUpperCase()));
      const issuedValue = plannedActuals.reduce((s, a) => s + n(a.issued_value), 0);
      const pos = plannedActuals.reduce((s, a) => s + n(a.po_count), 0);
      ring = qty
        ? {
            pct: pct(issued ?? 0, qty),
            over: (issued ?? 0) > qty,
            label: 'issued',
            caption: 'Pieces issued against the plan',
            sub: (issued ?? 0) > qty ? `${num(issued)} of ${num(qty)} · over plan by ${num((issued ?? 0) - qty)}` : `${num(issued)} of ${num(qty)} pcs`,
          }
        : undefined;
      tiles.push({ label: 'Issued value', value: inrShort(issuedValue) }, { label: 'PO lines issued', value: num(pos) });

      // Value by PO type.
      const byType = { job: 0, efob: 0, fob: 0 };
      const pcsByType = { job: 0, efob: 0, fob: 0 };
      for (const l of withQty) {
        const sp = lineSplit(l);
        byType.job += sp.job;
        byType.efob += sp.efob;
        byType.fob += sp.fob;
        pcsByType.job += n(l.job_work_qty);
        pcsByType.efob += n(l.efob_qty);
        pcsByType.fob += n(l.fob_qty);
      }
      const typeTotal = byType.job + byType.efob + byType.fob;
      sections.push({
        kind: 'bars',
        title: 'Value by PO type',
        hint: 'Plan quantity × standard cost, split by how each piece will be bought.',
        bars: (['job', 'efob', 'fob'] as const)
          .filter((k) => pcsByType[k] > 0)
          .map((k) => ({
            label: `${k === 'job' ? 'Job Work' : k === 'efob' ? 'E-FOB' : 'FOB'} · ${num(pcsByType[k])} pcs`,
            value: `${inrShort(byType[k])} · ${pct(byType[k], typeTotal)}%`,
            pct: pct(byType[k], typeTotal),
            tone: k === 'job' ? 'draft' : k === 'efob' ? 'pending' : 'live',
          })),
        empty: 'No quantities on this plan yet.',
      });

      // Planned vs issued by category.
      const cat = new Map<string, { planned: number; issued: number; value: number }>();
      for (const l of withQty) {
        const code = (l.product_code ?? '').trim().toUpperCase();
        const c = categoryOf.get(code) ?? 'Uncategorised';
        const row = cat.get(c) ?? { planned: 0, issued: 0, value: 0 };
        row.planned += qtyOf(l);
        row.issued += n(issuedByCode.get(code)?.issued_qty);
        row.value += lineValue(l);
        cat.set(c, row);
      }
      sections.push({
        kind: 'bars',
        title: 'Issued against plan, by category',
        hint: 'How much of each category’s planned pieces have been issued as POs this month.',
        bars: [...cat.entries()]
          .sort((a, b) => b[1].planned - a[1].planned)
          .map(([c, r]) => ({
            label: `${c} · ${inrShort(r.value)}`,
            value: r.issued > r.planned ? `${num(r.issued)} / ${num(r.planned)} · over plan` : `${num(r.issued)} / ${num(r.planned)} pcs`,
            pct: pct(r.issued, r.planned),
            tone: r.issued > r.planned ? 'pending' : 'live',
          })),
        empty: 'No quantities on this plan yet.',
      });

      // Every product: planned vs issued.
      const rows = withQty
        .map((l) => {
          const code = (l.product_code ?? '').trim().toUpperCase();
          const planned = qtyOf(l);
          const got = n(issuedByCode.get(code)?.issued_qty);
          const tone: Tone = got > planned ? 'back' : got >= planned ? 'live' : got > 0 ? 'pending' : 'draft';
          return {
            planned,
            tone,
            cells: [
              l.product_code ?? '—',
              categoryOf.get(code) ?? 'Uncategorised',
              l.product_status ?? '—',
              num(n(l.job_work_qty)),
              num(n(l.efob_qty)),
              num(n(l.fob_qty)),
              num(planned),
              num(got),
              got > planned ? `over by ${num(got - planned)}` : num(planned - got),
              lineValue(l) > 0 ? inrShort(lineValue(l)) : '—',
            ],
          };
        })
        .sort((a, b) => b.planned - a.planned)
        .map(({ cells, tone }) => ({ cells, tone }));
      sections.push({
        kind: 'table',
        title: 'Products in this plan',
        hint: 'Planned pieces by PO type against the pieces issued on POs dated this month.',
        columns: [
          { label: 'Product' },
          { label: 'Category' },
          { label: 'State' },
          { label: 'Job', num: true },
          { label: 'E-FOB', num: true },
          { label: 'FOB', num: true },
          { label: 'Planned', num: true },
          { label: 'Issued', num: true },
          { label: 'Left', num: true },
          { label: 'Value', num: true },
        ],
        rows,
        filters: [
          { label: 'Not started', tone: 'draft' },
          { label: 'Partly issued', tone: 'pending' },
          { label: 'Fully issued', tone: 'live' },
          { label: 'Over plan', tone: 'back' },
        ],
        empty: 'No products on this plan yet.',
      });

      // Issued this month with no line on the plan.
      const planned = new Set(withQty.map((l) => (l.product_code ?? '').trim().toUpperCase()));
      const outside = monthActuals.filter((a) => n(a.issued_qty) > 0 && !planned.has(a.product_code.trim().toUpperCase()));
      sections.push({
        kind: 'table',
        title: 'Issued but not in the plan',
        hint: 'Products with POs dated this month that have no line on this plan.',
        columns: [{ label: 'Product' }, { label: 'Category' }, { label: 'Pcs issued', num: true }, { label: 'Value', num: true }, { label: 'PO lines', num: true }],
        rows: outside
          .sort((a, b) => n(b.issued_qty) - n(a.issued_qty))
          .map((a) => ({
            tone: 'back' as Tone,
            cells: [a.product_code, categoryOf.get(a.product_code.trim().toUpperCase()) ?? 'Uncategorised', num(n(a.issued_qty)), inrShort(n(a.issued_value)), num(n(a.po_count))],
          })),
        empty: 'Every PO issued this month is for a planned product.',
      });
    } else {
      // Material track: value by how it is bought, then the lines themselves.
      const job = withQty.reduce((s, l) => s + lineSplit(l).job, 0);
      const buy = withQty.reduce((s, l) => s + lineSplit(l).fob, 0);
      sections.push({
        kind: 'bars',
        title: 'Value by how it is bought',
        hint: 'Quantity × approved material rate.',
        bars: [
          ...(job > 0 ? [{ label: `Job work · ${num(withQty.reduce((s, l) => s + n(l.job_work_qty), 0))}`, value: `${inrShort(job)} · ${pct(job, job + buy)}%`, pct: pct(job, job + buy), tone: 'draft' as Tone }] : []),
          ...(buy > 0 ? [{ label: `Purchase · ${num(withQty.reduce((s, l) => s + n(l.fob_qty), 0))}`, value: `${inrShort(buy)} · ${pct(buy, job + buy)}%`, pct: pct(buy, job + buy), tone: 'live' as Tone }] : []),
        ],
        empty: 'No line has an approved material rate yet.',
      });
      const byType = new Map<string, number>();
      for (const l of withQty) byType.set(l.material_type || 'Unspecified', (byType.get(l.material_type || 'Unspecified') ?? 0) + qtyOf(l));
      sections.push({
        kind: 'bars',
        title: 'Quantity by material type',
        bars: [...byType.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([t, q]) => ({ label: t, value: `${num(q)} · ${pct(q, qty)}%`, pct: pct(q, qty), tone: 'draft' as Tone })),
        empty: 'No quantities on this plan yet.',
      });
      sections.push({
        kind: 'table',
        title: 'Materials in this plan',
        columns: [{ label: 'Material' }, { label: 'Type' }, { label: 'Colour' }, { label: 'Job work', num: true }, { label: 'Purchase', num: true }, { label: 'Unit' }, { label: 'Value', num: true }, { label: 'Status' }],
        rows: withQty.map((l) => ({
          tone: (l.line_status === 'approved' ? 'live' : l.line_status ? 'pending' : 'draft') as Tone,
          cells: [
            l.product_code ?? '—',
            l.material_type ?? '—',
            l.colour ?? '—',
            num(n(l.job_work_qty)),
            num(n(l.fob_qty)),
            l.uom ?? '—',
            lineValue(l) > 0 ? inrShort(lineValue(l)) : '—',
            l.line_status ? (STATUS_WORDS[l.line_status]?.[0] ?? l.line_status) : 'Draft',
          ],
        })),
        empty: 'No materials on this plan yet.',
      });
    }

    sections.push(...comparison(track, p.plan_month, mine));
    const events = timeline(log.filter((r) => r.entity_id === String(p.id)));
    sections.push({ kind: 'timeline', title: 'Approval history', hint: `Deadline to submit: ${deadlineDay} ${short(p.plan_month)}.`, events, empty: 'Nothing submitted or decided yet.' });

    cards.push({
      id: `bp-${p.id}`,
      month: p.plan_month,
      label: short(p.plan_month),
      track: track === 'fg' ? 'FG' : 'Material',
      status,
      big: { value: value == null ? '—' : inrShort(value), label: 'Plan value' },
      sub: `${products} ${track === 'fg' ? 'product' : 'material'}${products === 1 ? '' : 's'} · ${num(qty)} ${track === 'fg' ? 'pcs' : 'qty'} planned${p.status === 'pending_l2' ? ' · with the second approver' : p.status === 'submitted' ? ' · with the approver' : ''}`,
      progress:
        issued != null && qty > 0
          ? {
              left: `${num(issued)} / ${num(qty)} pcs issued`,
              right: issued > qty ? `over plan by ${num(issued - qty)}` : `${pct(issued, qty)}%`,
              pct: pct(issued, qty),
              over: issued > qty,
            }
          : undefined,
      facts,
      warn,
      actions,
      list: [String(products), num(qty), issued == null ? '—' : num(issued), value == null ? '—' : inrShort(value)],
      detail: {
        kicker: `Buying Plan · ${track === 'fg' ? 'FG' : 'Material'}`,
        lede: `${track === 'fg' ? 'Finished-goods' : 'Fabric / material'} plan for ${long(p.plan_month)}${
          p.status === 'pending_l2' ? ', with the second approver' : p.status === 'submitted' ? ', with the approver' : ''
        }.`,
        ring,
        tiles,
        sections,
      },
    });
  }

  // This month's and next month's FG plan, when not started yet. The overview shows what there is
  // to start from: last month's plan, the 30-day demand projection, POs already dated in the month.
  for (const m of [monthStart(), addMonths(monthStart(), 1)]) {
    if (plans.some((p) => p.plan_month === m && (p.plan_type ?? 'fg') !== 'material')) continue;
    const prevMonth = addMonths(m, -1);
    const prev = planFor('fg', prevMonth);
    const prevLines = prev ? lines.filter((l) => l.plan_id === prev.id && qtyOf(l) > 0) : [];
    const already = (actualsByMonth.get(m) ?? []).filter((a) => n(a.issued_qty) > 0);
    const left = daysToDeadline(m);
    const demandRows = Object.entries(demand)
      .filter(([, d]) => n(d.rop_30) > 0)
      .sort((a, b) => n(b[1].rop_30) - n(a[1].rop_30));
    const lastQty = new Map<string, number>();
    for (const l of prevLines) lastQty.set(code(l), (lastQty.get(code(l)) ?? 0) + qtyOf(l));
    cards.push({
      id: `bp-new-${m}`,
      month: m,
      label: short(m),
      track: 'FG',
      status: 'draft',
      big: { value: '—', label: 'Plan value' },
      sub: 'Not started',
      facts: [`Submit by ${deadlineDay} ${short(m).split(' ')[0]}`],
      actions: [
        { label: 'Start plan', href: `/buying-plan?month=${m}&type=fg&mode=input`, primary: true },
        { label: 'Analysis', href: `/buying-plan?month=${m}&type=analysis` },
      ],
      list: ['0', '—', '—', '—'],
      detail: {
        kicker: 'Buying Plan · FG',
        lede: `No plan has been started for ${long(m)} yet. Here is what there is to start from.`,
        tiles: [
          { label: 'Deadline', value: `${deadlineDay} ${short(m)} · ${left >= 0 ? `${left} d left` : `overdue ${-left} d`}` },
          { label: `${short(prevMonth)} products`, value: prev ? String(new Set(prevLines.map(code)).size) : '—' },
          { label: `${short(prevMonth)} pcs`, value: prev ? num(prevLines.reduce((s, l) => s + qtyOf(l), 0)) : '—' },
          { label: `${short(prevMonth)} value`, value: prev ? inrShort(prevLines.reduce((s, l) => s + lineValue(l), 0)) : '—' },
          { label: '30-day demand', value: `${num(demandRows.reduce((s, [, d]) => s + n(d.rop_30), 0))} pcs` },
          { label: 'Already issued', value: already.length ? `${num(already.reduce((s, a) => s + n(a.issued_qty), 0))} pcs` : 'None' },
        ],
        sections: [
          {
            kind: 'table',
            title: '30-day demand projection',
            hint: 'Pieces needed over the next 30 days by product (reorder point), with last month’s plan beside it. The plan’s Pending quantity uses the same figure.',
            columns: [{ label: 'Product' }, { label: 'Category' }, { label: '30-day need', num: true }, { label: `${short(prevMonth)} plan`, num: true }, { label: 'Approved cost' }],
            rows: demandRows.map(([c, d]) => {
              const key = c.trim().toUpperCase();
              return {
                tone: (lastQty.has(key) ? 'live' : 'draft') as Tone,
                cells: [c, categoryOf.get(key) ?? 'Uncategorised', num(n(d.rop_30)), lastQty.has(key) ? num(lastQty.get(key)) : '—', costs[c] ? 'Yes' : 'No — needs a standard cost'],
              };
            }),
            filters: [
              { label: `In ${short(prevMonth)} plan`, tone: 'live' },
              { label: `Not in ${short(prevMonth)} plan`, tone: 'draft' },
            ],
            empty: 'No demand projection is available.',
          },
          {
            kind: 'table',
            title: `${short(prevMonth)} plan, as a starting point`,
            hint: prev ? `What was planned last month (${STATUS_WORDS[prev.status]?.[0] ?? prev.status}).` : undefined,
            columns: [{ label: 'Product' }, { label: 'Category' }, { label: 'Job', num: true }, { label: 'E-FOB', num: true }, { label: 'FOB', num: true }, { label: 'Total', num: true }, { label: 'Value', num: true }],
            rows: prevLines
              .slice()
              .sort((a, b) => qtyOf(b) - qtyOf(a))
              .map((l) => ({
                cells: [l.product_code ?? '—', categoryOf.get(code(l)) ?? 'Uncategorised', num(n(l.job_work_qty)), num(n(l.efob_qty)), num(n(l.fob_qty)), num(qtyOf(l)), lineValue(l) > 0 ? inrShort(lineValue(l)) : '—'],
              })),
            empty: `There is no FG plan for ${long(prevMonth)}.`,
          },
          {
            kind: 'table',
            title: 'POs already dated in this month',
            hint: 'Issued before any plan exists for the month — each shows as not budgeted until it is planned.',
            columns: [{ label: 'Product' }, { label: 'Category' }, { label: 'Pcs issued', num: true }, { label: 'Value', num: true }, { label: 'PO lines', num: true }],
            rows: already
              .slice()
              .sort((a, b) => n(b.issued_qty) - n(a.issued_qty))
              .map((a) => ({ tone: 'back' as Tone, cells: [a.product_code, categoryOf.get(a.product_code.trim().toUpperCase()) ?? 'Uncategorised', num(n(a.issued_qty)), inrShort(n(a.issued_value)), num(n(a.po_count))] })),
            empty: 'No POs dated in this month yet.',
          },
        ],
      },
    });
  }

  const started = cards.filter((c) => !c.id.startsWith('bp-new-'));
  const totalQty = lines.reduce((s, l) => s + qtyOf(l), 0);
  const totalValue = lines.reduce((s, l) => s + lineValue(l), 0);
  return {
    columns: [
      { key: 'draft', label: 'Draft', tone: 'draft', hint: 'Being filled · not submitted yet' },
      { key: 'pending', label: 'Pending approval', tone: 'pending', hint: 'Submitted · waiting for the approver' },
      { key: 'live', label: 'Approved', tone: 'live', hint: 'Live for the month · POs issue against it' },
      { key: 'closed', label: 'Closed', tone: 'closed', hint: 'Month over · plan frozen' },
    ],
    cards,
    totals: [
      { value: String(started.length), label: 'Plans' },
      { value: num(totalQty), label: 'Pcs planned' },
      { value: inrShort(totalValue), label: 'Valued' },
    ],
    unit: 'plans',
    trackLabels: { FG: 'Finished Goods (FG)', Material: 'Fabric / Material' },
    listColumns: [{ label: 'Products', num: true }, { label: 'Pcs planned', num: true }, { label: 'Issued', num: true }, { label: 'Value', num: true }],
  };
}

/* ------------------------------------------------------------------ */
/* Inward Plan                                                         */
/* ------------------------------------------------------------------ */

export async function loadInwardPlanBoard(): Promise<MonthBoardData> {
  const supabase = await client();
  const [rows, log, weekly] = await Promise.all([
    pageAll<{ plan_month: string; product_code: string | null; po_no: string | null; vendor_name: string | null; inward_qty: number | null; actual_inward_qty: number | null; cost_per_piece: number | null; approval_status: string | null; mt_comments: string | null }>(() =>
      supabase
        .from('sd_inward_plan_entry')
        .select('plan_month, product_code, po_no, vendor_name, inward_qty, actual_inward_qty, cost_per_piece, approval_status, mt_comments')
        .order('id'),
    ),
    loadLog(['inward_plan']),
    pageAll<{ row_key: string; po_number: string | null; product_variant: string | null; delivery_date_this_week: string | null; qty_expected_this_week: number | null; status: string | null }>(() =>
      supabase
        .from('sd_receivable_input')
        .select('row_key, po_number, product_variant, delivery_date_this_week, qty_expected_this_week, status')
        .order('row_key'),
    ),
  ]);
  const cur = monthStart();
  const prev = addMonths(cur, -1);
  type InwardRow = (typeof rows)[number];
  const poTypeOf = (ref: string | null) => {
    const m = (ref ?? '').toUpperCase().match(/\/(JOB|FOB|EFOB|E-FOB)\//);
    return m ? (m[1] === 'JOB' ? 'Job Work' : m[1] === 'FOB' ? 'FOB' : 'E-FOB') : 'Unknown type';
  };
  const sumBy = (rs: InwardRow[], f: (r: InwardRow) => number) => rs.reduce((t, r) => t + f(r), 0);

  /** Lines to look at: no cost / PO / vendor, sent back, short or above plan once the month is over. */
  const inwardAttention = (m: string, mine: InwardRow[]): MonthDetailSection => {
    const out: { tone: Tone; cells: string[] }[] = [];
    for (const r of mine) {
      const who = [r.po_no, r.product_code].filter(Boolean).join(' · ') || '—';
      const planned = n(r.inward_qty);
      const got = n(r.actual_inward_qty);
      if (r.approval_status === 'RE-WORK' || r.approval_status === 'Rejected')
        out.push({ tone: 'back', cells: [who, r.approval_status === 'RE-WORK' ? 'Sent back' : 'Rejected', r.mt_comments ?? '—'] });
      if (!r.po_no) out.push({ tone: 'back', cells: [who, 'No PO number', 'Receipts cannot be matched to this line'] });
      if (r.cost_per_piece == null || n(r.cost_per_piece) <= 0) out.push({ tone: 'pending', cells: [who, 'No cost per piece', 'The line is not counted in the planned value'] });
      if (!r.vendor_name) out.push({ tone: 'pending', cells: [who, 'No vendor', '—'] });
      if (m < cur && planned > 0 && got < planned) out.push({ tone: 'pending', cells: [who, 'Short', `${num(got)} of ${num(planned)} received · ${num(planned - got)} short`] });
      if (planned > 0 && got > planned) out.push({ tone: 'draft', cells: [who, 'Above plan', `${num(got)} received against ${num(planned)} planned`] });
    }
    return {
      kind: 'table',
      title: 'Needs attention',
      hint: 'Lines to check on this month’s plan.',
      columns: [{ label: 'Line' }, { label: 'Issue' }, { label: 'Detail' }],
      rows: out,
      filters: [
        { label: 'Blocking', tone: 'back' },
        { label: 'Check', tone: 'pending' },
        { label: 'Above plan', tone: 'draft' },
      ],
      empty: 'Nothing to flag this month.',
    };
  };

  /** Planned vs received by PO type, read off the PO reference. */
  const byPoType = (mine: InwardRow[]): MonthDetailSection => {
    const t = new Map<string, { planned: number; received: number }>();
    for (const r of mine) {
      const k = poTypeOf(r.po_no);
      const row = t.get(k) ?? { planned: 0, received: 0 };
      row.planned += n(r.inward_qty);
      row.received += n(r.actual_inward_qty);
      t.set(k, row);
    }
    return {
      kind: 'bars',
      title: 'Received against plan, by PO type',
      bars: [...t.entries()]
        .sort((a, b) => b[1].planned - a[1].planned)
        .map(([k, v]) => ({
          label: `${k} · ${num(v.planned)} planned`,
          value: v.received > v.planned ? `${num(v.received)} · above plan` : `${num(v.received)} received · ${pct(v.received, v.planned)}%`,
          pct: pct(v.received, v.planned),
          tone: (v.received >= v.planned ? 'live' : v.received > 0 ? 'pending' : 'draft') as Tone,
        })),
      empty: 'No lines this month.',
    };
  };

  /** This month against the month before: totals, then vendor by vendor. */
  const inwardCompare = (m: string, mine: InwardRow[]): MonthDetailSection[] => {
    const pm = addMonths(m, -1);
    const before = rows.filter((r) => r.plan_month === pm);
    const title = `Compared with ${short(pm)}`;
    if (!before.length) return [{ kind: 'bars', title, bars: [], empty: `There is no inward plan for ${long(pm)} to compare with.` }];
    const change = (a: number, b: number) => (b === 0 ? (a === 0 ? '—' : 'new') : `${a >= b ? '+' : '−'}${Math.abs(Math.round(((a - b) / b) * 100))}%`);
    const planned = (rs: InwardRow[]) => sumBy(rs, (r) => n(r.inward_qty));
    const received = (rs: InwardRow[]) => sumBy(rs, (r) => n(r.actual_inward_qty));
    const value = (rs: InwardRow[]) => sumBy(rs, (r) => n(r.inward_qty) * n(r.cost_per_piece));
    const measures: [string, number, number, (v: number) => string][] = [
      ['Lines', mine.length, before.length, (v) => String(v)],
      ['Vendors', new Set(mine.map((r) => r.vendor_name).filter(Boolean)).size, new Set(before.map((r) => r.vendor_name).filter(Boolean)).size, (v) => String(v)],
      ['Pcs planned', planned(mine), planned(before), num],
      ['Planned value', value(mine), value(before), inrShort],
      ['Pcs received', received(mine), received(before), num],
      ['Received %', pct(received(mine), planned(mine)), pct(received(before), planned(before)), (v) => `${v}%`],
    ];
    const vendorQty = (rs: InwardRow[]) => {
      const out = new Map<string, number>();
      for (const r of rs) out.set(r.vendor_name || 'No vendor', (out.get(r.vendor_name || 'No vendor') ?? 0) + n(r.inward_qty));
      return out;
    };
    const a = vendorQty(mine);
    const b = vendorQty(before);
    const vendorRows = [...new Set([...a.keys(), ...b.keys()])]
      .map((v) => {
        const x = a.get(v) ?? 0;
        const y = b.get(v) ?? 0;
        return { d: Math.abs(x - y), tone: (y === 0 ? 'draft' : x === 0 ? 'back' : x >= y ? 'live' : 'pending') as Tone, cells: [v, num(y), num(x), `${x >= y ? '+' : '−'}${num(Math.abs(x - y))}`, change(x, y)] };
      })
      .filter((r) => r.d > 0)
      .sort((p1, p2) => p2.d - p1.d)
      .map(({ tone, cells }) => ({ tone, cells }));
    return [
      {
        kind: 'table',
        title,
        columns: [{ label: 'Measure' }, { label: short(pm), num: true }, { label: short(m), num: true }, { label: 'Change', num: true }],
        rows: measures.map(([label, x, y, fmt]) => ({ cells: [label, fmt(y), fmt(x), label === 'Received %' ? `${x - y >= 0 ? '+' : '−'}${Math.abs(x - y)} pts` : change(x, y)] })),
      },
      {
        kind: 'table',
        title: `Vendor changes vs ${short(pm)}`,
        hint: 'Pieces planned per vendor: added, dropped, raised or cut, biggest change first.',
        columns: [{ label: 'Vendor' }, { label: short(pm), num: true }, { label: short(m), num: true }, { label: 'Change', num: true }, { label: '%', num: true }],
        rows: vendorRows,
        filters: [
          { label: 'New this month', tone: 'draft' },
          { label: 'Raised', tone: 'live' },
          { label: 'Cut', tone: 'pending' },
          { label: 'Dropped', tone: 'back' },
        ],
        empty: 'Same vendors and quantities as last month.',
      },
    ];
  };

  const months = [...new Set(rows.map((r) => r.plan_month))];
  const toneOf = (s: string | null): Tone => (s === 'Approved' ? 'live' : s === 'RE-WORK' || s === 'Rejected' ? 'back' : 'pending');
  const cards: MonthBoardCard[] = months.map((m) => {
    const mine = rows.filter((r) => r.plan_month === m);
    const pending = mine.filter((r) => r.approval_status === 'Pending').length;
    const approved = mine.filter((r) => r.approval_status === 'Approved').length;
    const back = mine.filter((r) => r.approval_status === 'RE-WORK' || r.approval_status === 'Rejected').length;
    const planned = mine.reduce((s, r) => s + n(r.inward_qty), 0);
    const received = mine.reduce((s, r) => s + n(r.actual_inward_qty), 0);
    const value = mine.reduce((s, r) => s + n(r.inward_qty) * n(r.cost_per_piece), 0);
    const receivedValue = mine.reduce((s, r) => s + n(r.actual_inward_qty) * n(r.cost_per_piece), 0);
    const products = new Set(mine.map((r) => r.product_code).filter(Boolean)).size;
    const vendors = new Set(mine.map((r) => r.vendor_name).filter(Boolean)).size;
    // Older months are closed; the month just gone stays open while lines are still undecided.
    const open = m >= cur || (m === prev && (pending > 0 || back > 0));
    const status = !open ? 'closed' : pending > 0 ? 'pending' : back > 0 ? 'back' : 'live';
    const facts: string[] = [];
    if (received === 0) facts.push(m > cur ? 'Month not started' : 'Nothing received yet');
    if (m < cur && pending > 0) facts.push(`Month is over · ${pending} line${pending === 1 ? '' : 's'} never decided`);
    if (status === 'closed') facts.push('Month closed');

    /* ---- overview ---- */
    const byVendor = new Map<string, { lines: number; planned: number; received: number; value: number }>();
    for (const r of mine) {
      const v = r.vendor_name || 'No vendor';
      const row = byVendor.get(v) ?? { lines: 0, planned: 0, received: 0, value: 0 };
      row.lines += 1;
      row.planned += n(r.inward_qty);
      row.received += n(r.actual_inward_qty);
      row.value += n(r.inward_qty) * n(r.cost_per_piece);
      byVendor.set(v, row);
    }
    const vendorRows = [...byVendor.entries()].sort((a, b) => b[1].planned - a[1].planned);
    const shortLines = mine.filter((r) => m < cur && n(r.actual_inward_qty) < n(r.inward_qty)).length;
    const sections: MonthDetailSection[] = [
      inwardAttention(m, mine),
      {
        kind: 'bars',
        title: 'Lines by decision',
        bars: [
          { label: 'Pending approval', value: `${pending} · ${pct(pending, mine.length)}%`, pct: pct(pending, mine.length), tone: 'pending' as Tone },
          { label: 'Approved', value: `${approved} · ${pct(approved, mine.length)}%`, pct: pct(approved, mine.length), tone: 'live' as Tone },
          { label: 'Sent back or rejected', value: `${back} · ${pct(back, mine.length)}%`, pct: pct(back, mine.length), tone: 'back' as Tone },
        ],
      },
      byPoType(mine),
      {
        kind: 'bars',
        title: 'Received against plan, top vendors',
        hint: 'The ten vendors with the most pieces planned this month.',
        bars: vendorRows.slice(0, 10).map(([v, r]) => ({
          label: v,
          value: r.received > r.planned ? `${num(r.received)} / ${num(r.planned)} · above plan` : `${num(r.received)} / ${num(r.planned)}`,
          pct: pct(r.received, r.planned),
          tone: (r.received >= r.planned ? 'live' : r.received > 0 ? 'pending' : 'draft') as Tone,
        })),
        empty: 'No vendors on this month’s plan.',
      },
      {
        kind: 'table',
        title: 'Vendors',
        columns: [{ label: 'Vendor' }, { label: 'Lines', num: true }, { label: 'Planned', num: true }, { label: 'Received', num: true }, { label: 'Received %', num: true }, { label: 'Planned value', num: true }],
        rows: vendorRows.map(([v, r]) => ({
          tone: (r.received >= r.planned ? 'live' : r.received > 0 ? 'pending' : 'draft') as Tone,
          cells: [v, String(r.lines), num(r.planned), num(r.received), r.received > r.planned ? 'above plan' : `${pct(r.received, r.planned)}%`, inrShort(r.value)],
        })),
        filters: [
          { label: 'Nothing received', tone: 'draft' },
          { label: 'Part received', tone: 'pending' },
          { label: 'Fully received', tone: 'live' },
        ],
      },
      {
        kind: 'table',
        title: 'Lines',
        hint: 'Every line on this month’s inward plan, with its decision.',
        columns: [{ label: 'PO' }, { label: 'Product' }, { label: 'Vendor' }, { label: 'Planned', num: true }, { label: 'Received', num: true }, { label: '₹ / pc', num: true }, { label: 'Decision' }, { label: 'Comment' }],
        rows: mine
          .slice()
          .sort((a, b) => n(b.inward_qty) - n(a.inward_qty))
          .map((r) => ({
            tone: toneOf(r.approval_status),
            cells: [
              r.po_no ?? '—',
              r.product_code ?? '—',
              r.vendor_name ?? '—',
              num(n(r.inward_qty)),
              num(n(r.actual_inward_qty)),
              r.cost_per_piece == null ? '—' : num(n(r.cost_per_piece)),
              r.approval_status === 'RE-WORK' ? 'Sent back' : r.approval_status ?? 'Pending',
              r.mt_comments ?? '',
            ],
          })),
        filters: [
          { label: 'Pending', tone: 'pending' },
          { label: 'Approved', tone: 'live' },
          { label: 'Sent back / rejected', tone: 'back' },
        ],
      },
      ...inwardCompare(m, mine),
      {
        kind: 'timeline',
        title: 'Approval history',
        events: timeline(log.filter((r) => r.entity_id === m)),
        empty: 'No batch decision recorded for this month yet.',
      },
    ];

    return {
      id: `ip-${m}`,
      month: m,
      label: short(m),
      status,
      big: { value: inrShort(value), label: 'Planned value' },
      sub: `${mine.length} lines · ${products} products · ${vendors} vendors`,
      split: [
        { label: `${pending} pending`, tone: 'pending' as const },
        { label: `${approved} approved`, tone: 'live' as const },
        { label: `${back} sent back`, tone: 'back' as const },
      ],
      progress: { left: `${num(received)} / ${num(planned)} pcs received`, right: `${pct(received, planned)}%`, pct: pct(received, planned) },
      facts,
      warn: back > 0 && status !== 'closed' ? { text: `${back} line${back === 1 ? ' was' : 's were'} sent back or rejected and ${back === 1 ? 'is' : 'are'} waiting on the team.`, tone: 'back' as const } : undefined,
      actions: [{ label: 'Open', href: `/receivable-plan?tab=monthly&month=${m}`, primary: true }],
      list: [String(mine.length), String(pending), String(approved), String(back), num(planned), num(received), inrShort(value)],
      detail: {
        kicker: 'Inward Plan',
        lede: `What was planned to arrive in ${long(m)}, what the approver decided, and what actually landed.`,
        ring: {
          pct: pct(received, planned),
          over: received > planned,
          label: 'received',
          caption: 'Pieces received against the plan',
          sub: `${num(received)} of ${num(planned)} pcs`,
        },
        tiles: [
          { label: 'Planned value', value: inrShort(value) },
          { label: 'Received value', value: inrShort(receivedValue) },
          { label: 'Lines', value: String(mine.length) },
          { label: 'Products', value: String(products) },
          { label: 'Vendors', value: String(vendors) },
          { label: m < cur ? 'Lines short' : 'Pending lines', value: String(m < cur ? shortLines : pending) },
        ],
        sections,
      },
    };
  });
  // This month and next, when no line has been entered yet: what there is to start from — last
  // month's short lines (likely to carry over) and arrivals already entered in the weekly plan.
  for (const m of [cur, addMonths(cur, 1)]) {
    if (months.includes(m)) continue;
    const pm = addMonths(m, -1);
    const before = rows.filter((r) => r.plan_month === pm);
    const carry = before.filter((r) => n(r.inward_qty) > n(r.actual_inward_qty) && r.approval_status !== 'Rejected');
    const end = addMonths(m, 1);
    const expected = weekly.filter((w) => w.delivery_date_this_week && w.delivery_date_this_week >= m && w.delivery_date_this_week < end && n(w.qty_expected_this_week) > 0);
    const carryPcs = sumBy(carry, (r) => n(r.inward_qty) - n(r.actual_inward_qty));
    const expectedPcs = expected.reduce((t, w) => t + n(w.qty_expected_this_week), 0);
    cards.push({
      id: `ip-${m}`,
      month: m,
      label: short(m),
      status: 'draft',
      big: { value: '—', label: 'Planned value' },
      sub: 'Not started',
      facts: [m === cur ? 'No lines entered for this month yet' : `Opens 1 ${short(m).split(' ')[0]}`],
      actions: [{ label: 'Start plan', href: `/receivable-plan?tab=monthly&month=${m}`, primary: true }],
      list: ['0', '0', '0', '0', '—', '—', '—'],
      detail: {
        kicker: 'Inward Plan',
        lede: `No inward plan has been entered for ${long(m)} yet. Here is what there is to start from.`,
        tiles: [
          { label: `${short(pm)} lines`, value: before.length ? String(before.length) : '—' },
          { label: `${short(pm)} planned`, value: before.length ? `${num(sumBy(before, (r) => n(r.inward_qty)))} pcs` : '—' },
          { label: `${short(pm)} received`, value: before.length ? `${num(sumBy(before, (r) => n(r.actual_inward_qty)))} pcs` : '—' },
          { label: 'Still short from last month', value: carry.length ? `${num(carryPcs)} pcs · ${carry.length} lines` : 'None' },
          { label: 'Expected in weekly plan', value: expected.length ? `${num(expectedPcs)} pcs` : 'None' },
        ],
        sections: [
          {
            kind: 'table',
            title: `Short from ${short(pm)}`,
            hint: 'Lines that had not fully arrived by the end of last month — the likeliest to carry over.',
            columns: [{ label: 'PO' }, { label: 'Product' }, { label: 'Vendor' }, { label: 'Planned', num: true }, { label: 'Received', num: true }, { label: 'Short', num: true }],
            rows: carry
              .slice()
              .sort((a, b) => n(b.inward_qty) - n(b.actual_inward_qty) - (n(a.inward_qty) - n(a.actual_inward_qty)))
              .map((r) => ({
                tone: (n(r.actual_inward_qty) > 0 ? 'pending' : 'draft') as Tone,
                cells: [r.po_no ?? '—', r.product_code ?? '—', r.vendor_name ?? '—', num(n(r.inward_qty)), num(n(r.actual_inward_qty)), num(n(r.inward_qty) - n(r.actual_inward_qty))],
              })),
            filters: [
              { label: 'Nothing received', tone: 'draft' },
              { label: 'Part received', tone: 'pending' },
            ],
            empty: before.length ? 'Everything planned last month arrived.' : `There is no inward plan for ${long(pm)}.`,
          },
          {
            kind: 'table',
            title: 'Already expected in the weekly plan',
            hint: 'Deliveries the team has entered in Input inward plan with a date in this month.',
            columns: [{ label: 'PO' }, { label: 'Variant' }, { label: 'Expected on' }, { label: 'Qty', num: true }, { label: 'Status' }],
            rows: expected
              .slice()
              .sort((a, b) => (a.delivery_date_this_week ?? '').localeCompare(b.delivery_date_this_week ?? ''))
              .map((w) => ({
                tone: (w.status === 'approved' ? 'live' : w.status === 'submitted' || w.status === 'pending_l2' ? 'pending' : 'draft') as Tone,
                cells: [w.po_number ?? '—', w.product_variant ?? '—', dayYear(w.delivery_date_this_week), num(n(w.qty_expected_this_week)), w.status ? (STATUS_WORDS[w.status]?.[0] ?? w.status) : 'Draft'],
              })),
            filters: [
              { label: 'Approved', tone: 'live' },
              { label: 'Waiting for approval', tone: 'pending' },
              { label: 'Not submitted', tone: 'draft' },
            ],
            empty: 'Nothing entered for this month in the weekly plan yet.',
          },
        ],
      },
    });
  }

  return {
    columns: [
      { key: 'draft', label: 'Not started', tone: 'draft', hint: 'No lines entered for the month yet' },
      { key: 'pending', label: 'Pending approval', tone: 'pending', hint: 'Lines waiting for the approver' },
      { key: 'back', label: 'Needs rework', tone: 'back', hint: 'Lines sent back or rejected' },
      { key: 'live', label: 'Approved', tone: 'live', hint: 'Counts as the month’s plan' },
      { key: 'closed', label: 'Closed', tone: 'closed', hint: 'Month over · received vs planned final' },
    ],
    cards,
    totals: [
      { value: String(rows.length), label: 'Lines' },
      { value: num(rows.reduce((s, r) => s + n(r.inward_qty), 0)), label: 'Pcs planned' },
      { value: inrShort(rows.reduce((s, r) => s + n(r.inward_qty) * n(r.cost_per_piece), 0)), label: 'Planned value' },
    ],
    unit: 'months',
    listColumns: [
      { label: 'Lines', num: true },
      { label: 'Pending', num: true },
      { label: 'Approved', num: true },
      { label: 'Sent back', num: true },
      { label: 'Planned', num: true },
      { label: 'Received', num: true },
      { label: 'Value', num: true },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Vendor Capacity                                                     */
/* ------------------------------------------------------------------ */

/* Capacity weeks: Monday to Sunday, IST, keyed by the Monday's ISO date. */
const addDays = (iso: string, k: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);
const weekOf = (ts: string) => capacityWeekStart(new Date(ts));
const dayMon = (iso: string) => `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]}`;
/** "5 – 11 Oct 2026", "28 Sep – 4 Oct 2026". */
const weekShort = (w: string) => {
  const end = addDays(w, 6);
  return `${w.slice(5, 7) === end.slice(5, 7) ? Number(w.slice(8, 10)) : dayMon(w)} – ${dayMon(end)} ${end.slice(0, 4)}`;
};
const weekLong = (w: string) => `the week of ${weekShort(w)}`;
/** ISO-8601 week number of the week starting on Monday `w`. */
const isoWeekNo = (w: string) => {
  const thu = Date.parse(`${addDays(w, 3)}T00:00:00Z`);
  return Math.floor((thu - Date.UTC(new Date(thu).getUTCFullYear(), 0, 1)) / 86_400_000 / 7) + 1;
};

type CapacityRowJson = {
  vendor_code?: string | null;
  capacity_per_month?: number | null;
  machines_allocated?: number | null;
  active_karigar?: number | null;
  entry_date?: string | null;
  submitted_at?: string | null;
};
type CapacityEvent = { at: string; vendor: string; capacity: number; machines: number | null; karigar: number | null };

/** Every capacity update we know of: each vendor's live row plus the change trail. */
async function loadCapacityEvents(): Promise<CapacityEvent[]> {
  const supabase = await client();
  const [logs, trail] = await Promise.all([
    pageAll<{ vendor_code: string | null; capacity_per_month: number | null; machines_allocated: number | null; active_karigar: number | null; entry_date: string | null; submitted_at: string | null }>(() =>
      supabase.from('sd_vendor_capacity_log').select('vendor_code, capacity_per_month, machines_allocated, active_karigar, entry_date, submitted_at').order('id'),
    ),
    pageAll<{ changed_at: string; before: CapacityRowJson | null; after: CapacityRowJson | null }>(() =>
      supabase.from('sd_audit_log').select('changed_at, before, after').eq('table_name', 'sd_vendor_capacity_log').neq('op', 'DELETE').order('id'),
    ),
  ]);
  const events: CapacityEvent[] = [];
  for (const l of logs) {
    const at = l.entry_date ?? l.submitted_at;
    if (at && l.vendor_code)
      events.push({ at, vendor: l.vendor_code.toLowerCase(), capacity: n(l.capacity_per_month), machines: l.machines_allocated, karigar: l.active_karigar });
  }
  for (const t of trail) {
    const v = t.after?.vendor_code;
    if (v)
      events.push({
        at: t.changed_at,
        vendor: v.toLowerCase(),
        capacity: n(t.after?.capacity_per_month),
        machines: t.after?.machines_allocated ?? null,
        karigar: t.after?.active_karigar ?? null,
      });
    // The row an update overwrote: the only record left of that earlier entry.
    const b = t.before;
    const bAt = b?.entry_date ?? b?.submitted_at;
    if (b?.vendor_code && bAt)
      events.push({ at: bAt, vendor: b.vendor_code.toLowerCase(), capacity: n(b.capacity_per_month), machines: b.machines_allocated ?? null, karigar: b.active_karigar ?? null });
  }
  // The same entry can arrive twice (live row and an overwritten copy): keep one.
  const seen = new Set<string>();
  return events.filter((e) => {
    const k = `${e.vendor}|${Date.parse(e.at)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Vendor capacity as it stood at the end of the week starting on Monday `week`: each vendor's
 * last update made before the following Monday (IST). Keyed by lower-case vendor code.
 */
export async function loadVendorCapacityAsOfWeek(
  week: string,
): Promise<Map<string, { at: string; capacity: number; machines: number | null; karigar: number | null }>> {
  const until = Date.parse(`${addDays(week, 7)}T00:00:00+05:30`);
  const out = new Map<string, CapacityEvent>();
  for (const e of await loadCapacityEvents()) {
    const t = Date.parse(e.at);
    if (!(t < until)) continue;
    const had = out.get(e.vendor);
    if (!had || Date.parse(had.at) < t) out.set(e.vendor, e);
  }
  return out;
}

/**
 * Vendor Capacity is updated weekly, so its board has one card per Monday-to-Sunday week (IST),
 * the same week the update screen locks a vendor for (capacityWeekStart).
 * Capacity keeps one live row per vendor (overwritten on update), so a week's updates are
 * read from the change trail (sd_audit_log, kept since 5 Oct 2026) plus each vendor's
 * last-update date. Weeks before the trail only show vendors whose LATEST update fell in them,
 * and only weeks that hold such an update are listed.
 */
export async function loadVendorCapacityBoard(
  activeVendors: { code: string; name: string; signed: number }[],
): Promise<MonthBoardData> {
  const events = await loadCapacityEvents();
  type Ev = CapacityEvent;
  const active = new Map(activeVendors.map((v) => [v.code.toLowerCase(), v]));
  const total = activeVendors.length;
  const cur = capacityWeekStart();
  const TRAIL_WEEK = weekOf('2026-10-01T00:00:00+05:30');
  // Every week since the trail began (an empty week is worth seeing), earlier weeks only when
  // someone's latest update fell in them. The board stops at the running week (no future card).
  const weekSet = new Set<string>([cur]);
  for (let w = TRAIL_WEEK; w <= cur; w = addDays(w, 7)) weekSet.add(w);
  for (const e of events) if (weekOf(e.at) <= cur) weekSet.add(weekOf(e.at));
  const months = [...weekSet].sort();

  const nameOfVendor = (k: string) => active.get(k)?.name ?? k.toUpperCase();
  const monthEnd = (m: string) => new Date(`${addDays(m, 7)}T00:00:00+05:30`).getTime();
  /** Each vendor's most recent update on or before a moment. */
  const lastUpdateBy = (until: number) => {
    const out = new Map<string, Ev>();
    for (const e of events) {
      if (new Date(e.at).getTime() >= until) continue;
      const had = out.get(e.vendor);
      if (!had || had.at < e.at) out.set(e.vendor, e);
    }
    return out;
  };
  const STALE_DAYS = 30;
  // The change trail starts 5 Oct 2026; before it only each vendor's latest update survives, so a
  // vendor with no record then may simply have been updated again later.
  const TRAIL_FROM = TRAIL_WEEK;

  /** Vendors to look at: no update in 30+ days, declared well under signed, or nothing declared. */
  const vcAttention = (m: string): MonthDetailSection => {
    const asOf = Math.min(Date.now(), monthEnd(m));
    const known = lastUpdateBy(asOf);
    const out: { tone: Tone; cells: string[] }[] = [];
    for (const v of activeVendors) {
      const e = known.get(v.code.toLowerCase());
      if (!e) {
        if (m >= TRAIL_FROM) out.push({ tone: 'back', cells: [v.name, 'Never updated', 'No capacity on record'] });
        continue;
      }
      const age = Math.floor((asOf - new Date(e.at).getTime()) / 86_400_000);
      if (age >= STALE_DAYS) out.push({ tone: 'pending', cells: [v.name, `Not updated for ${age} days`, `Last update ${dayYear(e.at)}`] });
      if (e.capacity <= 0) out.push({ tone: 'back', cells: [v.name, 'No capacity declared', `Latest update ${dayYear(e.at)} has 0 pcs / month`] });
      else if (v.signed && e.capacity < v.signed * 0.5)
        out.push({ tone: 'draft', cells: [v.name, 'Well under signed', `${num(e.capacity)} declared against ${num(v.signed)} signed (${pct(e.capacity, v.signed)}%)`] });
    }
    return {
      kind: 'table',
      title: 'Needs attention',
      hint: `Active vendors as of ${m === cur ? 'today' : `the end of ${weekLong(m)}`}: never updated, not updated for ${STALE_DAYS}+ days, nothing declared, or under half the signed capacity.${
        m < TRAIL_FROM ? ' Before October 2026 only each vendor’s latest update was kept, so vendors updated again later do not show here.' : ''
      }`,
      columns: [{ label: 'Vendor' }, { label: 'Issue' }, { label: 'Detail' }],
      rows: out,
      filters: [
        { label: 'Missing', tone: 'back' },
        { label: 'Out of date', tone: 'pending' },
        { label: 'Under signed', tone: 'draft' },
      ],
      empty: 'Every active vendor is up to date.',
    };
  };

  /** Declared capacity per vendor against the week before. */
  const vcCompare = (m: string, latest: Map<string, Ev>): MonthDetailSection[] => {
    const pm = addDays(m, -7);
    const before = new Map<string, Ev>();
    for (const e of events.filter((x) => weekOf(x.at) === pm).sort((a, b) => a.at.localeCompare(b.at))) before.set(e.vendor, e);
    const title = `Compared with ${weekLong(pm)}`;
    if (!before.size && !latest.size) return [{ kind: 'bars', title, bars: [], empty: `No updates in ${weekLong(pm)} or ${weekLong(m)} to compare.` }];
    const sumCap = (mp: Map<string, Ev>) => [...mp.values()].reduce((t, e) => t + e.capacity, 0);
    const change = (a: number, b: number) => (b === 0 ? (a === 0 ? '—' : 'new') : `${a >= b ? '+' : '−'}${Math.abs(Math.round(((a - b) / b) * 100))}%`);
    const vendorRows = [...new Set([...before.keys(), ...latest.keys()])]
      .map((k) => {
        const a = latest.get(k)?.capacity;
        const b = before.get(k)?.capacity;
        const tone: Tone = b == null ? 'draft' : a == null ? 'closed' : a > b ? 'live' : a < b ? 'pending' : 'closed';
        return {
          d: Math.abs((a ?? 0) - (b ?? 0)),
          tone,
          cells: [nameOfVendor(k), b == null ? '—' : num(b), a == null ? 'not updated' : num(a), a == null || b == null ? '—' : `${a >= b ? '+' : '−'}${num(Math.abs(a - b))}`, a == null || b == null ? '—' : change(a, b)],
        };
      })
      .sort((x, y) => y.d - x.d)
      .map(({ tone, cells }) => ({ tone, cells }));
    return [
      {
        kind: 'table',
        title,
        hint: `Vendors updated and capacity declared in ${weekLong(pm)} against ${weekLong(m)}.${
          pm < TRAIL_FROM ? ` Incomplete: before October 2026 only each vendor’s latest update was kept, so that week is missing updates that were later replaced.` : ''
        }`,
        columns: [{ label: 'Measure' }, { label: weekShort(pm), num: true }, { label: weekShort(m), num: true }, { label: 'Change', num: true }],
        rows: [
          { cells: ['Vendors updated', String(before.size), String(latest.size), change(latest.size, before.size)] },
          { cells: ['Pcs / month declared', num(sumCap(before)), num(sumCap(latest)), change(sumCap(latest), sumCap(before))] },
          { cells: ['Updates made', String(events.filter((x) => weekOf(x.at) === pm).length), String(events.filter((x) => weekOf(x.at) === m).length), '—'] },
        ],
      },
      {
        kind: 'table',
        title: `Capacity changes vs ${weekLong(pm)}`,
        hint: 'Each vendor’s latest declared pcs / month in each week.',
        columns: [{ label: 'Vendor' }, { label: weekShort(pm), num: true }, { label: weekShort(m), num: true }, { label: 'Change', num: true }, { label: '%', num: true }],
        rows: vendorRows,
        filters: [
          { label: 'First update', tone: 'draft' },
          { label: 'Raised', tone: 'live' },
          { label: 'Cut', tone: 'pending' },
          { label: 'Same / not updated', tone: 'closed' },
        ],
        empty: 'No capacity changes between the two weeks.',
      },
    ];
  };

  /** Next week's card: who to chase first, from each vendor's last update. */
  const vcUpcoming = (m: string): NonNullable<MonthBoardCard['detail']> => {
    const known = lastUpdateBy(Date.now());
    const rowsUp = activeVendors
      .map((v) => {
        const e = known.get(v.code.toLowerCase());
        const age = e ? Math.floor((Date.now() - new Date(e.at).getTime()) / 86_400_000) : null;
        return { age: age ?? 1e9, tone: (e == null ? 'back' : age! >= STALE_DAYS ? 'pending' : 'live') as Tone, cells: [v.name, e ? dayYear(e.at) : 'Never', age == null ? '—' : `${age} d`, e ? num(e.capacity) : '—', v.signed ? num(v.signed) : '—'] };
      })
      .sort((a, b) => b.age - a.age)
      .map(({ tone, cells }) => ({ tone, cells }));
    const lastTotal = [...known.entries()].filter(([k]) => active.has(k)).reduce((t, [, e]) => t + e.capacity, 0);
    const stale = rowsUp.filter((r) => r.tone !== 'live').length;
    return {
      kicker: 'Vendor Capacity',
      lede: `${weekShort(m)} has not started. Every active vendor will need a fresh update; the ones with the oldest figures are first.`,
      tiles: [
        { label: 'Active vendors', value: String(total) },
        { label: 'Last known pcs / month', value: num(lastTotal) },
        { label: `Not updated for ${STALE_DAYS}+ days`, value: String(stale) },
        { label: 'Signed capacity', value: num(activeVendors.reduce((t, v) => t + n(v.signed), 0)) },
      ],
      sections: [
        {
          kind: 'table',
          title: 'Who to update first',
          hint: 'Active vendors, oldest update first.',
          columns: [{ label: 'Vendor' }, { label: 'Last update' }, { label: 'Age', num: true }, { label: 'Last pcs / month', num: true }, { label: 'Signed', num: true }],
          rows: rowsUp,
          filters: [
            { label: 'Never updated', tone: 'back' },
            { label: `${STALE_DAYS}+ days old`, tone: 'pending' },
            { label: 'Recent', tone: 'live' },
          ],
        },
      ],
    };
  };

  const cards: MonthBoardCard[] = months.map((m) => {
    const mine = events.filter((e) => weekOf(e.at) === m).sort((a, b) => a.at.localeCompare(b.at));
    const latest = new Map<string, Ev>();
    for (const e of mine) latest.set(e.vendor, e);
    const updatedActive = [...latest.keys()].filter((k) => active.has(k));
    const updated = updatedActive.length;
    const capacity = [...latest.values()].reduce((s, e) => s + e.capacity, 0);
    const signed = updatedActive.reduce((s, k) => s + n(active.get(k)?.signed), 0);
    const lastAt = mine.length ? mine[mine.length - 1].at : null;
    const status = m > cur ? 'draft' : m === cur ? (updated === 0 ? 'draft' : updated >= total ? 'live' : 'pending') : 'closed';
    const facts: string[] = [];
    facts.push(`Week ${isoWeekNo(m)} · Monday to Sunday`);
    if (m > cur) facts.push(`Opens Monday ${dayMon(m)}`);
    else if (lastAt) facts.push(`Last update ${day(lastAt)}`);
    if (m === cur && updated < total) facts.push(`${total - updated} vendor${total - updated === 1 ? '' : 's'} still to update`);
    if (m < TRAIL_FROM) facts.push('Before Oct 2026 only each vendor’s latest update is known');

    /* ---- overview ---- */
    const nameOf = (k: string) => active.get(k)?.name ?? k.toUpperCase();
    const vendorRows = [
      ...[...latest.values()]
        .sort((a, b) => b.capacity - a.capacity)
        .map((e) => {
          const s = n(active.get(e.vendor)?.signed);
          return {
            tone: (active.has(e.vendor) ? 'live' : 'closed') as Tone,
            cells: [
              nameOf(e.vendor),
              dayYear(e.at),
              num(e.capacity),
              s ? num(s) : '—',
              s ? (e.capacity >= s ? 'at or above signed' : `${pct(e.capacity, s)}% of signed`) : '—',
              e.machines == null ? '—' : num(e.machines),
              e.karigar == null ? '—' : num(e.karigar),
            ],
          };
        }),
      ...(m <= cur
        ? activeVendors
            .filter((v) => !latest.has(v.code.toLowerCase()))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((v) => ({ tone: 'pending' as Tone, cells: [v.name, 'Not updated', '—', v.signed ? num(v.signed) : '—', '—', '—', '—'] }))
        : []),
    ];
    const sections: MonthDetailSection[] = [
      vcAttention(m),
      {
        kind: 'bars',
        title: 'Largest declared capacity',
        hint: 'Pieces per month each vendor declared in this week’s update.',
        bars: [...latest.values()]
          .sort((a, b) => b.capacity - a.capacity)
          .slice(0, 10)
          .map((e) => ({ label: nameOf(e.vendor), value: `${num(e.capacity)} pcs`, pct: pct(e.capacity, Math.max(...[...latest.values()].map((x) => x.capacity), 1)), tone: 'live' as Tone })),
        empty: 'No vendor updated capacity in this week.',
      },
      {
        kind: 'table',
        title: 'Vendors',
        hint: m <= cur ? 'Who updated this week, and the active vendors still to update.' : undefined,
        columns: [
          { label: 'Vendor' },
          { label: 'Updated' },
          { label: 'Pcs / month', num: true },
          { label: 'Signed', num: true },
          { label: 'vs signed', num: true },
          { label: 'Machines', num: true },
          { label: 'Karigars', num: true },
        ],
        rows: vendorRows,
        filters: m <= cur ? [{ label: 'Updated', tone: 'live' }, { label: 'Not updated', tone: 'pending' }] : undefined,
        empty: 'Nothing to show for this week.',
      },
      ...vcCompare(m, latest),
    ];

    return {
      id: `vc-${m}`,
      month: m,
      label: weekShort(m),
      status,
      big: { value: updated ? num(capacity) : '—', label: 'Pcs / month declared' },
      progress: m > cur ? undefined : { left: `${updated} / ${total} vendors updated`, right: `${pct(updated, total)}%`, pct: pct(updated, total) },
      facts,
      warn: m <= cur && updated === 0 ? { text: 'No vendor updated capacity in this week.', tone: 'pending' as const } : undefined,
      actions: [m === cur ? { label: 'Update vendors', href: '/vendor-capacity?view=vendors', primary: true } : { label: 'Open', href: `/vendor-capacity?view=vendors&week=${m}`, primary: true }],
      list: [`${updated} / ${total}`, updated ? num(capacity) : '—'],
      detail:
        m > cur
          ? vcUpcoming(m)
          : {
              kicker: 'Vendor Capacity',
              lede: `Capacity updates made in ${weekLong(m)}.${m < TRAIL_FROM ? ' Before October 2026 only each vendor’s latest update was kept.' : ''}`,
              ring: { pct: pct(updated, total), label: 'updated', caption: 'Active vendors who updated', sub: `${updated} of ${total} vendors` },
              tiles: [
                { label: 'Declared pcs / month', value: updated ? num(capacity) : '—' },
                { label: 'Signed (same vendors)', value: signed ? num(signed) : '—' },
                { label: 'Still to update', value: m <= cur ? String(total - updated) : '—' },
                { label: 'Updates made', value: String(mine.length) },
                { label: 'Last update', value: lastAt ? dayYear(lastAt) : '—' },
              ],
              sections,
            },
    };
  });
  const now = cards.find((c) => c.month === cur);
  return {
    columns: [
      { key: 'draft', label: 'Not started', tone: 'draft', hint: 'No vendor updated yet' },
      { key: 'pending', label: 'In progress', tone: 'pending', hint: 'Some vendors updated' },
      { key: 'live', label: 'Complete', tone: 'live', hint: 'Every active vendor updated' },
      { key: 'closed', label: 'Past weeks', tone: 'closed', hint: 'Kept for history' },
    ],
    cards,
    totals: [
      { value: now?.list[0] ?? `0 / ${total}`, label: 'Updated this week' },
      { value: now?.list[1] ?? '—', label: 'Pcs / month declared' },
    ],
    unit: 'weeks',
    noun: 'week',
    cardClick: 'open',
    listColumns: [{ label: 'Vendors updated', num: true }, { label: 'Pcs / month', num: true }],
  };
}

