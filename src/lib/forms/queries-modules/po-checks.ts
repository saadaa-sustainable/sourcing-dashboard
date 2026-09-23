import 'server-only';
import { client, pageAll } from './_shared';
import { loadAnalyticsRules } from './analytics';
import { loadApprovedStandardCosts, loadStandardCmByCode } from './standard-cost';
import { loadInProcessByVendor, loadLatestVendorCapacity } from './vendor';
import { loadPlanMembership } from './buying-plan-analysis';
import { capacityRulesFrom, normaliseVendorType, vendorCapacityModel } from '@/lib/business-logic';
import type { PlanMembership } from '../analysis-types';

/**
 * Spec 7.1 — the three validations shown as a pop-up before a PO is submitted.
 *
 * Nothing here blocks: the point is that the person submitting sees the comparison and
 * says why in a remark ("standard cost was ₹200, you are issuing at ₹205 — why more?").
 * Every figure names where it came from, and a missing comparison says so rather than
 * reading as zero.
 */

export type PoRef = { poRef: string; vendor: string | null; date: string | null };

export type PoSubmissionChecks = {
  poId: number;
  poRef: string | null;
  productCode: string | null;
  poType: 'job_work' | 'efob' | 'fob';
  poTypeLabel: string;
  vendorCode: string | null;
  vendorName: string | null;
  qty: number;
  cost: {
    /** The rate written on this PO, per piece. */
    written: number | null;
    /** The approved Standard Cost for this PO type. */
    standard: number | null;
    /** The most recent PO for this product and type, and its rate. */
    lastPo: (PoRef & { rate: number }) | null;
    /** The cheapest rate ever paid for this product and type. */
    cheapest: (PoRef & { rate: number }) | null;
    /** CM (cut-make) on this PO against the standard CM — the part the vendor controls. */
    cm: { po: number | null; standard: number | null };
    /** Finished-fabric cost on this PO against the standard — a commodity, shown apart. */
    fabric: { po: number | null; standard: number | null };
  };
  tna: {
    /** Days from today to the requested first delivery. */
    requestedDays: number | null;
    firstDelivery: string | null;
    /** The lead time the Rules Master maps to this PO type. */
    ruleDays: number;
    /** This vendor's most recent completed PO: how many days it actually took. */
    vendorLastPo: (PoRef & { product: string | null; days: number }) | null;
    /** This vendor's average actual days over completed POs this financial year. */
    vendorFyAvg: { days: number; pos: number; fyStart: string } | null;
    /** The most recent completed PO for the same product, whoever made it. */
    lastPoSameProduct: (PoRef & { days: number | null }) | null;
    /** The critical path as entered, for the pop-up's timeline. */
    stages: { label: string; date: string | null }[];
  };
  quantity: {
    poQty: number;
    /** Replenishment's view of the product: stock, on order, daily demand, and the pieces
     *  needed to cover this PO type's lead time (ROP-30 / 60 / 90). Null when the product is
     *  not on the replenishment feed. */
    replenishment: {
      currentStock: number;
      inProgress: number;
      dailyDemand: number;
      horizonDays: 30 | 60 | 90;
      neededQty: number;
    } | null;
    /** The vendor's capacity model for this PO's type, with this PO added to the load. */
    capacity: {
      entered: boolean;
      poCapacity: number;
      inProcess: number;
      available: number | null;
      utilWithThisPo: number | null;
      leadDays: number;
      updatedAt: string | null;
    } | null;
  };
  plan: PlanMembership;
};

const TYPE_LABEL = { job_work: 'Job Work', efob: 'E-FOB', fob: 'FOB' } as const;

/** PO type from a reference like FY26-27/FOB/SDFLK/KVN-03; null when it carries none. */
function typeFromRef(ref: string | null | undefined): 'job_work' | 'efob' | 'fob' | null {
  const m = /\/(EFOB|E-FOB|FOB|JOB)\//i.exec(ref ?? '');
  if (!m) return null;
  const t = m[1].toUpperCase();
  return t === 'JOB' ? 'job_work' : t === 'FOB' ? 'fob' : 'efob';
}

