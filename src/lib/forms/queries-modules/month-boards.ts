import 'server-only';
import { client, pageAll } from './_shared';
import { loadApprovedStandardCosts } from './standard-cost';
import { addMonths, isPlanFrozen, monthStart } from '../approval';
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
const istMonth = (ts: string) => monthStart(new Date(ts));
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
};

export async function loadBuyingPlanBoard(deadlineDay = 7): Promise<MonthBoardData> {
  const supabase = await client();
  const [plans, lines, actuals, costs, catalog, log] = await Promise.all([
    pageAll<{ id: number; plan_month: string; plan_type: string | null; status: string; submitted_at: string | null; approved_at: string | null; rework_notes: string | null; rejection_notes: string | null }>(() =>
      supabase.from('sd_buying_plan').select('id, plan_month, plan_type, status, submitted_at, approved_at, rework_notes, rejection_notes').order('id'),
    ),
    pageAll<PlanLine>(() =>
      supabase
        .from('sd_buying_plan_line')
        .select('plan_id, product_code, product_status, job_work_qty, fob_qty, efob_qty, standard_value, line_status, material_type, colour, uom')
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
  ]);
  const categoryOf = new Map(catalog.map((c) => [c.product_code.trim().toUpperCase(), c.category || 'Uncategorised']));
  // Same value rule as the plan screen: once submitted, a line's value frozen at submission;
  // while being edited (or when nothing was frozen), its quantities at today's approved cost.
  const editing = new Set(plans.filter((p) => !['submitted', 'pending_l2', 'approved'].includes(p.status)).map((p) => p.id));
  const qtyOf = (l: PlanLine) => n(l.job_work_qty) + n(l.fob_qty) + n(l.efob_qty);
  const lineSplit = (l: PlanLine) => {
    const stored = n(l.standard_value);
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

    const issued = track === 'fg' ? issuedByMonth.get(p.plan_month) ?? 0 : null;
    const href = `/buying-plan?month=${p.plan_month}&type=${track}`;
    const actions: MonthBoardCard['actions'] = [
      { label: status === 'draft' ? 'Edit plan' : 'Open', href: status === 'draft' ? `${href}&mode=input` : href, primary: true },
      ...(track === 'fg' && (status === 'live' || status === 'closed')
        ? [{ label: 'Analysis', href: `/buying-plan?month=${p.plan_month}&type=analysis` }]
        : []),
    ];

    /* ---- overview ---- */
    const sections: MonthDetailSection[] = [];
    const tiles: { label: string; value: string }[] = [
      { label: 'Plan value', value: value == null ? '—' : inrShort(value) },
      { label: track === 'fg' ? 'Products' : 'Materials', value: String(products) },
      { label: track === 'fg' ? 'Pcs planned' : 'Qty planned', value: num(qty) },
      { label: 'Deadline', value: `${deadlineDay} ${short(p.plan_month)}` },
      { label: 'Submitted', value: p.submitted_at ? `${day(p.submitted_at)} · ${onTime ? 'on time' : 'late'}` : 'Not yet' },
      {
        label: 'Approved',
        value: p.approved_at ? dayYear(p.approved_at) : status === 'pending' && p.submitted_at ? `Waiting ${daysSince(p.submitted_at)} d` : '—',
      },
    ];
    let ring: NonNullable<MonthBoardCard['detail']>['ring'];

    if (track === 'fg') {
      const monthActuals = actualsByMonth.get(p.plan_month) ?? [];
      const issuedByCode = new Map(monthActuals.map((a) => [a.product_code.trim().toUpperCase(), a]));
      const issuedValue = monthActuals.reduce((s, a) => s + n(a.issued_value), 0);
      const pos = monthActuals.reduce((s, a) => s + n(a.po_count), 0);
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
      // Material track: the lines themselves.
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
        columns: [{ label: 'Material' }, { label: 'Type' }, { label: 'Colour' }, { label: 'Qty', num: true }, { label: 'Unit' }, { label: 'Status' }],
        rows: withQty.map((l) => ({
          tone: (l.line_status === 'approved' ? 'live' : l.line_status ? 'pending' : 'draft') as Tone,
          cells: [l.product_code ?? '—', l.material_type ?? '—', l.colour ?? '—', num(qtyOf(l)), l.uom ?? '—', l.line_status ? (STATUS_WORDS[l.line_status]?.[0] ?? l.line_status) : 'Draft'],
        })),
        empty: 'No materials on this plan yet.',
      });
    }

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

  // This month's and next month's FG plan, when not started yet.
  for (const m of [monthStart(), addMonths(monthStart(), 1)]) {
    if (plans.some((p) => p.plan_month === m && (p.plan_type ?? 'fg') !== 'material')) continue;
    cards.push({
      id: `bp-new-${m}`,
      month: m,
      label: short(m),
      track: 'FG',
      status: 'draft',
      big: { value: '—', label: 'Plan value' },
      sub: 'Not started',
      facts: [`Submit by ${deadlineDay} ${short(m).split(' ')[0]}`],
      actions: [{ label: 'Start plan', href: `/buying-plan?month=${m}&type=fg&mode=input`, primary: true }],
      list: ['0', '—', '—', '—'],
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
    listColumns: [{ label: 'Products', num: true }, { label: 'Pcs planned', num: true }, { label: 'Issued', num: true }, { label: 'Value', num: true }],
  };
}

/* ------------------------------------------------------------------ */
/* Inward Plan                                                         */
/* ------------------------------------------------------------------ */

export async function loadInwardPlanBoard(): Promise<MonthBoardData> {
  const supabase = await client();
  const [rows, log] = await Promise.all([
    pageAll<{ plan_month: string; product_code: string | null; po_no: string | null; vendor_name: string | null; inward_qty: number | null; actual_inward_qty: number | null; cost_per_piece: number | null; approval_status: string | null; mt_comments: string | null }>(() =>
      supabase
        .from('sd_inward_plan_entry')
        .select('plan_month, product_code, po_no, vendor_name, inward_qty, actual_inward_qty, cost_per_piece, approval_status, mt_comments')
        .order('id'),
    ),
    loadLog(['inward_plan']),
  ]);
  const cur = monthStart();
  const prev = addMonths(cur, -1);
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
      {
        kind: 'bars',
        title: 'Lines by decision',
        bars: [
          { label: 'Pending approval', value: `${pending} · ${pct(pending, mine.length)}%`, pct: pct(pending, mine.length), tone: 'pending' as Tone },
          { label: 'Approved', value: `${approved} · ${pct(approved, mine.length)}%`, pct: pct(approved, mine.length), tone: 'live' as Tone },
          { label: 'Sent back or rejected', value: `${back} · ${pct(back, mine.length)}%`, pct: pct(back, mine.length), tone: 'back' as Tone },
        ],
      },
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
  return {
    columns: [
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

/**
 * Capacity keeps one live row per vendor (overwritten on update), so a month's updates are
 * read from the change trail (sd_audit_log, kept since 5 Oct 2026) plus each vendor's
 * last-update date. Months before the trail only show vendors whose LATEST update fell in them.
 */
export async function loadVendorCapacityBoard(
  activeVendors: { code: string; name: string; signed: number }[],
): Promise<MonthBoardData> {
  const supabase = await client();
  const [logs, trail] = await Promise.all([
    pageAll<{ vendor_code: string | null; capacity_per_month: number | null; machines_allocated: number | null; active_karigar: number | null; entry_date: string | null; submitted_at: string | null }>(() =>
      supabase.from('sd_vendor_capacity_log').select('vendor_code, capacity_per_month, machines_allocated, active_karigar, entry_date, submitted_at').order('id'),
    ),
    pageAll<{ changed_at: string; after: { vendor_code?: string | null; capacity_per_month?: number | null; machines_allocated?: number | null; active_karigar?: number | null } | null }>(() =>
      supabase.from('sd_audit_log').select('changed_at, after').eq('table_name', 'sd_vendor_capacity_log').neq('op', 'DELETE').order('id'),
    ),
  ]);
  type Ev = { at: string; vendor: string; capacity: number; machines: number | null; karigar: number | null };
  const events: Ev[] = [];
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
  }
  const active = new Map(activeVendors.map((v) => [v.code.toLowerCase(), v]));
  const total = activeVendors.length;
  const cur = monthStart();
  const first = events.length ? events.map((e) => istMonth(e.at)).sort()[0] : cur;
  const months: string[] = [];
  for (let m = first; m <= addMonths(cur, 1); m = addMonths(m, 1)) months.push(m);

  const cards: MonthBoardCard[] = months.map((m) => {
    const mine = events.filter((e) => istMonth(e.at) === m).sort((a, b) => a.at.localeCompare(b.at));
    const latest = new Map<string, Ev>();
    for (const e of mine) latest.set(e.vendor, e);
    const updatedActive = [...latest.keys()].filter((k) => active.has(k));
    const updated = updatedActive.length;
    const capacity = [...latest.values()].reduce((s, e) => s + e.capacity, 0);
    const signed = updatedActive.reduce((s, k) => s + n(active.get(k)?.signed), 0);
    const lastAt = mine.length ? mine[mine.length - 1].at : null;
    const status = m > cur ? 'draft' : m === cur ? (updated === 0 ? 'draft' : updated >= total ? 'live' : 'pending') : 'closed';
    const facts: string[] = [];
    if (m > cur) facts.push(`Opens 1 ${short(m).split(' ')[0]}`);
    else if (lastAt) facts.push(`Last update ${day(lastAt)}`);
    if (m === cur && updated < total) facts.push(`${total - updated} vendor${total - updated === 1 ? '' : 's'} still to update`);
    if (m < '2026-10-01') facts.push('Before Oct 2026 only each vendor’s latest update is known');

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
      {
        kind: 'bars',
        title: 'Largest declared capacity',
        hint: 'Pieces per month each vendor declared in this month’s update.',
        bars: [...latest.values()]
          .sort((a, b) => b.capacity - a.capacity)
          .slice(0, 10)
          .map((e) => ({ label: nameOf(e.vendor), value: `${num(e.capacity)} pcs`, pct: pct(e.capacity, Math.max(...[...latest.values()].map((x) => x.capacity), 1)), tone: 'live' as Tone })),
        empty: 'No vendor updated capacity in this month.',
      },
      {
        kind: 'table',
        title: 'Vendors',
        hint: m <= cur ? 'Who updated this month, and the active vendors still to update.' : undefined,
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
        empty: 'Nothing to show for this month.',
      },
    ];

    return {
      id: `vc-${m}`,
      month: m,
      label: short(m),
      status,
      big: { value: updated ? num(capacity) : '—', label: 'Pcs / month declared' },
      progress: m > cur ? undefined : { left: `${updated} / ${total} vendors updated`, right: `${pct(updated, total)}%`, pct: pct(updated, total) },
      facts,
      warn: m <= cur && updated === 0 ? { text: 'No vendor updated capacity in this month.', tone: 'pending' as const } : undefined,
      actions: [{ label: m === cur ? 'Update vendors' : 'Open', href: '/vendor-capacity?view=vendors', primary: true }],
      list: [`${updated} / ${total}`, updated ? num(capacity) : '—'],
      detail:
        m > cur
          ? undefined
          : {
              kicker: 'Vendor Capacity',
              lede: `Capacity updates made in ${long(m)}.${m < '2026-10-01' ? ' Before October 2026 only each vendor’s latest update was kept.' : ''}`,
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
      { key: 'closed', label: 'Past months', tone: 'closed', hint: 'Kept for history' },
    ],
    cards,
    totals: [
      { value: now?.list[0] ?? `0 / ${total}`, label: 'Updated this month' },
      { value: now?.list[1] ?? '—', label: 'Pcs / month declared' },
    ],
    unit: 'months',
    listColumns: [{ label: 'Vendors updated', num: true }, { label: 'Pcs / month', num: true }],
  };
}

