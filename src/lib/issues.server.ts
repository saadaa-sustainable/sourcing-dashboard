import 'server-only';
import { createClient, hasSupabaseEnv } from '@/lib/supabase/server';
import { pageAll } from '@/lib/forms/queries-modules/_shared';
import { loadDashboardData } from '@/lib/data';
import { buildTrackerRows } from '@/lib/business-logic';
import { loadAnalyticsRules, loadSyncStatus } from '@/lib/forms/queries';
import {
  diffAutoIssues,
  routeFor,
  type AutoDetection,
  type IssueRoute,
  type IssueRow,
} from '@/lib/issues';

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

/** Every issue, newest first, with its message count. Capped at 500 — the tracker is a
 *  working list, not an archive; older resolved ones can be found by search later. */
export async function loadIssues(): Promise<IssueRow[]> {
  const supabase = await createClient();
  const [{ data: rows }, msgs] = await Promise.all([
    supabase.from('sd_issue').select('*').order('raised_at', { ascending: false }).limit(500),
    pageAll<{ issue_id: number }>(() =>
      supabase.from('sd_issue_message').select('issue_id').order('id'),
    ),
  ]);
  const counts = new Map<number, number>();
  for (const m of msgs) counts.set(m.issue_id, (counts.get(m.issue_id) ?? 0) + 1);
  return ((rows ?? []) as Omit<IssueRow, 'messageCount'>[]).map((r) => ({
    ...r,
    messageCount: counts.get(r.id) ?? 0,
  }));
}

export async function loadIssueRoutes(): Promise<IssueRoute[]> {
  const supabase = await createClient();
  const { data } = await supabase.from('sd_issue_route').select('*').order('category');
  return (data ?? []) as IssueRoute[];
}