const dayDiff = (from: string | null, to: string | null) =>
  from && to ? Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) : null;

/** 1 April of the current financial year (IST). */
function fyStartIso(now = new Date()): string {
  const ist = new Date(now.getTime() + 5.5 * 3600_000);
  const y = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  return `${y}-04-01`;
}

export async function loadPoSubmissionChecks(poId: number): Promise<PoSubmissionChecks | null> {
  const supabase = await client();
  type PoRow = {
    id: number; request_id: string | null; po_ref_num: string | null; po_type: string | null; product_code: string | null;
    vendor_code: string | null; vendor_name: string | null; po_qty: number | null; rate: number | null;
    cm_cost: number | null; finished_fabric_cost: number | null;
    cs_pp_sample_due: string | null; cs_gpt_due: string | null; cs_cutting_start: string | null;
    cs_inline_qc_due: string | null; critical_path_first_delivery: string | null; po_closing_date: string | null;
    buying_plan_no: string | null;
  };
  const { data: poRaw } = await supabase
    .from('sd_po_approval')
    .select(
      'id, request_id, po_ref_num, po_type, product_code, vendor_code, vendor_name, po_qty, rate, cm_cost, finished_fabric_cost, ' +
        'cs_pp_sample_due, cs_gpt_due, cs_cutting_start, cs_inline_qc_due, critical_path_first_delivery, po_closing_date, buying_plan_no',
    )
    .eq('id', poId)
    .maybeSingle();
  const po = poRaw as unknown as PoRow | null;
  if (!po) return null;

  const productCode = (po.product_code as string | null)?.trim() || null;
  const vendorCode = (po.vendor_code as string | null)?.trim() || null;
  const poType = (typeFromRef(po.po_ref_num as string | null) ??
    (normaliseVendorType(po.po_type as string | null) as 'job_work' | 'efob' | 'fob'));
  const qty = Number(po.po_qty) || 0;

  const [rules, stdCosts, stdCm, capacityByVendor, inProcessByVendor, membership] = await Promise.all([
    loadAnalyticsRules(),
    loadApprovedStandardCosts(),
    loadStandardCmByCode(),
    loadLatestVendorCapacity(),
    loadInProcessByVendor(),
    loadPlanMembership(productCode, (po.buying_plan_no as string | null) ?? null),
  ]);

  /* ---- cost history: every PO ever placed for this product (completed + open), by type */
  type Line = { po_ref_num: string | null; vendor_name: string | null; po_date: string | null; po_updated_date: string | null; item_price: number | null; product_code: string | null };
  const history: Line[] = [];
  if (productCode) {
    const sel = 'po_ref_num, vendor_name, po_date, po_updated_date, item_price, product_code';
    const [done, open] = await Promise.all([
      pageAll<Line>(() => supabase.from('sd_po_completed').select(sel).eq('product_code', productCode).order('po_detail_id')),
      pageAll<Line>(() => supabase.from('sd_po_dashboard').select(sel).eq('product_code', productCode).order('po_detail_id')),
    ]);
    history.push(...done, ...open);
  }
  // One entry per PO reference: its rate and date.
  const byRef = new Map<string, { rate: number; vendor: string | null; date: string | null }>();
  for (const l of history) {
    const ref = (l.po_ref_num ?? '').trim();
    const rate = Number(l.item_price) || 0;
    if (!ref || rate <= 0) continue;
    if (typeFromRef(ref) !== poType) continue; // a Job Work rate is not comparable with a FOB rate
    if (ref === (po.po_ref_num ?? '').trim()) continue; // not this PO itself
    const cur = byRef.get(ref);
    if (!cur || (l.po_date ?? '') > (cur.date ?? '')) byRef.set(ref, { rate, vendor: l.vendor_name, date: l.po_date });
  }
  const refs = [...byRef.entries()].map(([poRef, v]) => ({ poRef, ...v }));
  const lastPo = refs.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))[0] ?? null;
  const cheapest = [...refs].sort((a, b) => a.rate - b.rate)[0] ?? null;

  /* ---- standard fabric for the product (same source the approval card uses) */
  let stdFabric: number | null = null;
  if (productCode) {
    const { data: sc } = await supabase.from('sd_standard_cost').select('fabric_code').eq('product_code', productCode).maybeSingle();
    const fabricCode = (sc as { fabric_code?: string | null } | null)?.fabric_code;
    if (fabricCode) {
      const { data: fc } = await supabase.from('sd_fabric_cost_base').select('finished_fabric_cost').eq('fabric_code', fabricCode).maybeSingle();
      const v = (fc as { finished_fabric_cost?: number | null } | null)?.finished_fabric_cost;
      stdFabric = v == null ? null : Number(v);
    }
  }

  /* ---- TNA: what this vendor actually takes, and what the last PO of this product took */
  type Done = { po_ref_num: string | null; product_code: string | null; vendor_code: string | null; vendor_name: string | null; po_date: string | null; po_updated_date: string | null };
  const fyStart = fyStartIso();
  const vendorDone: Done[] = vendorCode
    ? await pageAll<Done>(() =>
        supabase
          .from('sd_po_completed')
          .select('po_ref_num, product_code, vendor_code, vendor_name, po_date, po_updated_date')
          .ilike('vendor_code', vendorCode)
          .not('po_date', 'is', null)
          .not('po_updated_date', 'is', null)
          .order('po_detail_id'),
      )
    : [];
  const vendorPos = new Map<string, { product: string | null; date: string; done: string; vendor: string | null }>();
  for (const l of vendorDone) {
    const ref = (l.po_ref_num ?? '').trim();
    if (!ref) continue;
    const cur = vendorPos.get(ref);
    // The PO's completion is its last update; its start is its earliest date.
    if (!cur) vendorPos.set(ref, { product: l.product_code, date: l.po_date!, done: l.po_updated_date!, vendor: l.vendor_name });
    else {
      if (l.po_date! < cur.date) cur.date = l.po_date!;
      if (l.po_updated_date! > cur.done) cur.done = l.po_updated_date!;
    }
  }
  const vendorList = [...vendorPos.entries()].map(([poRef, v]) => ({ poRef, ...v, days: dayDiff(v.date, v.done) ?? 0 }));
  const vendorLast = vendorList.sort((a, b) => b.done.localeCompare(a.done))[0] ?? null;
  const fyList = vendorList.filter((v) => v.date >= fyStart);
  const vendorFyAvg = fyList.length
    ? { days: Math.round(fyList.reduce((s, v) => s + v.days, 0) / fyList.length), pos: fyList.length, fyStart }
    : null;

  // Last completed PO of the same product, any vendor.
  let lastSameProduct: (PoRef & { days: number | null }) | null = null;
  if (productCode) {
    const done = history.filter((l) => l.po_updated_date && (l.po_ref_num ?? '').trim());
    const byPo = new Map<string, { vendor: string | null; date: string | null; done: string }>();
    for (const l of done) {
      const ref = (l.po_ref_num ?? '').trim();
      const cur = byPo.get(ref);
      if (!cur) byPo.set(ref, { vendor: l.vendor_name, date: l.po_date, done: l.po_updated_date! });
      else if (l.po_updated_date! > cur.done) cur.done = l.po_updated_date!;
    }
    const latest = [...byPo.entries()].sort((a, b) => b[1].done.localeCompare(a[1].done))[0];
    if (latest) lastSameProduct = { poRef: latest[0], vendor: latest[1].vendor, date: latest[1].date, days: dayDiff(latest[1].date, latest[1].done) };
  }

  const todayIst = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const firstDelivery = (po.critical_path_first_delivery as string | null) ?? null;
  const capRules = capacityRulesFrom(rules);
  const ruleDays = capRules.leadDays[poType];

  /* ---- quantity: replenishment need for the product, and the vendor's capacity */
  let replenishment: PoSubmissionChecks['quantity']['replenishment'] = null;
  if (productCode) {
    const { data: r } = await supabase
      .from('sd_replenishment_by_product')
      .select('current_stock, in_progress, daily_demand, rop_30, rop_60, rop_90')
      .eq('product_code', productCode)
      .maybeSingle();
    if (r) {
      const horizon: 30 | 60 | 90 = poType === 'job_work' ? 30 : poType === 'efob' ? 60 : 90;
      const need = horizon === 30 ? r.rop_30 : horizon === 60 ? r.rop_60 : r.rop_90;
      replenishment = {
        currentStock: Number(r.current_stock) || 0,
        inProgress: Number(r.in_progress) || 0,
        dailyDemand: Number(r.daily_demand) || 0,
        horizonDays: horizon,
        neededQty: Math.max(0, Number(need) || 0),
      };
    }
  }
  let capacity: PoSubmissionChecks['quantity']['capacity'] = null;
  if (vendorCode) {
    const cap = capacityByVendor.get(vendorCode.toLowerCase());
    const inProcess = inProcessByVendor.get(vendorCode.toLowerCase()) ?? 0;
    const m = vendorCapacityModel(
      { machines: cap?.machines ?? 0, karigar: cap?.karigar ?? 0, vendorType: poType, inProcessQty: inProcess },
      capRules,
    );
    capacity = {
      entered: m.entered,
      poCapacity: m.poCapacity,
      inProcess,
      available: m.entered ? m.poCapacity - inProcess : null,
      utilWithThisPo: m.entered && m.poCapacity > 0 ? Math.round(((inProcess + qty) / m.poCapacity) * 1000) / 10 : null,
      leadDays: m.leadDays,
      updatedAt: cap?.weekOf ?? null,
    };
  }

  const std = productCode ? stdCosts[productCode] : undefined;
  return {
    poId: po.id as number,
    poRef: (po.request_id as string | null) ?? (po.po_ref_num as string | null) ?? null,
    productCode,
    poType,
    poTypeLabel: TYPE_LABEL[poType],
    vendorCode,
    vendorName: (po.vendor_name as string | null) ?? null,
    qty,
    cost: {
      written: po.rate == null ? null : Number(po.rate),
      standard: std ? (poType === 'job_work' ? std.job : poType === 'efob' ? std.efob : std.fob) || null : null,
      lastPo: lastPo ? { poRef: lastPo.poRef, vendor: lastPo.vendor, date: lastPo.date, rate: lastPo.rate } : null,
      cheapest: cheapest ? { poRef: cheapest.poRef, vendor: cheapest.vendor, date: cheapest.date, rate: cheapest.rate } : null,
      cm: { po: po.cm_cost == null ? null : Number(po.cm_cost), standard: productCode ? stdCm[productCode] ?? null : null },
      fabric: { po: po.finished_fabric_cost == null ? null : Number(po.finished_fabric_cost), standard: stdFabric },
    },
    tna: {
      requestedDays: dayDiff(todayIst, firstDelivery),
      firstDelivery,
      ruleDays,
      vendorLastPo: vendorLast ? { poRef: vendorLast.poRef, vendor: vendorLast.vendor, date: vendorLast.date, product: vendorLast.product, days: vendorLast.days } : null,
      vendorFyAvg,
      lastPoSameProduct: lastSameProduct,
      stages: [
        { label: 'PP sample', date: (po.cs_pp_sample_due as string | null) ?? null },
        { label: 'GPT', date: (po.cs_gpt_due as string | null) ?? null },
        { label: 'Cutting', date: (po.cs_cutting_start as string | null) ?? null },
        { label: 'Inline QC', date: (po.cs_inline_qc_due as string | null) ?? null },
        { label: 'First delivery', date: firstDelivery },
        { label: 'PO closing', date: (po.po_closing_date as string | null) ?? null },
      ],
    },
    quantity: { poQty: qty, replenishment, capacity },
    plan: membership,
  };
}
