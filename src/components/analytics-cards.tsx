"use client";

/**
 * Cross-tab decision cards for the main Dashboard tab. The cards are grouped
 * by leadership decision instead of presented as ten equally weighted KPIs:
 * protect the business, allocate smarter, and stay on plan.
 */

import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Award,
  Ban,
  CheckCheck,
  CircleAlert,
  Database,
  Factory,
  IndianRupee,
  PackageX,
  RefreshCw,
  Repeat,
  Scale,
  Target,
  TrendingUp,
  Truck,
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
  istToday,
} from "@/lib/business-logic";
import type { DashboardData } from "@/lib/types";
import type { AnalyticsExtras } from "@/lib/forms/types";
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

function quantile(sortedAsc: number[], q: number): number {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.floor(q * sortedAsc.length)),
  );
  return sortedAsc[idx];
}

type Tone = "red" | "amber" | "green" | "neutral";

const decisionTabs = [
  {
    id: "protect",
    number: "01",
    label: "Key updates",
    description:
      "Review cash, availability, cost, and master-data updates in one place.",
  },
  {
    id: "allocate",
    number: "02",
    label: "Vendor planning",
    description:
      "Compare demand, vendor capacity, concentration, and recent delivery performance.",
  },
  {
    id: "execution",
    number: "03",
    label: "Plan progress",
    description:
      "Track buying-plan realization, TNA progress, and PO closure compliance.",
  },
  {
    id: "workspace",
    number: "04",
    label: "Workspace pulse",
    description:
      "Read the workspace views at a glance — replenishment pressure, stock-outs, vendor picks and the inward pipeline.",
  },
  {
    id: "datahealth",
    number: "05",
    label: "Data & sync",
    description:
      "Watch the static datasets behind every number — product-master mix and how fresh each synced feed is.",
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
  isAdmin = false,
}: {
  data: DashboardData;
  rules: Record<string, number>;
  extras?: AnalyticsExtras | null;
  onTab: (id: TabId) => void;
  /** /replenishment is admin-only; non-admins get Urgent Replenishment instead. */
  isAdmin?: boolean;
}) {
  const today = istToday();
  const [decisionTab, setDecisionTab] = useState<DecisionTab>("protect");
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
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const tnaDataPresent = data.tnaRecords.length > 0;
  const values = tracker
    .map((row) => row.pendingValue)
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  const valueThreshold = quantile(values, rules.capital_risk_quantile ?? 0.75);
  const atRisk = tracker
    .filter((row) => row.highRisk && row.pendingValue >= valueThreshold)
    .sort((a, b) => b.pendingValue - a.pendingValue);
  const capitalAtRisk = atRisk.reduce((sum, row) => sum + row.pendingValue, 0);
  const quantilePct = Math.round(
    (1 - (rules.capital_risk_quantile ?? 0.75)) * 100,
  );

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

  const withCapacity = rollups.filter((row) => row.capacityPerMonth > 0);
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
  const gapsByClass = gaps
    ? (["A", "B", "C", "D"] as const).map((c) => ({
        cls: c,
        n: gaps.filter((g) => g.abc_class === c).length,
      }))
    : null;
  const exportStockoutCsv = () => {
    if (!gaps?.length) return;
    downloadCsv(
      "stockout-risk-variants.csv",
      ["product_variant", "product_code", "product_name", "current_stock", "doq_45", "abc_class"],
      gaps.map((g) => [
        g.product_variant,
        g.product_code ?? "",
        g.product_name ?? "",
        g.current_stock,
        g.doq_45,
        g.abc_class,
      ]),
    );
  };
  const issued = extras?.issuedLastWeek ?? null;
  const pending = extras?.pendingApproval ?? null;
  const inward = extras?.inwardLastWeek ?? null;
  const inwardPct =
    inward && inward.planned > 0 ? Math.round((inward.actual / inward.planned) * 100) : null;
  const repl = extras?.replenishment ?? null;
  const oosSum = extras?.oosSummary ?? null;
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
      <header className="ana-brief">
        <div className="ana-brief-copy">
          <span className="ana-eyebrow">Cross-module insights</span>
          <h2 id="decision-briefing-title">Dashboard overview</h2>
          <p>{activeDecisionTab.description}</p>
        </div>
        <div className="ana-signal-strip" aria-label="Current decision signals">
          <span
            className={`ana-signal ${!tnaDataPresent ? "is-neutral" : atRisk.length ? "is-red" : "is-green"}`}
          >
            <CircleAlert size={13} />
            {!tnaDataPresent
              ? "Capital risk pending"
              : atRisk.length
                ? `${atRisk.length} high-value PO${atRisk.length === 1 ? "" : "s"} at risk`
                : "Capital risk clear"}
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
                ? `${gaps.length === 8 ? "8+" : gaps.length} variants uncovered`
                : "Demand covered"}
          </span>
        </div>
      </header>

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

      <div
        id="ana-decision-panel"
        className="ana-tab-panel"
        role="tabpanel"
        aria-labelledby={`ana-tab-${decisionTab}`}
      >
        {decisionTab === "protect" && (
          <div className="ana-grid ana-tab-grid">
            <AnaCard
              title="Capital at Risk"
              icon={AlertTriangle}
              tone={
                !tnaDataPresent ? "neutral" : atRisk.length ? "red" : "green"
              }
              status={
                !tnaDataPresent
                  ? "WAITING"
                  : atRisk.length
                    ? "ACT NOW"
                    : "CLEAR"
              }
              cta="Review high-risk POs"
              span={7}
              onClick={() => onTab("open-po")}
              info={`Open POs that are both TNA High Risk and in the top ${quantilePct}% by pending value. The quantile is editable in Rules Master.`}
            >
              {!tnaDataPresent ? (
                <NoData text="TNA stage data is not available yet, so capital exposure cannot be assessed." />
              ) : atRisk.length ? (
                <>
                  <div className="ana-metric-row">
                    <div>
                      <strong className="ana-value ana-value-xl">
                        {money.format(capitalAtRisk)}
                      </strong>
                      <span className="ana-value-label">
                        open value exposed
                      </span>
                    </div>
                    <span className="ana-count-chip is-red">
                      {atRisk.length} priority PO
                      {atRisk.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <p className="ana-decision-line">
                    Protect these orders first—the list is ranked by rupee
                    exposure.
                  </p>
                  <ul className="ana-list ana-ranked-list">
                    {atRisk.slice(0, 4).map((row, index) => (
                      <li key={row.key}>
                        <span className="ana-rank">{index + 1}</span>
                        <span className="ana-list-stack">
                          <span className="mono">{row.poRef}</span>
                          <small>{row.vendorName}</small>
                        </span>
                        <span className="ana-list-val">
                          {money.format(row.pendingValue)}
                        </span>
                      </li>
                    ))}
                    {atRisk.length > 4 && (
                      <li className="ana-more">
                        +{atRisk.length - 4} more high-value exceptions
                      </li>
                    )}
                  </ul>
                </>
              ) : (
                <ZeroState
                  title="No high-value TNA exception"
                  text={`None of the top ${quantilePct}% open POs by value is high risk.`}
                />
              )}
            </AnaCard>

            <AnaCard
              title="Stockout Risk · No Coverage"
              icon={PackageX}
              tone={gaps == null ? "neutral" : gaps.length ? "red" : "green"}
              status={
                gaps == null ? "WAITING" : gaps.length ? "ACT NOW" : "COVERED"
              }
              cta="Open urgent replenishment"
              span={5}
              onClick={() => onTab("urgent-replenish")}
              info="Every variant with no sellable stock and no open PO covering it — no demand threshold, so nothing is hidden. Segmented by ABC/D class (A/B = higher velocity) so priority shows without excluding anything. Download the full variant-level list as CSV."
            >
              {gaps == null ? (
                <NoData text="Replenishment data is not available, so uncovered stockouts cannot be checked." />
              ) : gaps.length ? (
                <>
                  <div className="ana-metric-row">
                    <div>
                      <strong className="ana-value ana-value-xl">
                        {fmt.format(gaps.length)}
                      </strong>
                      <span className="ana-value-label">
                        uncovered variants
                      </span>
                    </div>
                    <button
                      type="button"
                      className="ana-csv-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        exportStockoutCsv();
                      }}
                    >
                      Download CSV
                    </button>
                  </div>
                  <div className="ana-abcd-row">
                    {gapsByClass!.map(({ cls, n }) => (
                      <span key={cls} className={`ana-abcd-chip cls-${cls}`}>
                        {cls} · {fmt.format(n)}
                      </span>
                    ))}
                  </div>
                  <ul className="ana-list ana-demand-list">
                    {gaps.slice(0, 5).map((gap, index) => (
                      <li key={gap.product_variant}>
                        <span className="ana-rank">{index + 1}</span>
                        <span className="ana-list-stack">
                          <span>
                            {gap.product_name ??
                              gap.product_code ??
                              gap.product_variant}
                          </span>
                          <small className="mono">{gap.product_variant}</small>
                        </span>
                        <span className="ana-list-val">
                          <span className={`ana-abcd-tag cls-${gap.abc_class}`}>
                            {gap.abc_class}
                          </span>
                          DOQ {fmt.format(gap.doq_45)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {gaps.length > 5 && (
                    <p className="ana-more-note">
                      +{fmt.format(gaps.length - 5)} more — download the CSV for the full list.
                    </p>
                  )}
                </>
              ) : (
                <ZeroState
                  title="No uncovered stockout"
                  text="Every out-of-stock variant has an open PO in flight."
                />
              )}
            </AnaCard>

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
              info="Approved or issued POs this month whose written rate exceeded the approved standard cost, aggregated as margin impact."
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
              info="Products marked Discontinued in Product Master that still have an open PO (or a current buying-plan line) with pending quantity against them — i.e. buying is still happening on a discontinued product. This should always be zero."
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
            </AnaCard>
          </div>
        )}

        {decisionTab === "allocate" && (
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
              info={`Compares open vendor quantity with signed monthly capacity. Under ${rules.utilization_under_pct ?? 70}% has room; above ${rules.utilization_over_pct ?? 100}% is over-committed. Bands are editable in Rules Master.`}
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
                            vendor.openQty - vendor.capacityPerMonth,
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
                                {fmt.format(excess)} pcs above capacity
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
                            vendor.capacityPerMonth - vendor.openQty,
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
              info={`Share of open buying value held by the top 3 vendors, measured within the selected fabric pool (Woven and Knit are managed separately, so they're never blended). The alert line is ${concentrationAlert}% and is editable in Rules Master.`}
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
              info={`Delay rate over the last ${windowDays} days (≈${Math.round(windowDays / 90)} quarters), combining completed POs (final delivered status) and open POs still in flight — per vendor, deduped by PO number. Vendors with fewer than 2 POs in window are excluded; the window is editable in Rules Master. Click a vendor to open the PO tracker.`}
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
          </div>
        )}

        {decisionTab === "execution" && (
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
              info="POs issued to EasyCom this week vs the immediately preceding week — the delta shows whether issuance pace is up or down, not just a flat rolling count."
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
              info="Purchase orders currently submitted and awaiting approval (live count + total quantity)."
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
              title="Inward — last 7 days"
              icon={Scale}
              tone={inward && inwardPct != null && inwardPct >= 80 ? "green" : inward ? "amber" : "neutral"}
              status={inwardPct != null ? `${inwardPct}% RECEIVED` : "WAITING"}
              cta="Open Inward Plan"
              span={4}
              href="/inward-plan"
              info="Planned arrivals due last week (still-open lines) vs quantity actually received (GRN). Approximate — the two are not line-matched."
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
              info="Current-month planned buying value versus issued PO value by weave, with the prior two months for context."
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
              info="Daily share of open POs that are On Track, using the same TNA logic as the tracker. This shows whether execution is improving or degrading, not only today's status."
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
              info={`Share of completed POs closed within the ${closure?.slaDays ?? 15}-day SLA, plus open closures already beyond it. The SLA is editable in Rules Master.`}
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

        {decisionTab === "workspace" && (
          <div className="ana-grid ana-tab-grid">
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
              info="Colour variants the replenishment maths says to order now (ROP-30 above zero), the total pieces they call for, and how many of them are already out of stock."
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
                    <span><small>Already OOS</small><b>{fmt.format(repl.oosVariants)}</b></span>
                  </div>
                </div>
              )}
            </AnaCard>

            <AnaCard
              title="Out of Stock"
              icon={PackageX}
              tone={!oosSum ? "neutral" : oosSum.zeroStock > 0 ? "amber" : "green"}
              status={!oosSum ? "WAITING" : `${fmt.format(oosSum.zeroStock)} SKUS`}
              cta="Open OOS Calculation"
              span={6}
              href="/oos-calculation"
              info={`SKUs in the OOS Calculation sheet with zero current stock.${oosSum?.dataAsOf ? ` Inventory data as of ${oosSum.dataAsOf}.` : ""}`}
            >
              {!oosSum ? (
                <NoData text="OOS Calculation data is not available." />
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
              info="Open (Approved) PO quantity still to arrive: due in the next 7 days, already past its expected date, and lines with no EDD set at all."
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

            <AnaCard
              title="Vendor Recommendation"
              icon={Award}
              tone={!vrec ? "neutral" : vrec.risky.length ? "amber" : "green"}
              status={!vrec ? "WAITING" : `${fmt.format(vrec.rated)} RATED`}
              cta="Open Vendor Recommendation"
              span={5}
              href="/vendor-recommendation"
              info="From completed-PO history (vendors with at least 3 completed POs): the best on-time performers and any vendor whose recent delay rate is 50% or worse."
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

        {decisionTab === "datahealth" && (
          <div className="ana-grid ana-tab-grid">
            <AnaCard
              title="Product Master Mix"
              icon={Database}
              tone="neutral"
              status={stateMix ? `${fmt.format(stateTotal)} CODES` : "WAITING"}
              cta="Open Product Master"
              span={7}
              href="/product-master"
              info="Every product code in the master, counted by its lifecycle state. Watch Discontinued and SKU-Create shares — they should shrink, not grow."
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
              info={`Every synced feed and when it last refreshed. A feed is flagged stale after ${sync?.staleHours ?? 30}h without a refresh (threshold editable in Rules Master).`}
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
            </AnaCard>
          </div>
        )}
      </div>
    </section>
  );
}