/** Open + in-progress issues — the big number on the dashboard. Never throws. */
export async function countOpenIssues(): Promise<number | null> {
  try {
    if (!hasSupabaseEnv()) return null;
    const supabase = await createClient();
    const { count } = await supabase
      .from('sd_issue')
      .select('id', { count: 'exact', head: true })
      .in('status', ['open', 'in_progress']);
    return count ?? 0;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Auto-raised issues                                                  */
/* ------------------------------------------------------------------ */

/**
 * What the dashboard's own checks find wrong right now. Each detection carries a key so
 * it is raised once and closed by the next sync when the condition is gone.
 *
 *   tna-missing:<PO>   an open PO with no TNA timeline — the High Risk rule cannot see it
 *   edd-missing:<PO>   an open PO with pending pieces and no expected delivery date
 *   disc-on-po:<code>  a product marked Discontinued that is still on an open PO
 *   feed-stale:<src>   a synced feed older than the Rules Master stale threshold
 */
export async function detectAutoIssues(): Promise<AutoDetection[]> {
  const out: AutoDetection[] = [];
  const [dash, rules, sync] = await Promise.all([loadDashboardData(), loadAnalyticsRules(), loadSyncStatus().catch(() => [])]);
  const rows = buildTrackerRows(dash.pendingPos, dash.vendorTypes, dash.vendorMasters, dash.tnaRecords);

  // One PO can be several rows (one per product); raise once per PO.
  const byPo = new Map<string, { vendor: string; codes: Set<string>; qty: number; tnaMissing: boolean; anyEdd: boolean }>();
  for (const r of rows) {
    if (!(r.pendingQty > 0)) continue;
    const cur = byPo.get(r.poRef) ?? { vendor: r.vendorName, codes: new Set<string>(), qty: 0, tnaMissing: true, anyEdd: false };
    cur.codes.add(r.productCode);
    cur.qty += r.pendingQty;
    cur.tnaMissing = cur.tnaMissing && r.tnaMissing;
    cur.anyEdd = cur.anyEdd || !!r.edd;
    byPo.set(r.poRef, cur);
  }
  for (const [po, p] of byPo) {
    const codes = [...p.codes].filter(Boolean).join(', ');
    if (p.tnaMissing) {
      out.push({
        key: `tna-missing:${po}`,
        category: 'tna',
        title: `No TNA timeline on PO ${po}`,
        detail: `${p.vendor || 'Vendor unknown'} · ${codes || 'product unknown'} · ${p.qty.toLocaleString('en-IN')} pcs pending. Until the timeline is entered the High Risk rule cannot see this PO — it can be late on every stage and never flag.`,
        related_ref: po,
        page_path: '/po-details',
        severity: 'medium',
      });
    }
    if (!p.anyEdd) {
      out.push({
        key: `edd-missing:${po}`,
        category: 'po',
        title: `No expected delivery date on PO ${po}`,
        detail: `${p.vendor || 'Vendor unknown'} · ${codes || 'product unknown'} · ${p.qty.toLocaleString('en-IN')} pcs pending with no delivery date on any line. It cannot be counted overdue however long it stays open, and the arrival schedule cannot place it.`,
        related_ref: po,
        page_path: '/po-approval',
        severity: 'medium',
      });
    }
  }

  // Discontinued products still on order.
  try {
    const supabase = await createClient();
    const { data: states } = await supabase
      .from('sd_ee_product_code_status')
      .select('product_code, product_status');
    const disc = new Set(
      ((states ?? []) as { product_code: string | null; product_status: string | null }[])
        .filter((s) => (s.product_status ?? '').trim().toUpperCase() === 'DISCONTINUED')
        .map((s) => (s.product_code ?? '').trim().toUpperCase())
        .filter(Boolean),
    );
    const onOrder = new Map<string, { pos: Set<string>; qty: number }>();
    for (const r of rows) {
      const code = (r.productCode ?? '').trim().toUpperCase();
      if (!(r.pendingQty > 0) || !disc.has(code)) continue;
      const cur = onOrder.get(code) ?? { pos: new Set<string>(), qty: 0 };
      cur.pos.add(r.poRef);
      cur.qty += r.pendingQty;
      onOrder.set(code, cur);
    }
    for (const [code, x] of onOrder) {
      out.push({
        key: `disc-on-po:${code}`,
        category: 'product',
        title: `Discontinued product ${code} is still on order`,
        detail: `${x.qty.toLocaleString('en-IN')} pcs pending on ${x.pos.size} open PO${x.pos.size === 1 ? '' : 's'} (${[...x.pos].join(', ')}). Either the product state is wrong or the PO should be cancelled.`,
        related_ref: code,
        page_path: '/product-master',
        severity: 'high',
      });
    }
  } catch {
    /* the other detections still stand */
  }

  // Stale feeds.
  const staleHours = Number(rules.sync_stale_hours ?? 30) || 30;
  const now = Date.now();
  for (const s of sync) {
    if (!s.last_refreshed) continue;
    const hours = (now - Date.parse(s.last_refreshed)) / 3_600_000;
    if (hours <= staleHours) continue;
    out.push({
      key: `feed-stale:${s.source}|${s.pipeline}`,
      category: 'data',
      title: `${s.source} feed has not refreshed for ${Math.floor(hours)} hours`,
      detail: `${s.pipeline}${s.fetched_from ? ` · ${s.fetched_from}` : ''}. Every card built on it is showing old numbers. Threshold ${staleHours} h (Rules Master).`,
      related_ref: s.source,
      page_path: '/sync-status',
      severity: 'high',
    });
  }

  return out;
}

// The sync runs on dashboard and tracker loads; once per ten minutes per warm instance is
// plenty — the checks are not cheap and the conditions change on a nightly feed.
let lastSyncAt = 0;

/**
 * Raise the auto issues that are new and close the ones whose condition is gone. Routes
 * each new one by category. Best-effort: never throws, never blocks a page.
 */
export async function syncAutoIssues(force = false): Promise<{ raised: number; closed: number } | null> {
  if (!hasSupabaseEnv()) return null;
  if (!force && Date.now() - lastSyncAt < 10 * 60_000) return null;
  lastSyncAt = Date.now();
  try {
    const supabase = await createClient();
    const [detected, routes, live] = await Promise.all([
      detectAutoIssues(),
      loadIssueRoutes(),
      pageAll<{ id: number; auto_key: string }>(() =>
        supabase
          .from('sd_issue')
          .select('id, auto_key')
          .eq('source', 'auto')
          .in('status', ['open', 'in_progress'])
          .order('id'),
      ),
    ]);
    const { toRaise, toClose } = diffAutoIssues(detected, live.map((l) => l.auto_key));
    const now = new Date().toISOString();

    if (toRaise.length) {
      await supabase.from('sd_issue').insert(
        toRaise.map((d) => {
          const assignee = routeFor(d.category, routes);
          return {
            category: d.category,
            title: d.title,
            detail: d.detail,
            related_ref: d.related_ref,
            page_path: d.page_path,
            source: 'auto',
            auto_key: d.key,
            severity: d.severity,
            status: 'open',
            raised_by: 'system',
            raised_at: now,
            assignee,
            assigned_via: assignee ? 'route' : null,
            assigned_at: assignee ? now : null,
            updated_at: now,
          };
        }),
      );
    }
    if (toClose.length) {
      const ids = live.filter((l) => toClose.includes(l.auto_key)).map((l) => l.id);
      await supabase
        .from('sd_issue')
        .update({
          status: 'resolved',
          resolved_at: now,
          resolved_by: 'system',
          resolution: 'No longer detected by the dashboard check.',
          updated_at: now,
        })
        .in('id', ids);
    }
    return { raised: toRaise.length, closed: toClose.length };
  } catch {
    return null;
  }
}
