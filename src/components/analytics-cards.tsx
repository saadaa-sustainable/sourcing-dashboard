"use client";

/**
 * Cross-tab decision cards for the main Dashboard tab. The cards are grouped
 * by leadership decision instead of presented as ten equally weighted KPIs:
 * protect the business, allocate smarter, and stay on plan.
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import {
  ArrowRight,
  Award,
  Ban,
  CheckCheck,
  CircleAlert,
  Database,
  Factory,
  IndianRupee,
  PackageSearch,
  PackageX,
  RefreshCw,
  Repeat,
  Scale,
  Target,
  TrendingUp,
  Truck,
  ClipboardCheck,
  PackageCheck,
  Boxes,
  ShoppingCart,
  FileCheck,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  buildTrackerRows,
  buildVendorRollups,
  capacityRulesFrom,
  istToday,
} from "@/lib/business-logic";
import type { DashboardData } from "@/lib/types";
import type { AnalyticsExtras, StockoutRiskVariant } from "@/lib/forms/types";
import { downloadCsv } from "@/lib/download";
import { InfoDot } from "./info-dot";
import type { TabId } from "./side-nav";

const money = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});
const fmt = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const key = (value: string | null | undefined) =>
  (value ?? "").trim().toLowerCase();
const clampPct = (value: number) => Math.max(0, Math.min(100, value));
const monthLabel = (month: string) => {
  const [, mm] = month.split("-");
  return (
    [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ][Number(mm) - 1] ?? month
  );
};


type Tone = "red" | "amber" | "green" | "neutral";

const decisionTabs = [
  {
    id: "money",
    number: "01",
    label: "Money committed",
    description:
      "What the open book is worth and where we are paying more than agreed.",
  },
  {
    id: "stock",
    number: "02",
    label: "Will we run out",
    description:
      "Replenishment pressure and what is actually landing, so gaps are caught while they can still be fixed.",
  },
  {
    id: "plan",
    number: "03",
    label: "Buying to plan",
    description:
      "Commitment against the buying plan, approval progress, TNA compliance and PO closure.",
  },
  {
    id: "vendors",
    number: "04",
    label: "Who we buy from",
    description:
      "Vendor capacity against demand, how concentrated the book is, and who delivers.",
  },
  {
    id: "datahealth",
    number: "05",
    label: "Trust the numbers",
    description:
      "The master data and feeds behind every figure above, plus products still on order after being discontinued.",
  },
] as const;

type DecisionTab = (typeof decisionTabs)[number]["id"];

function AnaCard({
  title,
  icon: Icon,
  info,
  tone = "neutral",
  span = 4,
  status,
  cta,
  rowSpan = false,
  onClick,
  href,
  children,
}: {
  title: string;
  icon: LucideIcon;
  info: string;
  tone?: Tone;
  span?: number;
  status: string;
  cta: string;
  rowSpan?: boolean;
  onClick?: () => void;
  href?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const go = onClick ?? (href ? () => router.push(href) : undefined);

  return (
    <section
      className={`ana-card ana-span${span} ana-${tone}${rowSpan ? " ana-rowspan2" : ""}${go ? " clickable" : ""}`}
      role={go ? "button" : undefined}
      tabIndex={go ? 0 : undefined}
      onClick={go}
      onKeyDown={
        go
          ? (event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                go();
              }
            }
          : undefined
      }
    >
      <div className="ana-head">
        <span className="ana-head-left">
          <span className="ana-icon">
            <Icon size={13} strokeWidth={2} />
          </span>
          <span className="ana-label">{title}</span>
        </span>
        <span className="ana-head-right">
          <span className={`ana-state ana-state-${tone}`}>{status}</span>
          <InfoDot text={info} label={`About ${title}`} />
        </span>
      </div>
      <div className="ana-body">{children}</div>
      {go && (
        <div className="ana-footer" aria-hidden="true">
          <span>{cta}</span>
          <ArrowRight size={14} strokeWidth={2.2} />
        </div>
      )}
    </section>
  );
}

const NoData = ({ text }: { text: string }) => (
  <div className="ana-nodata">
    <span>Data pending</span>
    <p>{text}</p>
  </div>
);

const ZeroState = ({
  title,
  text,
  compact = false,
}: {
  title: string;
  text: string;
  compact?: boolean;
}) => (
  <div className={`ana-zero${compact ? " ana-zero-compact" : ""}`}>
    <CheckCheck size={compact ? 20 : 22} />
    <strong>{title}</strong>
    <span>{text}</span>
  </div>
);

export function AnalyticsCards({
  data,
  rules,
  extras,
  onTab,
  only,
  isAdmin = false,
}: {
  data: DashboardData;
  rules: Record<string, number>;
  extras?: AnalyticsExtras | null;
  onTab: (id: TabId) => void;
  /**
   * Render a single group and hide the internal strip. The Main Dashboard owns one tab strip
   * for all of its groups now, so these are driven from there rather than switching
   * themselves.
   */
  only?: DecisionTab;
  /** /replenishment is admin-only; non-admins get Urgent Replenishment instead. */
  isAdmin?: boolean;
}) {
  const today = istToday();
  const [ownTab, setOwnTab] = useState<DecisionTab>("money");
  const decisionTab = only ?? ownTab;
  const setDecisionTab = setOwnTab;
  const activeDecisionTab =
    decisionTabs.find((tab) => tab.id === decisionTab) ?? decisionTabs[0];
  // Item 7 — Vendor Concentration is measured within a fabric pool. Woven and Knit
  // are managed as separate vendor pools, so a vendor who dominates Knit shouldn't
  // distort Woven's top-3 share. Default All (blended); Woven/Knit slice by the
  // tracker's vendorBucket (resolved from Product Master fabric_type).
  const [concWeave, setConcWeave] = useState<"All" | "Woven" | "Knit">("All");
  const tracker = useMemo(
    () =>
      buildTrackerRows(
        data.pendingPos,
        data.vendorTypes,
        data.vendorMasters,
        data.tnaRecords,
        today,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data],
  );

  const rollups = useMemo(() => {
    const capacityByVendor = new Map(
      (data.vendorCapacity ?? []).map((capacity) => [
        key(capacity.vendor_code),
        {
          machines: Number(capacity.machines_allocated) || 0,
          karigar: Number(capacity.active_karigar) || 0,
        },
      ]),
    );
    return buildVendorRollups(
      data.pendingPos,
      data.vendorTypes,
      data.vendorMasters,
      data.tnaRecords,
      today,
      capacityByVendor,
      capacityRulesFrom(rules),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, rules]);

  const tnaDataPresent = data.tnaRecords.length > 0;
  /*
    There is no percentile here on purpose. The old "Capital at Risk" card counted only POs
    that were BOTH TNA high risk AND in the top quarter by pending value, which quietly hid
    every other high-risk PO. High Risk is simply what is on the TNA critical-path list, with
    its count and its value, and it lives on the objectives row. Overdue stays separate.
  */
  const highRiskPos = tracker.filter((row) => row.highRisk);

  // Item 7 — compute concentration WITHIN the selected fabric pool, not blended.
  const concTracker =
    concWeave === "All"
      ? tracker
      : tracker.filter((row) => row.vendorBucket === concWeave);
  const byVendor = new Map<string, { name: string; value: number }>();
  concTracker.forEach((row) => {
    const vendorKey = key(row.vendorCode || row.vendorName);
    const current = byVendor.get(vendorKey) ?? {
      name: row.vendorName,
      value: 0,
    };
    current.value += row.pendingValue;
    byVendor.set(vendorKey, current);
  });
  const vendorValues = [...byVendor.values()].sort((a, b) => b.value - a.value);
  const totalOpenValue = vendorValues.reduce(
    (sum, vendor) => sum + vendor.value,
    0,
  );
  const top3 = vendorValues.slice(0, 3);
  const top3Value = top3.reduce((sum, vendor) => sum + vendor.value, 0);
  const concentrationPct =
    totalOpenValue > 0 ? Math.round((top3Value / totalOpenValue) * 100) : 0;
  const concentrationAlert = rules.vendor_concentration_alert ?? 40;

  // Only vendors with a capacity entry can be judged; "not entered" is not zero capacity.
  const withCapacity = rollups.filter((row) => row.capacityEntered && row.poCapacity > 0);
  const over = withCapacity
    .filter((row) => row.utilizationPct > (rules.utilization_over_pct ?? 100))
    .sort((a, b) => b.utilizationPct - a.utilizationPct);
  const under = withCapacity
    .filter((row) => row.utilizationPct < (rules.utilization_under_pct ?? 70))
    .sort(
      (a, b) =>
        b.capacityPerMonth - b.openQty - (a.capacityPerMonth - a.openQty),
    );

  // Delivery reliability is now computed server-side over a Rules-Master window
  // (default 2 quarters), combining completed POs (final delivered status) and
  // open POs (in-flight), deduped by PO number — see sd_vendor_reliability().
  const reliability = extras?.reliability ?? null;
  const windowDays = reliability?.windowDays ?? rules.reliability_window_days ?? 180;
  const struggling = (reliability?.vendors ?? [])
    .filter((v) => v.total >= 2 && v.delayed > 0)
    .sort((a, b) => b.pct - a.pct || b.delayed - a.delayed)
    .slice(0, 4);

  const trend = extras?.tnaTrend ?? null;
  const trendData = (trend ?? []).map((snapshot) => ({
    date: snapshot.snapshot_date.slice(5),
    onTimePct:
      snapshot.open_total > 0
        ? Math.round((snapshot.on_time / snapshot.open_total) * 100)
        : 0,
    highRisk: snapshot.high_risk,
    overdue: snapshot.overdue,
  }));
  const realization = extras?.planRealization ?? null;
  const curMonth = realization?.[0] ?? null;
  const closure = extras?.closure ?? null;
  const closurePct =
    closure && closure.closedTotal > 0
      ? Math.round((closure.closedWithinSla / closure.closedTotal) * 100)
      : null;
  const cost = extras?.costVariance ?? null;
  const disc = extras?.discontinued ?? null;
  const gaps = extras?.stockoutGaps ?? null;
  // Stockout list segmented by ABC/D (priority shown, nothing hidden).
  const issued = extras?.issuedLastWeek ?? null;
  const pending = extras?.pendingApproval ?? null;
  const inward = extras?.inwardLastWeek ?? null;
  const inwardPct =
    inward && inward.planned > 0 ? Math.round((inward.actual / inward.planned) * 100) : null;
  // 8.1 — live, paired coverage for the current month (Buying Plan vs Inward Plan).
  const inwardMonth = extras?.inwardMonth ?? null;
  const inwardMonthPct =
    inwardMonth && inwardMonth.planned > 0
      ? Math.round((inwardMonth.actual / inwardMonth.planned) * 100)
      : null;
  const repl = extras?.replenishment ?? null;
  const vrec = extras?.vendorRec ?? null;
  const pipe = extras?.inwardPipeline ?? null;
  const stateMix = extras?.productStateMix ?? null;
  const stateTotal = (stateMix ?? []).reduce((s, m) => s + m.count, 0);
  const sync = extras?.syncHealth ?? null;

  const planTotals = curMonth?.buckets.reduce(
    (acc, bucket) => ({
      planned: acc.planned + bucket.planned,
      actual: acc.actual + bucket.actual,
    }),
    { planned: 0, actual: 0 },
  ) ?? { planned: 0, actual: 0 };
  const planPct =
    planTotals.planned > 0
      ? Math.round((planTotals.actual / planTotals.planned) * 100)
      : null;
  const planVariance = planTotals.actual - planTotals.planned;
  const latestTrend = trendData.at(-1) ?? null;
  const firstTrend = trendData[0] ?? null;
  const trendDelta =
    latestTrend && firstTrend
      ? latestTrend.onTimePct - firstTrend.onTimePct
      : null;
  const discontinuedCount =
    (disc?.openPoCount ?? 0) + (disc?.planLineCount ?? 0);

  return (
    <section className="ana-board" aria-labelledby="decision-briefing-title">
      {!only && (
      <header className="ana-brief">
        <div className="ana-brief-copy">
          <span className="ana-eyebrow">Cross-module insights</span>
          <h2 id="decision-briefing-title">Dashboard overview</h2>
          <p>{activeDecisionTab.description}</p>
        </div>
        <div className="ana-signal-strip" aria-label="Current decision signals">
          <span
            className={`ana-signal ${!tnaDataPresent ? "is-neutral" : highRiskPos.length ? "is-red" : "is-green"}`}
          >
            <CircleAlert size={13} />
            {!tnaDataPresent
              ? "TNA data pending"
              : highRiskPos.length
                ? `${highRiskPos.length} high risk PO${highRiskPos.length === 1 ? "" : "s"}`
                : "No PO is high risk"}
          </span>
          <span
            className={`ana-signal ${!withCapacity.length ? "is-neutral" : over.length ? "is-amber" : "is-green"}`}
          >
            <Scale size={13} />
            {!withCapacity.length
              ? "Capacity data pending"
              : over.length
                ? `${over.length} vendor${over.length === 1 ? "" : "s"} overloaded`
                : "Capacity balanced"}
          </span>
          <span
            className={`ana-signal ${gaps == null ? "is-neutral" : gaps.length ? "is-red" : "is-green"}`}
          >
            <PackageX size={13} />
            {gaps == null
              ? "Coverage data pending"
              : gaps.length
                ? `${gaps.length >= 8 ? "8+" : gaps.length} variants uncovered`
                : "Demand covered"}
          </span>
        </div>
      </header>
      )}

      {!only && (
      <div className="ana-tabs" role="tablist" aria-label="Decision views">
        {decisionTabs.map((tab, index) => (
          <button
            key={tab.id}
            id={`ana-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={decisionTab === tab.id}
            aria-controls="ana-decision-panel"
            tabIndex={decisionTab === tab.id ? 0 : -1}
            className={decisionTab === tab.id ? "active" : ""}
            onClick={() => setDecisionTab(tab.id)}
            onKeyDown={(event) => {
              let nextIndex = index;
              if (event.key === "ArrowRight")
                nextIndex = (index + 1) % decisionTabs.length;
              else if (event.key === "ArrowLeft")
                nextIndex =
                  (index - 1 + decisionTabs.length) % decisionTabs.length;
              else if (event.key === "Home") nextIndex = 0;
              else if (event.key === "End") nextIndex = decisionTabs.length - 1;
              else return;

              event.preventDefault();
              const nextTab = decisionTabs[nextIndex];
              setDecisionTab(nextTab.id);
              event.currentTarget.parentElement
                ?.querySelector<HTMLButtonElement>(`#ana-tab-${nextTab.id}`)
                ?.focus();
            }}
          >
            <span>{tab.number}</span>
            {tab.label}
          </button>
        ))}
      </div>
      )}

      <div
        id="ana-decision-panel"
        className="ana-tab-panel"
        role="tabpanel"
        aria-labelledby={`ana-tab-${decisionTab}`}
      >
        {decisionTab === "money" && (
          <div className="ana-grid ana-tab-grid">

            <AnaCard
              title="Cost Variance · This Month"
              icon={IndianRupee}
              tone={cost == null ? "neutral" : cost.count ? "amber" : "green"}
              status={
                cost == null ? "WAITING" : cost.count ? "MARGIN WATCH" : "CLEAR"
              }
              cta="Review cost exceptions"
              span={6}
              href="/po-approval"
              info={"WHAT: POs raised this month at a rate above the approved Standard Cost, and what that costs in margin.\n\nHOW: for each approved or issued PO this month, (rate on the PO − approved standard cost) × quantity, summed over the POs where that is positive. Example: standard ₹300, PO written at ₹320 for 1,000 pieces → ₹20,000 margin given away.\n\nUSE: each one was either a negotiation lost or a standard cost that is out of date — check which on the Standard Cost page."}
            >
              {cost == null ? (
                <NoData text="Standard-cost or PO approval data is not available." />
              ) : cost.count ? (
                <>
                  <div className="ana-metric-row">
                    <div>
                      <strong className="ana-value ana-value-xl">
                        {money.format(cost.impact)}
                      </strong>
                      <span className="ana-value-label">
                        approved margin erosion
                      </span>
                    </div>
                    <span className="ana-count-chip is-amber">
                      {cost.count} exception{cost.count === 1 ? "" : "s"}
                    </span>
                  </div>
                  <ul className="ana-list">
                    {cost.top.map((item) => (
                      <li key={`${item.poRef}-${item.productCode}`}>
                        <span className="ana-list-stack">
                          <span className="mono">{item.poRef}</span>
                          <small>{item.productCode}</small>
                        </span>
                        <span className="ana-list-val ana-text-red">
                          +{money.format(item.delta)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <ZeroState
                  compact
                  title="No above-standard PO this month"
                  text="Approved PO rates are within standard cost."
                />
              )}
            </AnaCard>

          </div>
        )}

        {decisionTab === "vendors" && (
          <div className="ana-grid ana-tab-grid">
            <AnaCard
              title="Capacity vs Demand"
              icon={Scale}
              tone={
                !withCapacity.length ? "neutral" : over.length ? "red" : "green"
              }
              status={
                !withCapacity.length
                  ? "WAITING"
                  : over.length
                    ? "REALLOCATE"
                    : "BALANCED"
              }
              cta="Open vendor capacity"
              span={7}
              rowSpan
              onClick={() => onTab("vendors")}
              info={`WHAT: which vendors have room and which are over-committed.

HOW: open-PO pieces ÷ PO capacity per vendor — what the vendor can make inside its PO type's lead time: capacity/month (karigars × daily output × working days) × lead days ÷ 30, all from Rules Master via Vendor Capacity. Under ${rules.utilization_under_pct ?? 70}% = has room; above ${rules.utilization_over_pct ?? 100}% = over-committed. Bands are editable in Rules Master.

USE: place new POs with the vendors that have room; expect delays from the over-committed ones and decide which of their POs matters most.`}
            >
              {!withCapacity.length ? (
                <NoData text="No vendor has a signed monthly capacity yet, so allocation headroom cannot be compared." />
              ) : (
                <>
                  <div className="ana-capacity-summary">
                    <div className="is-red">
                      <span>Demand to move</span>
                      <strong>{over.length}</strong>
                      <small>over-committed vendors</small>
                    </div>
                    <ArrowRight size={18} />
                    <div className="is-green">
                      <span>Where it can go</span>
                      <strong>{under.length}</strong>
                      <small>vendors with spare room</small>
                    </div>
                  </div>
                  <div className="ana-split ana-capacity-split">
                    <div className="ana-capacity-panel is-red">
                      <span className="ana-split-title">Over-committed</span>
                      {over.length ? (
                        over.slice(0, 5).map((vendor) => {
                          const excess = Math.max(
                            0,
                            vendor.openQty - vendor.poCapacity,
                          );
                          return (
                            <div
                              className="ana-vendor-row"
                              key={`${vendor.vendorCode}-${vendor.vendorBucket}`}
                            >
                              <div>
                                <span>{vendor.vendorName}</span>
                                <b>{vendor.utilizationPct}%</b>
                              </div>
                              <div className="ana-vendor-meter">
                                <i
                                  style={{
                                    width: `${clampPct(vendor.utilizationPct / 1.5)}%`,
                                  }}
                                />
                              </div>
                              <small>
                                {fmt.format(excess)} pcs above PO capacity
                              </small>
                            </div>
                          );
                        })
                      ) : (
                        <p className="ana-ok">No vendor is above capacity.</p>
                      )}
                      {over.length > 5 && (
                        <span className="ana-inline-more">
                          +{over.length - 5} more
                        </span>
                      )}
                    </div>
                    <div className="ana-capacity-panel is-green">
                      <span className="ana-split-title">Room to absorb</span>
                      {under.length ? (
                        under.slice(0, 5).map((vendor) => {
                          const spare = Math.max(
                            0,
                            vendor.poCapacity - vendor.openQty,
                          );
                          return (
                            <div
                              className="ana-vendor-row"
                              key={`${vendor.vendorCode}-${vendor.vendorBucket}`}
                            >
                              <div>
                                <span>{vendor.vendorName}</span>
                                <b>{vendor.utilizationPct}%</b>
                              </div>
                              <div className="ana-vendor-meter">
                                <i
                                  style={{
                                    width: `${clampPct(vendor.utilizationPct)}%`,
                                  }}
                                />
                              </div>
                              <small>{fmt.format(spare)} pcs available</small>
                            </div>
                          );
                        })
                      ) : (
                        <p className="ana-alert">
                          No spare capacity is available.
                        </p>
                      )}
                      {under.length > 5 && (
                        <span className="ana-inline-more">
                          +{under.length - 5} more
                        </span>
                      )}
                    </div>
                  </div>
                </>
              )}
            </AnaCard>

            <AnaCard
              title="Vendor Concentration"
              icon={Factory}
              tone={
                totalOpenValue === 0
                  ? "neutral"
                  : concentrationPct > concentrationAlert
                    ? "amber"
                    : "green"
              }
              status={
                totalOpenValue === 0
                  ? "WAITING"
                  : concentrationPct > concentrationAlert
                    ? "ABOVE RULE"
                    : "WITHIN RULE"
              }
              cta="Review vendor allocation"
              span={5}
              onClick={() => onTab("vendors")}
              info={`WHAT: how much of the open buying value sits with just three vendors.

HOW: open value of the three biggest vendors ÷ total open value, within the selected fabric pool — Woven and Knit are managed separately and never blended. Example: ₹2.1 Cr of ₹3.5 Cr with three vendors → 60%.

USE: above the ${concentrationAlert}% line (editable in Rules Master) one vendor's problem becomes SAADAA's problem. Spread the next orders.`}
            >
              <div className="ana-weave-seg" role="group" aria-label="Fabric pool">
                {(["All", "Woven", "Knit"] as const).map((w) => (
                  <button
                    key={w}
                    type="button"
                    className={`ana-weave-seg-btn${concWeave === w ? " is-active" : ""}`}
                    aria-pressed={concWeave === w}
                    onClick={(e) => {
                      e.stopPropagation();
                      setConcWeave(w);
                    }}
                  >
                    {w}
                  </button>
                ))}
              </div>
              {totalOpenValue === 0 ? (
                <NoData
                  text={
                    concWeave === "All"
                      ? "There is no open PO value to measure."
                      : `No open ${concWeave} PO value to measure.`
                  }
                />
              ) : (
                <>
                  <div className="ana-metric-row">
                    <div>
                      <strong className="ana-value ana-value-xl">
                        {concentrationPct}%
                      </strong>
                      <span className="ana-value-label">
                        of value with top 3
                      </span>
                    </div>
                    <span
                      className={`ana-count-chip ${concentrationPct > concentrationAlert ? "is-amber" : "is-green"}`}
                    >
                      Rule {concentrationAlert}%
                    </span>
                  </div>
                  <div
                    className="ana-threshold-bar"
                    style={
                      {
                        "--ana-value": `${clampPct(concentrationPct)}%`,
                        "--ana-threshold": `${clampPct(concentrationAlert)}%`,
                      } as CSSProperties
                    }
                    aria-label={`${concentrationPct}% concentration against ${concentrationAlert}% rule`}
                  >
                    <i />
                    <b />
                  </div>
                  <ul className="ana-list ana-share-list">
                    {top3.map((vendor, index) => {
                      const share =
                        totalOpenValue > 0
                          ? Math.round((vendor.value / totalOpenValue) * 100)
                          : 0;
                      return (
                        <li key={vendor.name}>
                          <span className="ana-rank">{index + 1}</span>
                          <span className="ana-list-mid">{vendor.name}</span>
                          <span className="ana-share-bar">
                            <i style={{ width: `${clampPct(share)}%` }} />
                          </span>
                          <span className="ana-list-val">{share}%</span>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </AnaCard>

            <AnaCard
              title={`Delivery Reliability · ${Math.round(windowDays / 90)}q`}
              icon={Factory}
              tone={
                reliability == null
                  ? "neutral"
                  : struggling.length
                    ? "amber"
                    : "green"
              }
              status={
                reliability == null
                  ? "WAITING"
                  : struggling.length
                    ? "WATCH"
                    : "RELIABLE"
              }
              cta="Review vendor performance"
              span={5}
              onClick={() => onTab("vendors")}
              info={`WHAT: which vendors have been late most often recently.

HOW: per vendor, POs delivered or running late ÷ all its POs in the last ${windowDays} days (≈${Math.round(windowDays / 90)} quarters), counting completed POs by their final delivery and open POs by whether they are past their date today. One count per PO number. Vendors with fewer than 2 POs in the window are left out; the window is editable in Rules Master.

USE: the ranking for who gets the next order. Click a vendor to open its POs in the tracker.`}
            >
              {reliability == null ? (
                <NoData text="PO data is not available, so vendor reliability cannot be computed." />
              ) : struggling.length ? (
                <>
                  <p className="ana-decision-line">
                    Prioritize proven capacity; these vendors are missing dates
                    now.
                  </p>
                  <div className="ana-reliability-list">
                    {struggling.map((vendor) => (
                      <button
                        type="button"
                        className="ana-reliability-row is-clickable"
                        key={vendor.vendorCode ?? vendor.vendorName}
                        onClick={(e) => {
                          e.stopPropagation();
                          onTab("open-po");
                        }}
                        title={`Open the PO tracker to review ${vendor.vendorName}`}
                      >
                        <div>
                          <span>{vendor.vendorName}</span>
                          <b>{vendor.pct}% late</b>
                        </div>
                        <div>
                          <i style={{ width: `${clampPct(vendor.pct)}%` }} />
                        </div>
                        <small>
                          {vendor.delayed} of {vendor.total} POs late ·{" "}
                          {vendor.completed} completed, {vendor.open} open
                        </small>
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <ZeroState
                  compact
                  title="No repeated delay pattern"
                  text={`${reliability.vendors.length} vendors measured in window.`}
                />
              )}
            </AnaCard>
            <AnaCard
              title="Vendor Recommendation"
              icon={Award}
              tone={!vrec ? "neutral" : vrec.risky.length ? "amber" : "green"}
              status={!vrec ? "WAITING" : `${fmt.format(vrec.rated)} RATED`}
              cta="Open Vendor Recommendation"
              span={5}
              href="/vendor-recommendation"
              info={"WHAT: the most reliable vendors, and the ones that are late half the time or more.\n\nHOW: from completed POs, for vendors with at least 3 of them: on-time POs ÷ completed POs. 'Risky' = late on 50% or more.\n\nUSE: reliable vendors are where urgent replenishment should go; risky ones need a committed date in writing before the next PO."}
            >
              {!vrec ? (
                <NoData text="Vendor recommendation data is not available." />
              ) : !vrec.rated ? (
                <NoData text="No vendor has 3+ completed POs to rate yet." />
              ) : (
                <ul className="ana-list">
                  {vrec.best.map((v) => (
                    <li key={`best-${v.name}`}>
                      <span className="ana-list-stack"><span>{v.name}</span><small>{v.completed} completed POs</small></span>
                      <span className="ana-list-val is-green">{v.onTimePct}% on time</span>
                    </li>
                  ))}
                  {vrec.risky.map((v) => (
                    <li key={`risk-${v.name}`}>
                      <span className="ana-list-stack"><span>{v.name}</span><small>{v.completed} completed POs</small></span>
                      <span className="ana-list-val is-red">{v.delayPct}% delayed</span>
                    </li>
                  ))}
                </ul>
              )}
            </AnaCard>
          </div>
        )}

        {decisionTab === "plan" && (
          <div className="ana-grid ana-tab-grid">
            <AnaCard
              title="POs issued — this week vs last"
              icon={CheckCheck}
              tone={
                issued && issued.count > 0
                  ? issued.delta.count >= 0
                    ? "green"
                    : "amber"
                  : "neutral"
              }
              status={issued ? `${issued.count} THIS WK` : "WAITING"}
              cta="Open PO Approval"
              span={4}
              href="/po-approval"
              info={"WHAT: how many POs were issued to EasyEcom this week, and whether the pace is up or down.\n\nHOW: POs issued in the last 7 days against the 7 days before that. Example: 14 this week vs 9 last week → +5.\n\nUSE: a falling pace with a long Stock Out Risk list means orders are not going out fast enough."}
            >
              {!issued ? (
                <NoData text="PO issuance data is not available." />
              ) : issued.count === 0 && issued.prior.count === 0 ? (
                <ZeroState title="None issued" text="No POs issued this week or last." compact />
              ) : (
                <>
                  <div className="ana-plan-hero">
                    <div>
                      <strong className="ana-value ana-value-xl">{fmt.format(issued.count)}</strong>
                      <span className="ana-value-label">POs this week · {fmt.format(issued.qty)} pcs</span>
                    </div>
                    <div className="ana-wow">
                      <span className={`ana-wow-delta ${issued.delta.count >= 0 ? "is-up" : "is-down"}`}>
                        {issued.delta.count >= 0 ? "▲" : "▼"} {fmt.format(Math.abs(issued.delta.count))}
                        {issued.delta.countPct != null
                          ? ` (${issued.delta.countPct > 0 ? "+" : ""}${issued.delta.countPct}%)`
                          : ""}
                      </span>
                      <small>vs {fmt.format(issued.prior.count)} last week · {fmt.format(issued.prior.qty)} pcs</small>
                    </div>
                  </div>
                  <ul className="ana-list">
                    {issued.top.map((p) => (
                      <li key={p.poRef}>
                        <span className="ana-list-stack"><span className="mono">{p.poRef}</span><small>{p.vendor}</small></span>
                        <span className="ana-list-val">{fmt.format(p.qty)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </AnaCard>

            <AnaCard
              title="Pending approval — now"
              icon={CircleAlert}
              tone={pending && pending.count > 0 ? "amber" : "neutral"}
              status={pending ? `${pending.count} WAITING` : "WAITING"}
              cta="Open Approvals"
              span={4}
              href="/approvals"
              info={"WHAT: POs waiting for someone to approve them, and the pieces they carry.\n\nHOW: POs in Submitted or Pending-admin status on PO Approval, with their quantities summed.\n\nUSE: every day these wait is a day added to the delivery. The approver sees them in Approvals."}
            >
              {!pending ? (
                <NoData text="Approval-queue data is not available." />
              ) : pending.count === 0 ? (
                <ZeroState title="Queue clear" text="No POs are waiting for approval." compact />
              ) : (
                <>
                  <div className="ana-plan-hero">
                    <div>
                      <strong className="ana-value ana-value-xl">{fmt.format(pending.count)}</strong>
                      <span className="ana-value-label">POs · {fmt.format(pending.qty)} pcs</span>
                    </div>
                  </div>
                  <ul className="ana-list">
                    {pending.top.map((p) => (
                      <li key={p.poRef}>
                        <span className="ana-list-stack"><span className="mono">{p.poRef}</span><small>{p.category}</small></span>
                        <span className="ana-list-val">{fmt.format(p.qty)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </AnaCard>


            <AnaCard
              title="Live coverage — this month"
              icon={Target}
              tone={
                planPct == null && inwardMonthPct == null
                  ? "neutral"
                  : (planPct ?? 0) >= 80 && (inwardMonthPct ?? 0) >= 80
                    ? "green"
                    : "amber"
              }
              status={
                inwardMonth
                  ? `DAY ${inwardMonth.dayOfMonth} OF ${inwardMonth.daysInMonth}`
                  : "LIVE"
              }
              cta="Open buying plan"
              span={5}
              href="/buying-plan"
              info={"WHAT: two halves of one question — did we order what we planned, and did what we ordered arrive.\n\nHOW: Buying Plan coverage = value of POs issued this month ÷ approved plan value for the month. Inward Plan coverage = pieces received (GRN) this month ÷ pieces planned to arrive — from the Inward Plan when the team has filled it, otherwise from the monthly sheet with rejected lines excluded. Example: planned ₹80 L, issued ₹60 L → 75%.\n\nUSE: high buying + low inward = a vendor/delivery problem, not a planning one. Low buying = the plan is not being executed. Month totals, not matched line by line; updates live through the month."}
            >
              <div className="ana-pair">
                <div className="ana-pair-cell">
                  <small>Buying Plan coverage</small>
                  <strong className="ana-value ana-value-xl">
                    {planPct ?? "—"}{planPct != null ? "%" : ""}
                  </strong>
                  <span className="ana-value-label">
                    {planTotals.planned > 0
                      ? `${money.format(planTotals.actual)} issued of ${money.format(planTotals.planned)} planned`
                      : "no approved plan value this month"}
                  </span>
                  <div className="ana-plan-track"><i style={{ width: `${clampPct(planPct ?? 0)}%` }} /></div>
                </div>
                <div className="ana-pair-cell">
                  <small>Inward Plan coverage</small>
                  <strong className="ana-value ana-value-xl">
                    {inwardMonthPct ?? "—"}{inwardMonthPct != null ? "%" : ""}
                  </strong>
                  <span className="ana-value-label">
                    {inwardMonth && inwardMonth.planned > 0
                      ? `${fmt.format(inwardMonth.actual)} pcs received of ${fmt.format(inwardMonth.planned)} expected`
                      : "no inward quantity planned for this month"}
                  </span>
                  {inwardMonth && inwardMonth.source === "inward-plan" && (
                    <span className="ana-value-label ana-src-warn">
                      Inward Plan input is empty
                      {inwardMonth.awaitingInput > 0
                        ? ` — ${fmt.format(inwardMonth.awaitingInput)} PO lines awaiting input`
                        : ""}
                      . Denominator is the older monthly Inward Plan sheet, so read it as
                      indicative until the Inward Plan input is filled.
                    </span>
                  )}
                  <div className="ana-plan-track"><i style={{ width: `${clampPct(inwardMonthPct ?? 0)}%` }} /></div>
                </div>
              </div>
              {inwardMonth && inwardMonth.dayOfMonth < inwardMonth.daysInMonth && (
                <p className="ana-note">
                  Both figures are month-to-date with{" "}
                  {inwardMonth.daysInMonth - inwardMonth.dayOfMonth} days still to run — they are a
                  pacing check, not a final score.
                </p>
              )}
              {planPct != null && inwardMonthPct != null && planPct - inwardMonthPct >= 30 && (
                <p className="ana-note">
                  Commitments are running well ahead of arrivals — check vendor follow-up / TNA before adding more plan.
                </p>
              )}
            </AnaCard>

            <AnaCard
              title="Buying Plan Realization"
              icon={Target}
              tone={
                !realization || !curMonth?.buckets.length ? "neutral" : "green"
              }
              status={
                !realization || !curMonth?.buckets.length
                  ? "WAITING"
                  : "MONTH TO DATE"
              }
              cta="Open buying plan"
              span={7}
              rowSpan
              href="/buying-plan"
              info={"WHAT: planned buying against what was actually ordered, by weave, this month and the two before.\n\nHOW: approved plan value vs issued PO value, split Woven / Knit, per month.\n\nUSE: a persistent gap in one weave means that side of the plan is not being executed — worth asking why before the next plan is approved."}
            >
              {!realization ? (
                <NoData text="Buying-plan or PO actuals data is not available." />
              ) : !curMonth || !curMonth.buckets.length ? (
                <NoData
                  text={`No buying plan was found for ${new Date().toISOString().slice(0, 7)}.`}
                />
              ) : (
                <>
                  <div className="ana-plan-hero">
                    <div>
                      <strong className="ana-value ana-value-xl">
                        {planPct ?? "—"}
                        {planPct != null ? "%" : ""}
                      </strong>
                      <span className="ana-value-label">of plan issued</span>
                    </div>
                    <div className="ana-plan-values">
                      <span>
                        <small>Issued</small>
                        <b>{money.format(planTotals.actual)}</b>
                      </span>
                      <span>
                        <small>Planned</small>
                        <b>{money.format(planTotals.planned)}</b>
                      </span>
                      <span>
                        <small>
                          {planVariance >= 0 ? "Above plan" : "Still to issue"}
                        </small>
                        <b>{money.format(Math.abs(planVariance))}</b>
                      </span>
                    </div>
                  </div>
                  <div className="ana-plan-track">
                    <i style={{ width: `${clampPct(planPct ?? 0)}%` }} />
                  </div>
                  <div className="ana-category-bars">
                    {curMonth.buckets.map((bucket) => {
                      const pct =
                        bucket.planned > 0
                          ? Math.round((bucket.actual / bucket.planned) * 100)
                          : null;
                      return (
                        <div key={bucket.category} className="ana-bar-row">
                          <span className="ana-bar-label">
                            {bucket.category}
                          </span>
                          <div className="ana-bar">
                            <div
                              className="ana-bar-fill"
                              style={{ width: `${clampPct(pct ?? 0)}%` }}
                            />
                          </div>
                          <span className="ana-bar-val">
                            <b>{pct == null ? "—" : `${pct}%`}</b>
                            {money.format(bucket.actual)} /{" "}
                            {money.format(bucket.planned)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <div
                    className="ana-months"
                    aria-label="Three-month buying plan realization"
                  >
                    {(realization ?? [])
                      .slice()
                      .reverse()
                      .map((month) => {
                        const planned = month.buckets.reduce(
                          (sum, bucket) => sum + bucket.planned,
                          0,
                        );
                        const actual = month.buckets.reduce(
                          (sum, bucket) => sum + bucket.actual,
                          0,
                        );
                        const pct =
                          planned > 0
                            ? Math.round((actual / planned) * 100)
                            : null;
                        return (
                          <div key={month.month}>
                            <span>{monthLabel(month.month)}</span>
                            <div>
                              <i
                                style={{
                                  height: `${Math.max(4, clampPct(pct ?? 0))}%`,
                                }}
                              />
                            </div>
                            <b>{pct == null ? "—" : `${pct}%`}</b>
                          </div>
                        );
                      })}
                  </div>
                </>
              )}
            </AnaCard>

            <AnaCard
              title="TNA Compliance Trend"
              icon={TrendingUp}
              tone={
                trend == null || trendData.length < 2
                  ? "neutral"
                  : latestTrend?.overdue
                    ? "red"
                    : latestTrend?.highRisk
                      ? "amber"
                      : "green"
              }
              status={
                trend == null || trendData.length < 2
                  ? "COLLECTING"
                  : latestTrend?.overdue
                    ? "OVERDUE"
                    : latestTrend?.highRisk
                      ? "WATCH"
                      : "ON TRACK"
              }
              cta="Review PO tracker"
              span={5}
              onClick={() => onTab("open-po")}
              info={"WHAT: is execution getting better or worse — the share of open POs on track, day by day.\n\nHOW: each day, POs with no critical-path stage past its planned date ÷ open POs, using the same TNA rule as the tracker. Recorded once a day when the dashboard is opened.\n\nUSE: today's number alone can hide a slide; the line shows the direction. A falling line with a steady PO count means stages are slipping, not that more was ordered."}
            >
              {trend == null ? (
                <NoData text="The TNA snapshot table is not available." />
              ) : trendData.length < 2 ? (
                <NoData
                  text={`Trend collection ${trendData.length ? `started ${trend[0].snapshot_date}` : "starts with the next snapshot"}; at least two points are needed.`}
                />
              ) : (
                <>
                  <div className="ana-metric-row ana-trend-metric">
                    <div>
                      <strong className="ana-value ana-value-xl">
                        {latestTrend?.onTimePct}%
                      </strong>
                      <span className="ana-value-label">on track today</span>
                    </div>
                    <span
                      className={`ana-delta ${(trendDelta ?? 0) >= 0 ? "is-up" : "is-down"}`}
                    >
                      {(trendDelta ?? 0) > 0 ? "+" : ""}
                      {trendDelta} pts
                    </span>
                  </div>
                  <div className="ana-chart">
                    <ResponsiveContainer width="100%" height={142}>
                      <AreaChart
                        data={trendData}
                        margin={{ top: 8, right: 6, left: -20, bottom: 0 }}
                      >
                        <defs>
                          <linearGradient
                            id="anaOnTime"
                            x1="0"
                            y1="0"
                            x2="0"
                            y2="1"
                          >
                            <stop
                              offset="0%"
                              stopColor="#3d9e6b"
                              stopOpacity={0.32}
                            />
                            <stop
                              offset="100%"
                              stopColor="#3d9e6b"
                              stopOpacity={0.01}
                            />
                          </linearGradient>
                        </defs>
                        <CartesianGrid
                          stroke="#efeae0"
                          strokeDasharray="3 3"
                          vertical={false}
                        />
                        <XAxis
                          dataKey="date"
                          fontSize={9}
                          tickLine={false}
                          axisLine={false}
                        />
                        <YAxis
                          domain={[0, 100]}
                          fontSize={9}
                          tickLine={false}
                          axisLine={false}
                        />
                        <Tooltip
                          formatter={(value) => [
                            `${Number(value)}%`,
                            "On track",
                          ]}
                        />
                        <Area
                          type="monotone"
                          dataKey="onTimePct"
                          stroke="#3d9e6b"
                          fill="url(#anaOnTime)"
                          strokeWidth={2.25}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="ana-status-pair">
                    <span className="is-amber">
                      <b>{latestTrend?.highRisk ?? 0}</b> high risk
                    </span>
                    <span className="is-red">
                      <b>{latestTrend?.overdue ?? 0}</b> overdue
                    </span>
                  </div>
                </>
              )}
            </AnaCard>

            <AnaCard
              title="PO Closure Compliance"
              icon={CheckCheck}
              tone={
                !closure
                  ? "neutral"
                  : closure.openBeyondSla > 0
                    ? "red"
                    : "green"
              }
              status={
                !closure
                  ? "WAITING"
                  : closure.openBeyondSla > 0
                    ? "SLA BREACH"
                    : "COMPLIANT"
              }
              cta="Open closure queue"
              span={5}
              href="/po-closure"
              info={`WHAT: are completed POs being closed out on time.

HOW: completed POs closed within ${closure?.slaDays ?? 15} days of completion ÷ completed POs, plus a count of closures still open beyond that. The SLA is editable in Rules Master.

USE: late closures hold up vendor payment and keep received goods looking 'open' on every other card.`}
            >
              {!closure ? (
                <NoData text="PO closure data is not available." />
              ) : (
                <div className="ana-closure-layout">
                  <div
                    className={`ana-ring ${closurePct == null ? "is-empty" : ""}`}
                    style={
                      {
                        "--ana-ring": `${clampPct(closurePct ?? 0)}%`,
                      } as CSSProperties
                    }
                  >
                    <div>
                      <strong>
                        {closurePct == null ? "—" : `${closurePct}%`}
                      </strong>
                      <span>within SLA</span>
                    </div>
                  </div>
                  <div className="ana-closure-copy">
                    <span
                      className={
                        closure.openBeyondSla
                          ? "ana-breach-count"
                          : "ana-clear-count"
                      }
                    >
                      {closure.openBeyondSla}
                    </span>
                    <strong>
                      open closure{closure.openBeyondSla === 1 ? "" : "s"} past{" "}
                      {closure.slaDays} days
                    </strong>
                    <small>
                      {closure.closedTotal
                        ? `${closure.closedWithinSla} of ${closure.closedTotal} completed closures met SLA`
                        : "No completed closure history yet"}
                    </small>
                  </div>
                </div>
              )}
            </AnaCard>
          </div>
        )}

        {decisionTab === "stock" && (
          <div className="ana-grid ana-tab-grid">
            <AnaCard
              title="Inward — last 7 days"
              icon={Scale}
              tone={inward && inwardPct != null && inwardPct >= 80 ? "green" : inward ? "amber" : "neutral"}
              status={inwardPct != null ? `${inwardPct}% RECEIVED` : "WAITING"}
              cta="Open Inward Plan"
              span={4}
              href="/inward-plan"
              info={"WHAT: last week — what was due to arrive against what actually did.\n\nHOW: pending pieces on lines whose expected delivery date fell last week, vs pieces received (GRN) last week. Totals, not matched line by line.\n\nUSE: a big gap means last week's due dates were missed; check the PO Tracker's overdue band for which ones."}
            >
              {!inward ? (
                <NoData text="Inward-plan / GRN data is not available." />
              ) : (
                <div className="ana-plan-hero">
                  <div>
                    <strong className="ana-value ana-value-xl">
                      {inwardPct ?? "—"}{inwardPct != null ? "%" : ""}
                    </strong>
                    <span className="ana-value-label">received vs planned</span>
                  </div>
                  <div className="ana-plan-values">
                    <span><small>Actual</small><b>{fmt.format(inward.actual)}</b></span>
                    <span><small>Planned</small><b>{fmt.format(inward.planned)}</b></span>
                  </div>
                </div>
              )}
            </AnaCard>
            <AnaCard
              title="Replenishment Queue"
              icon={Repeat}
              tone={!repl ? "neutral" : repl.oosVariants > 0 ? "red" : repl.variants > 0 ? "amber" : "green"}
              status={!repl ? "WAITING" : `${fmt.format(repl.variants)} VARIANTS`}
              cta={isAdmin ? "Open Replenishment" : "Open Urgent Replenishment"}
              span={6}
              {...(isAdmin
                ? { href: "/replenishment" }
                : { onClick: () => onTab("urgent-replenish") })}
              info={"WHAT: the colours the replenishment rule says to order now, and how many are already empty.\n\nHOW: from Replenishment: variants whose 30-day reorder quantity is above zero (stock + on order will not cover 30 days at the IPDOQ rate), the pieces called for, and how many have zero stock today.\n\nUSE: the order list for this week. The Replenishment page has the per-variant quantities."}
            >
              {!repl ? (
                <NoData text="Replenishment data is not available." />
              ) : repl.variants === 0 ? (
                <ZeroState title="Queue clear" text="No variant currently trips its 30-day reorder point." compact />
              ) : (
                <div className="ana-plan-hero">
                  <div>
                    <strong className="ana-value ana-value-xl">{fmt.format(repl.rop30Qty)}</strong>
                    <span className="ana-value-label">pieces to order · ROP 30</span>
                  </div>
                  <div className="ana-plan-values">
                    <span><small>Variants</small><b>{fmt.format(repl.variants)}</b></span>
                    <span><small>Had OOS days (last 45)</small><b>{fmt.format(repl.oosVariants)}</b></span>
                  </div>
                </div>
              )}
            </AnaCard>


            <AnaCard
              title="Inward Pipeline"
              icon={Truck}
              tone={!pipe ? "neutral" : pipe.overdueQty > 0 ? "amber" : "green"}
              status={!pipe ? "WAITING" : `${fmt.format(pipe.next7Qty)} PCS · 7D`}
              cta="Open Inward Plan"
              span={7}
              href="/inward-plan"
              info={"WHAT: what is landing this week, what is already late, and what has no date at all.\n\nHOW: pending pieces on open lines with expected delivery date in the next 7 days; past their date; or with no date set.\n\nUSE: the warehouse's week ahead. The 'no date' lines need a date set at PO Approval before they can be planned."}
            >
              {!pipe ? (
                <NoData text="Inward-plan data is not available." />
              ) : (
                <>
                  <div className="ana-plan-hero">
                    <div>
                      <strong className="ana-value ana-value-xl">{fmt.format(pipe.next7Qty)}</strong>
                      <span className="ana-value-label">pieces due in the next 7 days · {fmt.format(pipe.next7Lines)} lines</span>
                    </div>
                    <div className="ana-plan-values">
                      <span><small>Overdue to arrive</small><b>{fmt.format(pipe.overdueQty)}</b></span>
                      <span><small>Total in pipeline</small><b>{fmt.format(pipe.totalQty)}</b></span>
                    </div>
                  </div>
                  <ul className="ana-list">
                    <li>
                      <span className="ana-list-stack"><span>Overdue lines</span><small>EDD already past, stock not in</small></span>
                      <span className="ana-list-val">{fmt.format(pipe.overdueLines)}</span>
                    </li>
                    <li>
                      <span className="ana-list-stack"><span>No EDD</span><small>lines with no delivery date in EasyCom</small></span>
                      <span className="ana-list-val">{fmt.format(pipe.noEddLines)}</span>
                    </li>
                  </ul>
                </>
              )}
            </AnaCard>

          </div>
        )}

        {decisionTab === "datahealth" && (
          <div className="ana-grid ana-tab-grid">
            <AnaCard
              title="Open POs of Discontinued Products"
              icon={Ban}
              tone={
                disc == null ? "neutral" : discontinuedCount ? "red" : "green"
              }
              status={
                disc == null
                  ? "WAITING"
                  : discontinuedCount
                    ? "DATA ISSUE"
                    : "CLEAN"
              }
              cta="Review affected PO lines"
              span={6}
              onClick={() => onTab("open-po")}
              info={"WHAT: discontinued products that are still being bought.\n\nHOW: products marked Discontinued in the Product Master that have an open PO line with pending quantity, or a line on the current buying plan.\n\nUSE: should always read zero. Anything here is either a wrong product state or a PO that should be cancelled."}
            >
              {disc == null ? (
                <NoData text="Product Master data is not available, so lifecycle integrity cannot be checked." />
              ) : discontinuedCount ? (
                <>
                  <div className="ana-metric-row">
                    <div>
                      <strong className="ana-value ana-value-xl">
                        {discontinuedCount}
                      </strong>
                      <span className="ana-value-label">
                        discontinued products still being bought
                      </span>
                    </div>
                    <div className="ana-mini-split">
                      <span>
                        <b>{disc.openPoCount}</b> open PO
                      </span>
                      <span>
                        <b>{disc.planLineCount}</b> plan
                      </span>
                    </div>
                  </div>
                  <p className="ana-decision-line">
                    {fmt.format(disc.openPoQty)} pending pieces reference
                    discontinued products.
                  </p>
                  {disc.codes.length > 0 && (
                    <div className="ana-code-list">
                      {disc.codes.slice(0, 6).map((code) => (
                        <span className="mono" key={code}>
                          {code}
                        </span>
                      ))}
                      {disc.codes.length > 6 && (
                        <span>+{disc.codes.length - 6}</span>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <ZeroState
                  compact
                  title="Lifecycle data is clean"
                  text="No discontinued product is being bought or planned."
                />
              )}
                          <p className="ana-foot-link">
                <Link href="/issues?category=product" onClick={(e) => e.stopPropagation()}>
                  Each one is raised on the Issue Tracker →
                </Link>
              </p>
</AnaCard>
            <AnaCard
              title="Product Master Mix"
              icon={Database}
              tone="neutral"
              status={stateMix ? `${fmt.format(stateTotal)} CODES` : "WAITING"}
              cta="Open Product Master"
              span={7}
              href="/product-master"
              info={"WHAT: the product catalogue by lifecycle state.\n\nHOW: every product code in the master counted by state — Ongoing, NPD, NPD Not Launched, SKU-Create, To Be Discontinued, Discontinued.\n\nUSE: Discontinued and SKU-Create should shrink over time; a growing SKU-Create pile means new products are stuck before launch."}
            >
              {!stateMix ? (
                <NoData text="Product master data is not available." />
              ) : (
                <ul className="ana-list">
                  {stateMix.slice(0, 6).map((m) => (
                    <li key={m.state}>
                      <span className="ana-list-stack">
                        <span>{m.state}</span>
                        <small>{stateTotal ? Math.round((m.count / stateTotal) * 100) : 0}% of codes</small>
                      </span>
                      <span className="ana-list-val">{fmt.format(m.count)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </AnaCard>

            <AnaCard
              title="Sync Freshness"
              icon={RefreshCw}
              tone={!sync ? "neutral" : sync.stale.length ? "red" : "green"}
              status={!sync ? "WAITING" : sync.stale.length ? `${sync.stale.length} STALE` : "ALL FRESH"}
              cta="Open Sync Health"
              span={5}
              href="/sync-status"
              info={`WHAT: is the data on this dashboard fresh.

HOW: every synced feed with the time of its last refresh. A feed is flagged stale after ${sync?.staleHours ?? 30} hours without one (editable in Rules Master).

USE: if a feed is stale, every card built on it is showing yesterday's or older numbers — check Sync Health before acting on them.`}
            >
              {!sync ? (
                <NoData text="Sync status data is not available." />
              ) : sync.stale.length === 0 ? (
                <ZeroState
                  title="All feeds fresh"
                  text={`${fmt.format(sync.feeds)} feeds; oldest refreshed ${sync.oldestHours ?? 0}h ago.`}
                  compact
                />
              ) : (
                <ul className="ana-list">
                  {sync.stale.map((s) => (
                    <li key={`${s.pipeline}-${s.source}`}>
                      <span className="ana-list-stack"><span>{s.source}</span><small>{s.pipeline}</small></span>
                      <span className="ana-list-val is-red">{s.hoursAgo >= 999 ? "never" : `${s.hoursAgo}h ago`}</span>
                    </li>
                  ))}
                </ul>
              )}
                          <p className="ana-foot-link">
                <Link href="/issues?category=data" onClick={(e) => e.stopPropagation()}>
                  Stale feeds are raised on the Issue Tracker →
                </Link>
              </p>
</AnaCard>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * The two stock objectives, lifted out of the decision tabs so all five objectives sit
 * together above them. The cards themselves are unchanged — same figures, same ABC split,
 * same CSV, same click-through; only where they render has moved.
 */
export function ObjectiveStockCards({
  extras,
  onTab,
}: {
  extras?: AnalyticsExtras | null;
  onTab: (id: TabId) => void;
}) {
  const gaps = extras?.stockoutGaps ?? null;
  const risk = gaps;
  const watch = extras?.stockoutWatch30 ?? null;
  const oosSum = extras?.oosSummary ?? null;
  const stopped = (risk ?? []).filter((v) => v.reason === "stopped");
  /** Variant-level CSV: everything the buyer needs to raise the PO, nothing rolled up. */
  const exportRiskCsv = (rows: StockoutRiskVariant[], filename: string) => {
    if (!rows.length) return;
    downloadCsv(
      filename,
      [
        "product_variant",
        "product_code",
        "product_name",
        "product_state",
        "sales_class",
        "current_stock",
        "on_order",
        "daily_demand",
        "days_of_cover",
        "reason",
      ],
      rows.map((v) => [
        v.product_variant,
        v.product_code ?? "",
        v.product_name ?? "",
        v.product_state ?? "",
        v.abc_class,
        v.current_stock,
        v.in_process,
        v.daily_demand,
        v.days_on_hand == null ? "" : Math.round(v.days_on_hand),
        v.reason === "stopped" ? "nothing in stock or on order" : "cover runs out before lead time",
      ]),
    );
  };

  return (
    <div className="ana-grid ana-tab-grid">

      <AnaCard
        title="Stock Out Risk"
        icon={PackageX}
        tone={risk == null ? "neutral" : risk.length ? "red" : "green"}
        status={risk == null ? "WAITING" : risk.length ? "ACT NOW" : "ALL COVERED"}
        cta="Open urgent replenishment"
        span={5}
        onClick={() => onTab("urgent-replenish")}
        info={"WHAT: the colours that will run out before new goods can arrive — the ones that need a PO now.\n\nHOW: only products that can sell (Ongoing and launched NPD; never NPD Not Launched; test SKUs left out). A colour is listed for one of two reasons: (1) nothing in stock and nothing on order — it cannot sell at all; or (2) stock + on order ÷ daily demand is less than the 45-day lead time. Example: 90 in stock, 0 on order, 3 a day → 30 days of cover, under 45 → listed.\n\nUSE: reason (1) first — those are lost sales today. Busiest sellers first. Download the full list as CSV for the PO round."}
      >
        {risk == null ? (
          <NoData text="Replenishment data is not available, so stock-out risk cannot be checked." />
        ) : risk.length ? (
          <>
            <div className="ana-metric-row">
              <div>
                <strong className="ana-value ana-value-xl">{fmt.format(risk.length)}</strong>
                <span className="ana-value-label">variants need a PO now</span>
              </div>
              <div>
                <strong className="ana-value ana-value-xl">{fmt.format(stopped.length)}</strong>
                <span className="ana-value-label">cannot sell today</span>
              </div>
              <button
                type="button"
                className="ana-csv-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  exportRiskCsv(risk, "stock-out-risk-variants.csv");
                }}
              >
                Download CSV
              </button>
            </div>
            <div className="ana-abcd-row">
              {(["A", "B", "C", "D"] as const).map((cls) => (
                <span key={cls} className={`ana-abcd-chip cls-${cls}`}>
                  {cls} · {fmt.format(risk.filter((r) => r.abc_class === cls).length)}
                </span>
              ))}
              <span className="ana-value-label">A sells fastest</span>
            </div>
            <ul className="ana-list ana-demand-list">
              {risk.slice(0, 5).map((v, index) => (
                <li key={v.product_variant}>
                  <span className="ana-rank">{index + 1}</span>
                  <span className="ana-list-stack">
                    <span>{v.product_name ?? v.product_code ?? v.product_variant}</span>
                    <small className="mono">{v.product_variant}</small>
                  </span>
                  <span className="ana-list-val">
                    <span className={`ana-abcd-tag cls-${v.abc_class}`}>{v.abc_class}</span>
                    {v.reason === "stopped"
                      ? "nothing in stock or on order"
                      : `${Math.round(v.days_on_hand ?? 0)} days of cover`}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <ZeroState
            title="Everything is covered"
            text="No sellable variant runs out inside the 45-day lead time."
          />
        )}
      </AnaCard>

      <AnaCard
        title="Fast sellers running out in 30 days"
        icon={PackageSearch}
        tone={watch == null ? "neutral" : watch.length ? "amber" : "green"}
        status={watch == null ? "WAITING" : watch.length ? `${fmt.format(watch.length)} TO ORDER` : "CLEAR"}
        cta="Open urgent replenishment"
        span={5}
        onClick={() => onTab("urgent-replenish")}
        info={"WHAT: the fast sellers (class A and B) that run out within 30 days — the orders to place first.\n\nHOW: same population and rule as Stock Out Risk, on a 30-day horizon instead of 45, and only variants whose sales class is A or B (thresholds in Rules Master). D-class items rarely appear — they sell too slowly to run out fast.\n\nUSE: these cost real sales when empty. Place these POs before anything else on the Stock Out Risk list."}
      >
        {watch == null ? (
          <NoData text="Replenishment data is not available." />
        ) : watch.length ? (
          <>
            <div className="ana-metric-row">
              <div>
                <strong className="ana-value ana-value-xl">{fmt.format(watch.length)}</strong>
                <span className="ana-value-label">fast sellers at risk</span>
              </div>
              <button
                type="button"
                className="ana-csv-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  exportRiskCsv(watch, "fast-sellers-30-day-risk.csv");
                }}
              >
                Download CSV
              </button>
            </div>
            <ul className="ana-list ana-demand-list">
              {watch.slice(0, 5).map((v, index) => (
                <li key={v.product_variant}>
                  <span className="ana-rank">{index + 1}</span>
                  <span className="ana-list-stack">
                    <span>{v.product_name ?? v.product_code ?? v.product_variant}</span>
                    <small className="mono">{v.product_variant}</small>
                  </span>
                  <span className="ana-list-val">
                    <span className={`ana-abcd-tag cls-${v.abc_class}`}>{v.abc_class}</span>
                    {Math.round(v.days_on_hand ?? 0)} days left
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <ZeroState
            title="No fast seller is short"
            text="Every A and B variant has more than 30 days of cover."
          />
        )}
      </AnaCard>
        <AnaCard
          title="Out of Stock"
          icon={PackageX}
          tone={!oosSum ? "neutral" : oosSum.zeroStock > 0 ? "amber" : "green"}
          status={!oosSum ? "WAITING" : `${fmt.format(oosSum.zeroStock)} SKUS`}
          cta="Open DOQ Calculation"
          span={6}
          href="/oos-calculation"
          info={`SKUs in the DOQ Calculation sheet with zero current stock.${oosSum?.dataAsOf ? ` Inventory data as of ${oosSum.dataAsOf}.` : ""}`}
        >
          {!oosSum ? (
            <NoData text="DOQ Calculation data is not available." />
          ) : (
            <div className="ana-plan-hero">
              <div>
                <strong className="ana-value ana-value-xl">
                  {oosSum.totalSkus ? Math.round((oosSum.zeroStock / oosSum.totalSkus) * 100) : 0}%
                </strong>
                <span className="ana-value-label">of tracked SKUs at zero stock</span>
              </div>
              <div className="ana-plan-values">
                <span><small>Zero stock</small><b>{fmt.format(oosSum.zeroStock)}</b></span>
                <span><small>Tracked</small><b>{fmt.format(oosSum.totalSkus)}</b></span>
                {gaps && (
                  <span>
                    <small>Cannot sell</small>
                    <b>{fmt.format(gaps.filter((g) => g.reason === "stopped").length)}</b>
                  </span>
                )}
              </div>
            </div>
          )}
        </AnaCard>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Objectives synopsis — the team's dashboard sheet, one card per line   */
/* ------------------------------------------------------------------ */

const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "—");

/**
 * The analytics the team listed for the dashboard, as counts with their percentages:
 * the PO book (open / overdue / high risk, with ageing), Inward Plan vs actual GRN, OOS by
 * sales class with days on hand, the Buying Plan month, approval requisitions, and ISR.
 * Every card is built from sections the dashboard already loads; each is best-effort.
 */
export function ObjectiveSynopsisCards({
  extras,
  book,
  onTab,
}: {
  extras: AnalyticsExtras | null;
  book: { open: number; overdue: number; highRisk: number; ageing: { name: string; value: number }[] };
  onTab: (id: TabId) => void;
}) {
  const router = useRouter();
  const pb = extras?.poBook ?? null;
  const allPos = pb ? pb.open + pb.completed : 0;
  const iw = extras?.inwardSynopsis ?? null;
  const oos = extras?.oosSynopsis ?? null;
  const plan = extras?.planSynopsis ?? null;
  const ap = extras?.approvalRequisitions ?? null;
  const isr = extras?.isr ?? null;
  const isrPct = isr && isr.soldQty > 0 ? Math.round((isr.inwardQty / isr.soldQty) * 100) : null;

  return (
    <div className="ana-grid ana-tab-grid">
      <AnaCard
        title="PO book"
        icon={FileCheck}
        tone={book.overdue > 0 ? "red" : "green"}
        status={`${fmt.format(book.open)} OPEN`}
        cta="Open the PO Tracker"
        span={4}
        onClick={() => onTab("open-po")}
        info={"WHAT: the purchase-order book in three numbers, each with its share.\n\nHOW: Open = POs with pieces still to arrive, as a share of every PO there has ever been (open + completed). Overdue = open POs past their expected delivery date, as a share of open. High Risk = open POs with a critical-path TNA stage past its planned date, as a share of open. Ageing splits the open POs by how far past their date they are.\n\nUSE: overdue and high-risk shares rising together means the book is slipping, not just one vendor."}
      >
        <ul className="ana-list">
          <li><span>Open POs</span><span className="ana-list-val">{fmt.format(book.open)} · {pct(book.open, allPos)} of all POs</span></li>
          <li><span>Overdue POs</span><span className="ana-list-val">{fmt.format(book.overdue)} · {pct(book.overdue, book.open)} of open</span></li>
          <li><span>High Risk POs</span><span className="ana-list-val">{fmt.format(book.highRisk)} · {pct(book.highRisk, book.open)} of open</span></li>
        </ul>
        <div className="ana-abcd-row">
          {book.ageing.map((b) => (
            <span key={b.name} className="ana-abcd-chip">{b.name} · {fmt.format(b.value)}</span>
          ))}
        </div>
      </AnaCard>

      <AnaCard
        title="Inward Plan vs actual GRN"
        icon={PackageCheck}
        tone={!iw ? "neutral" : iw.shortPos || iw.unplannedPos ? "red" : "green"}
        status={iw ? `${fmt.format(iw.plannedPos)} POS PLANNED` : "WAITING"}
        cta="Open the Inward Plan"
        span={4}
        href="/receivable-plan"
        info={"WHAT: this month, did what the team planned to receive actually arrive — and what arrived that nobody planned.\n\nHOW: per PO planned on the Inward Plan for this month: received (GRN) less than planned = short, more = excess, equal = on plan. Not in plan = POs with receipts this month and no Inward Plan entry. Counted at PO level because the plan is per colour and GRN per SKU; the PO is what both share.\n\nUSE: many short POs is a vendor problem; many not-in-plan receipts means the Inward Plan is not being filled."}
      >
        {!iw ? (
          <NoData text="Inward Plan and GRN data are not available." />
        ) : (
          <ul className="ana-list">
            <li><span>Short of plan</span><span className="ana-list-val">{fmt.format(iw.shortPos)} · {pct(iw.shortPos, iw.plannedPos)}</span></li>
            <li><span>Excess over plan</span><span className="ana-list-val">{fmt.format(iw.excessPos)} · {pct(iw.excessPos, iw.plannedPos)}</span></li>
            <li><span>On plan</span><span className="ana-list-val">{fmt.format(iw.onPlanPos)} · {pct(iw.onPlanPos, iw.plannedPos)}</span></li>
            <li><span>Received, not in plan</span><span className="ana-list-val">{fmt.format(iw.unplannedPos)} · {pct(iw.unplannedPos, iw.receivedPos)} of received</span></li>
            <li><span>Pieces</span><span className="ana-list-val">{fmt.format(iw.receivedQty)} received of {fmt.format(iw.plannedQty)} planned</span></li>
          </ul>
        )}
      </AnaCard>

      <AnaCard
        title="OOS by sales class"
        icon={Boxes}
        tone={!oos ? "neutral" : oos.oosNow ? "red" : "green"}
        status={oos ? `${fmt.format(oos.oosNow)} OUT NOW` : "WAITING"}
        cta="Open Product Tracker → In stock"
        span={4}
        onClick={() => onTab("products")}
        info={"WHAT: out of stock by sales class, at variant (colour) level — A sells fastest, D slowest.\n\nHOW: over every selling variant (Ongoing + launched NPD, test SKUs out): Out now = zero stock today; At risk = stock plus what is on order runs out inside the 45-day lead time; DOH = average days on hand (stock + on order ÷ daily demand). Percentages are of the variants in that class.\n\nUSE: an A-class variant out of stock is lost sales every day — those first."}
      >
        {!oos ? (
          <NoData text="Stock and demand data are not available." />
        ) : (
          <table className="ana-mini-table">
            <thead><tr><th>Class</th><th className="num">Variants</th><th className="num">Out now</th><th className="num">At risk</th><th className="num">Avg DOH</th></tr></thead>
            <tbody>
              {oos.byClass.map((c) => (
                <tr key={c.cls}>
                  <td><span className={`ana-abcd-tag cls-${c.cls}`}>{c.cls}</span></td>
                  <td className="num">{fmt.format(c.variants)}</td>
                  <td className="num">{fmt.format(c.oosNow)} · {pct(c.oosNow, c.variants)}</td>
                  <td className="num">{fmt.format(c.atRisk)} · {pct(c.atRisk, c.variants)}</td>
                  <td className="num">{c.avgDoh == null ? "—" : `${c.avgDoh}d`}</td>
                </tr>
              ))}
              <tr className="ana-mini-total">
                <td>All</td>
                <td className="num">{fmt.format(oos.total)}</td>
                <td className="num">{fmt.format(oos.oosNow)} · {pct(oos.oosNow, oos.total)}</td>
                <td className="num">{fmt.format(oos.atRisk)} · {pct(oos.atRisk, oos.total)}</td>
                <td className="num">—</td>
              </tr>
            </tbody>
          </table>
        )}
      </AnaCard>

      <AnaCard
        title="Buying Plan synopsis"
        icon={ShoppingCart}
        tone={!plan || !plan.hasPlan ? "neutral" : plan.over || plan.notInPlan ? "red" : "green"}
        status={plan?.hasPlan ? `${plan.month} · ${pct(plan.issuedQty, plan.plannedQty)} BOUGHT` : "NO PLAN"}
        cta="Open Buying Plan analysis"
        span={4}
        href="/buying-plan?type=analysis"
        info={"WHAT: this month's buying plan against what was actually ordered.\n\nHOW: Planned = approved plan pieces; Bought = pieces on real EasyEcom POs dated this month; Pending = planned − bought. Per product: short (bought less than approved), excess (more), not in plan (bought with no approved quantity). Percentages of planned products, or of issued products for not-in-plan.\n\nUSE: pending late in the month = the plan is not being executed; not-in-plan = buying outside the plan."}
      >
        {!plan || !plan.hasPlan ? (
          <NoData text="No approved buying plan for this month." />
        ) : (
          <ul className="ana-list">
            <li><span>Planned</span><span className="ana-list-val">{fmt.format(plan.plannedQty)} pcs · {fmt.format(plan.plannedProducts)} products</span></li>
            <li><span>Bought</span><span className="ana-list-val">{fmt.format(plan.issuedQty)} pcs · {pct(plan.issuedQty, plan.plannedQty)}</span></li>
            <li><span>Pending</span><span className="ana-list-val">{fmt.format(plan.pendingQty)} pcs · {pct(plan.pendingQty, plan.plannedQty)}</span></li>
            <li><span>Short / excess</span><span className="ana-list-val">{fmt.format(plan.short)} · {pct(plan.short, plan.plannedProducts)} / {fmt.format(plan.over)} · {pct(plan.over, plan.plannedProducts)}</span></li>
            <li><span>Bought, not in plan</span><span className="ana-list-val">{fmt.format(plan.notInPlan)} · {pct(plan.notInPlan, plan.issuedProducts)} of issued</span></li>
          </ul>
        )}
      </AnaCard>

      <AnaCard
        title="Approval requisitions"
        icon={ClipboardCheck}
        tone={!ap ? "neutral" : ap.total ? "red" : "green"}
        status={ap ? `${fmt.format(ap.total)} WAITING` : "WAITING"}
        cta="Open Approvals"
        span={4}
        href="/approvals"
        info={"WHAT: everything waiting for someone's decision right now.\n\nHOW: items in Submitted or Pending-admin status across buying plans, purchase orders, discontinue requests, vendor de-boardings and Inward Plan submissions.\n\nUSE: every day these wait adds a day to a delivery or a plan. Approvers see the same list under Approvals."}
      >
        {!ap ? (
          <NoData text="Approval queues are not available." />
        ) : (
          <ul className="ana-list">
            <li><span>Purchase orders</span><span className="ana-list-val">{fmt.format(ap.pos)}</span></li>
            <li><span>Buying plans</span><span className="ana-list-val">{fmt.format(ap.buyingPlans)}</span></li>
            <li><span>Inward Plan</span><span className="ana-list-val">{fmt.format(ap.inward)}</span></li>
            <li><span>Discontinue</span><span className="ana-list-val">{fmt.format(ap.discontinue)}</span></li>
            <li><span>Vendor de-boarding</span><span className="ana-list-val">{fmt.format(ap.deboarding)}</span></li>
          </ul>
        )}
      </AnaCard>

      <AnaCard
        title="ISR — inward to sales"
        icon={Scale}
        tone={!isr ? "neutral" : isrPct != null && isrPct < 100 ? "red" : "green"}
        status={isrPct == null ? "WAITING" : `ISR ${isrPct}%`}
        cta="Open the OOS Dashboard"
        span={4}
        onClick={() => router.push("/doq-dashboard")}
        info={"WHAT: ISR — the inward-to-sales ratio: are we receiving as many pieces as we sell.\n\nHOW: pieces received (GRN) ÷ pieces sold, over the same four complete weeks the DOQ windows cover, × 100. Example: 9,000 received, 12,000 sold → 75%.\n\nUSE: under 100% for weeks means stock is being drawn down faster than it is replaced — stock-outs follow. Over 100% means stock is building."}
      >
        {!isr ? (
          <NoData text="Sales windows or GRN are not available." />
        ) : (
          <>
            <div className="ana-metric-row">
              <div>
                <strong className="ana-value ana-value-xl">{isrPct == null ? "—" : `${isrPct}%`}</strong>
                <span className="ana-value-label">received ÷ sold</span>
              </div>
            </div>
            <ul className="ana-list">
              <li><span>Inward (received)</span><span className="ana-list-val">{fmt.format(isr.inwardQty)} pcs · {fmt.format(isr.inwardPos)} POs</span></li>
              <li><span>Sold</span><span className="ana-list-val">{fmt.format(isr.soldQty)} pcs · {fmt.format(isr.skus)} SKUs</span></li>
              <li><span>Window</span><span className="ana-list-val">{isr.from} → {isr.to}</span></li>
            </ul>
          </>
        )}
      </AnaCard>
    </div>
  );
}
