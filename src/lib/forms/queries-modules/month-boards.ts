import 'server-only';
import { client, pageAll } from './_shared';
import { loadApprovedStandardCosts } from './standard-cost';
import { addMonths, isPlanFrozen, monthStart } from '../approval';
import { inrShort, num, type MonthBoardCard, type MonthBoardData } from '@/lib/month-board';

// The month boards: the landing view of Buying Plan, Vendor Capacity and Inward Plan.
// One card per month (per track for Buying Plan), built from the same tables the month
// screens read, so a card and the screen it opens never disagree.

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const short = (iso: string) => `${MON[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const day = (ts: string | null) => {
  if (!ts) return null;
  const d = new Date(new Date(ts).getTime() + 5.5 * 3600_000); // IST
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
};
const istMonth = (ts: string) => monthStart(new Date(ts));
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
const daysSince = (ts: string) => Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 86_400_000));

/* ------------------------------------------------------------------ */
/* Buying Plan                                                         */
/* ------------------------------------------------------------------ */

export async function loadBuyingPlanBoard(deadlineDay = 7): Promise<MonthBoardData> {
  const supabase = await client();
  const [plans, lines, actuals, costs] = await Promise.all([
    pageAll<{ id: number; plan_month: string; plan_type: string | null; status: string; submitted_at: string | null; approved_at: string | null; rework_notes: string | null; rejection_notes: string | null }>(() =>
      supabase.from('sd_buying_plan').select('id, plan_month, plan_type, status, submitted_at, approved_at, rework_notes, rejection_notes').order('id'),
    ),
    pageAll<{ plan_id: number; product_code: string | null; job_work_qty: number | null; fob_qty: number | null; efob_qty: number | null; standard_value: number | null }>(() =>
      supabase.from('sd_buying_plan_line').select('plan_id, product_code, job_work_qty, fob_qty, efob_qty, standard_value').order('id'),
    ),
    pageAll<{ plan_month: string; issued_qty: number | null }>(() =>
      supabase.from('sd_po_actuals_by_product_month').select('plan_month, issued_qty').order('plan_month').order('product_code'),
    ),
    loadApprovedStandardCosts(),
  ]);
  // Same value rule as the plan screen: once submitted, a line's value frozen at submission;
  // while being edited (or when nothing was frozen), its quantities at today's approved cost.
  const editing = new Set(plans.filter((p) => !['submitted', 'pending_l2', 'approved'].includes(p.status)).map((p) => p.id));
  const lineValue = (l: (typeof lines)[number]) => {
    const stored = Number(l.standard_value) || 0;
    const c = l.product_code ? costs[l.product_code] : undefined;
    if (stored > 0 && (!editing.has(l.plan_id) || !c)) return stored;
    return c ? (Number(l.job_work_qty) || 0) * c.job + (Number(l.fob_qty) || 0) * c.fob + (Number(l.efob_qty) || 0) * c.efob : 0;
  };
  const issuedByMonth = new Map<string, number>();
  for (const a of actuals) issuedByMonth.set(a.plan_month, (issuedByMonth.get(a.plan_month) ?? 0) + (Number(a.issued_qty) || 0));

  const cards: MonthBoardCard[] = [];
  for (const p of plans) {
    const track = p.plan_type === 'material' ? 'material' : 'fg';
    const mine = lines.filter((l) => l.plan_id === p.id);
    const qty = mine.reduce((s, l) => s + (Number(l.job_work_qty) || 0) + (Number(l.fob_qty) || 0) + (Number(l.efob_qty) || 0), 0);
    const withQty = mine.filter((l) => (Number(l.job_work_qty) || 0) + (Number(l.fob_qty) || 0) + (Number(l.efob_qty) || 0) > 0);
    const values = withQty.map(lineValue);
    const unvalued = values.filter((v) => v <= 0).length;
    const total = values.reduce((s, v) => s + v, 0);
    const value = total > 0 ? total : null;
    const products = new Set(mine.map((l) => l.product_code).filter(Boolean)).size;
    const frozen = isPlanFrozen(p.plan_month);
    const status =
      p.status === 'approved' ? (frozen ? 'closed' : 'live') : p.status === 'submitted' || p.status === 'pending_l2' ? 'pending' : 'draft';
    const facts: string[] = [];
    const deadline = new Date(`${p.plan_month.slice(0, 8)}${String(deadlineDay).padStart(2, '0')}T18:29:59Z`); // 23:59:59 IST
    if (p.submitted_at) {
      facts.push(`Submitted ${day(p.submitted_at)} · ${new Date(p.submitted_at) <= deadline ? 'on time' : `late (after the ${deadlineDay}th)`}`);
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
    cards.push({
      id: `bp-${p.id}`,
      month: p.plan_month,
      label: short(p.plan_month),
      track: track === 'fg' ? 'FG' : 'Material',
      status,
      big: { value: value == null ? '—' : inrShort(value), label: 'Plan value' },
      sub: `${products} product${products === 1 ? '' : 's'} · ${num(qty)} pcs planned${p.status === 'pending_l2' ? ' · with the second approver' : p.status === 'submitted' ? ' · with the approver' : ''}`,
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
      actions: [
        { label: 'Open', href, primary: true },
        ...(track === 'fg' && (status === 'live' || status === 'closed')
          ? [{ label: 'Analysis', href: `/buying-plan?month=${p.plan_month}&type=analysis` }]
          : []),
      ],
      list: [String(products), num(qty), issued == null ? '—' : num(issued), value == null ? '—' : inrShort(value)],
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
      actions: [{ label: 'Start plan', href: `/buying-plan?month=${m}&type=fg`, primary: true }],
      list: ['0', '—', '—', '—'],
    });
  }

  const started = cards.filter((c) => !c.id.startsWith('bp-new-'));
  const totalQty = plans.reduce((s, p) => s + lines.filter((l) => l.plan_id === p.id).reduce((t, l) => t + (Number(l.job_work_qty) || 0) + (Number(l.fob_qty) || 0) + (Number(l.efob_qty) || 0), 0), 0);
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
  const rows = await pageAll<{ plan_month: string; product_code: string | null; vendor_name: string | null; inward_qty: number | null; actual_inward_qty: number | null; cost_per_piece: number | null; approval_status: string | null }>(() =>
    supabase.from('sd_inward_plan_entry').select('plan_month, product_code, vendor_name, inward_qty, actual_inward_qty, cost_per_piece, approval_status').order('id'),
  );
  const cur = monthStart();
  const prev = addMonths(cur, -1);
  const months = [...new Set(rows.map((r) => r.plan_month))];
  const cards: MonthBoardCard[] = months.map((m) => {
    const mine = rows.filter((r) => r.plan_month === m);
    const pending = mine.filter((r) => r.approval_status === 'Pending').length;
    const approved = mine.filter((r) => r.approval_status === 'Approved').length;
    const back = mine.filter((r) => r.approval_status === 'RE-WORK' || r.approval_status === 'Rejected').length;
    const planned = mine.reduce((s, r) => s + (Number(r.inward_qty) || 0), 0);
    const received = mine.reduce((s, r) => s + (Number(r.actual_inward_qty) || 0), 0);
    const value = mine.reduce((s, r) => s + (Number(r.inward_qty) || 0) * (Number(r.cost_per_piece) || 0), 0);
    const products = new Set(mine.map((r) => r.product_code).filter(Boolean)).size;
    const vendors = new Set(mine.map((r) => r.vendor_name).filter(Boolean)).size;
    // Older months are closed; the month just gone stays open while lines are still undecided.
    const open = m >= cur || (m === prev && (pending > 0 || back > 0));
    const status = !open ? 'closed' : pending > 0 ? 'pending' : back > 0 ? 'back' : 'live';
    const facts: string[] = [];
    if (received === 0) facts.push(m > cur ? 'Month not started' : 'Nothing received yet');
    if (m < cur && pending > 0) facts.push(`Month is over · ${pending} line${pending === 1 ? '' : 's'} never decided`);
    if (status === 'closed') facts.push('Month closed');
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
      { value: num(rows.reduce((s, r) => s + (Number(r.inward_qty) || 0), 0)), label: 'Pcs planned' },
      { value: inrShort(rows.reduce((s, r) => s + (Number(r.inward_qty) || 0) * (Number(r.cost_per_piece) || 0), 0)), label: 'Planned value' },
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
export async function loadVendorCapacityBoard(activeVendors: number): Promise<MonthBoardData> {
  const supabase = await client();
  const [logs, trail] = await Promise.all([
    pageAll<{ vendor_code: string | null; capacity_per_month: number | null; entry_date: string | null; submitted_at: string | null }>(() =>
      supabase.from('sd_vendor_capacity_log').select('vendor_code, capacity_per_month, entry_date, submitted_at').order('id'),
    ),
    pageAll<{ changed_at: string; after: { vendor_code?: string | null; capacity_per_month?: number | null } | null }>(() =>
      supabase.from('sd_audit_log').select('changed_at, after').eq('table_name', 'sd_vendor_capacity_log').neq('op', 'DELETE').order('id'),
    ),
  ]);
  type Ev = { at: string; vendor: string; capacity: number };
  const events: Ev[] = [];
  for (const l of logs) {
    const at = l.entry_date ?? l.submitted_at;
    if (at && l.vendor_code) events.push({ at, vendor: l.vendor_code.toLowerCase(), capacity: Number(l.capacity_per_month) || 0 });
  }
  for (const t of trail) {
    const v = t.after?.vendor_code;
    if (v) events.push({ at: t.changed_at, vendor: v.toLowerCase(), capacity: Number(t.after?.capacity_per_month) || 0 });
  }
  const cur = monthStart();
  const first = events.length ? events.map((e) => istMonth(e.at)).sort()[0] : cur;
  const months: string[] = [];
  for (let m = first; m <= addMonths(cur, 1); m = addMonths(m, 1)) months.push(m);

  const cards: MonthBoardCard[] = months.map((m) => {
    const mine = events.filter((e) => istMonth(e.at) === m).sort((a, b) => a.at.localeCompare(b.at));
    const latest = new Map<string, number>();
    for (const e of mine) latest.set(e.vendor, e.capacity);
    const updated = latest.size;
    const capacity = [...latest.values()].reduce((s, v) => s + v, 0);
    const lastAt = mine.length ? mine[mine.length - 1].at : null;
    const status = m > cur ? 'draft' : m === cur ? (updated === 0 ? 'draft' : updated >= activeVendors ? 'live' : 'pending') : 'closed';
    const facts: string[] = [];
    if (m > cur) facts.push(`Opens 1 ${short(m).split(' ')[0]}`);
    else if (lastAt) facts.push(`Last update ${day(lastAt)}`);
    if (m === cur && updated < activeVendors) facts.push(`${activeVendors - updated} vendor${activeVendors - updated === 1 ? '' : 's'} still to update`);
    if (m < '2026-10-01') facts.push('Before Oct 2026 only each vendor’s latest update is known');
    return {
      id: `vc-${m}`,
      month: m,
      label: short(m),
      status,
      big: { value: updated ? num(capacity) : '—', label: 'Pcs / month declared' },
      progress: m > cur ? undefined : { left: `${updated} / ${activeVendors} vendors updated`, right: `${pct(updated, activeVendors)}%`, pct: pct(updated, activeVendors) },
      facts,
      warn: m <= cur && updated === 0 ? { text: 'No vendor updated capacity in this month.', tone: 'pending' as const } : undefined,
      actions: [{ label: m === cur ? 'Update vendors' : 'Open', href: '/vendor-capacity?view=vendors', primary: true }],
      list: [`${updated} / ${activeVendors}`, updated ? num(capacity) : '—'],
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
      { value: now?.list[0] ?? `0 / ${activeVendors}`, label: 'Updated this month' },
      { value: now?.list[1] ?? '—', label: 'Pcs / month declared' },
    ],
    unit: 'months',
    listColumns: [{ label: 'Vendors updated', num: true }, { label: 'Pcs / month', num: true }],
  };
}
