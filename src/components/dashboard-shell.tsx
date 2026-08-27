"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Boxes,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Download,
  FileDown,
  Info,
  LayoutDashboard,
  Lock,
  LogOut,
  PackageSearch,
  Search,
  X,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  LabelList,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  aggregateProductRows,
  buildTrackerRows,
  buildVendorRollups,
  createLookups,
  isDelayedPo,
  isHighRiskLine,
  isOpenPo,
  istToday,
  resolveVendor,
  stageDelay,
} from "@/lib/business-logic";
import { downloadCsv, downloadPdf, type CsvValue } from "@/lib/download";
import type {
  DashboardData,
  PendingPo,
  TrackerRow,
  VendorRollup,
} from "@/lib/types";
import { TnaBreakdown } from "./tna-breakdown";
import { SideNav, tabs, type TabId } from "./side-nav";
import type { SdRole } from "@/lib/forms/types";
import { signOut } from "@/lib/auth-actions";
import { ApprovalsBell } from "@/components/forms/approvals-bell";


type HelpItem = { title: string; text: string; tip?: string };

const simpleGlossary: Record<string, HelpItem[]> = {
  dashboard: [
    { title: "Open POs", text: "Purchase orders that still have pieces left to receive — counted as unique PO references where pending quantity (actual) is above 0. Fully received POs drop off.", tip: "Open quantity = sum of pending pieces; Open value = sum of (pending qty × item price)." },
    { title: "Overdue POs", text: "Open POs whose expected delivery date (EDD) is already in the past (Layer 2 · Overdue). The % on the card is overdue ÷ open POs.", tip: "Click the card to open the overdue audit list." },
    { title: "High-risk POs", text: "A live early-warning flag: an open PO where any critical-path stage (PP Sample → GPT → Cutting → Inline → First Delivery → PO Closer) is past its planned TNA date with no actual date yet. It is a snapshot, not a permanent label — the moment that stage is marked done, even late, the PO stops being High Risk.", tip: "Independent of the final delivery date; click the card to see which POs and stages." },
    { title: "PO ageing", text: "Open POs grouped by how overdue they are: Not Due, 0–7, 8–15, 16–30, 30+ days, or No EDD when no delivery date is set." },
    { title: "Vendor & product charts", text: "Open vs delayed POs per vendor with a delay-% line, plus the top product codes and product·variant pairs by pending quantity and by delay %." },
    { title: "All / Woven / Knitted / Other", text: "Filter every card and chart to a vendor type. A vendor whose type contains 'woven' counts as Woven; one containing 'knit' counts as Knitted; anything else — including blank — is grouped separately as Other." },
  ],
  "open-po": [
    { title: "One row = one open PO", text: "Each row is a purchase order grouped by PO number, product and delivery date. 'Variants' counts the distinct variants (e.g. colours) on that PO — it is not a piece count." },
    { title: "Pending, Delivered & EasyCom", text: "Pending qty/value are what is still to come; Delivered is received ÷ ordered. The EasyCom column is the delivery/closure state (Layer 1): Approved (nothing received), Partially Received, or Closure Pending (≥95% received — functionally done but not yet closed on EasyCom, shown amber). Completed / Approval-Pending POs stay out of this open view." },
    { title: "EDD, Delay & Days Overdue", text: "EDD is the promised delivery date. Delay = today − EDD (0 shows as On time). Days Overdue buckets that delay: Not Due, 0–7, 8–15, 16–30, 30+ days, or No EDD." },
    { title: "Task-list tabs", text: "Filter lenses over this one table (a row can match several): High Risk (any critical-path TNA stage past its planned date, not done — pure TNA), On Time (inverse of High Risk), Overdue (EDD is past — EDD-only), PO Not Closed on EE (received ≥95% but not closed on EasyCom), and Due Today (a TNA stage is planned for today and not done — act now, distinct from already-overdue). The Internal status column still shows the Layer-2 precedence Overdue → High Risk → On Track.", tip: "High Risk is a live snapshot — it clears the moment the overdue stage is marked done." },
    { title: "TNA stage", text: "The earliest production stage not yet completed: PP Sample → GPT → Cutting → Inline / Midline QC → First Delivery → PO Closer. Shows '… Pending', 'Production' when every stage is done, or 'Not in TNA Tracker' when no timeline exists." },
    { title: "Per-stage TNA vs Actual", text: "Each stage shows its planned (TNA) date next to the actual date, plus a per-stage verdict: On Time, 'On Time · N days early', 'Delay N d', or Pending. There is no single lumped total — delay is read stage by stage.", tip: "Scroll right for PP, GPT, Cutting, Inline and PO Closer." },
    { title: "TNA sequence (data-entry check)", text: "Stages are strictly linear. If a later stage is marked done while an earlier one is still blank, it is flagged as a data-entry error with a lock icon, and the earliest still-pending stage is treated as the real status rather than skipping ahead." },
  ],
  vendors: [
    { title: "Active vendors", text: "Vendors marked active in the vendor master, and how many of them currently have no open PO at all." },
    { title: "Capacity & open quantity", text: "Total monthly capacity is the sum of every vendor's signed monthly capacity; Total Open PO Quantity is the sum of their pending pieces." },
    { title: "Open / Delayed / Delay %", text: "Per vendor: distinct open PO references, how many are past EDD, and delayed ÷ open × 100." },
    { title: "Utilisation", text: "How full a vendor is: open quantity ÷ monthly capacity × 100. Above 100% means booked beyond capacity; shows 0 when the master has no capacity for that vendor.", tip: "Vendors are matched by vendor code first, then by name." },
    { title: "Woven, Knitted & Other charts", text: "Open vs delayed quantity for each vendor, split into Woven, Knitted and Other (neither woven nor knitted) groups." },
  ],
  merchants: [
    { title: "Grouped by merchant", text: "Every vendor's figures roll up to the merchant who owns the relationship. The merchant is read from the vendor master first, then the vendor-type sheet." },
    { title: "Merchant totals", text: "Open POs, delayed POs, open quantity and open value are the sums of that merchant's vendors; delay % and utilisation are recomputed on those totals.", tip: "Rows are sorted by open value." },
    { title: "Charts", text: "Open vs delayed PO count per merchant, and open quantity per merchant." },
    { title: "Unassigned", text: "Vendors with no merchant in the source data are grouped together under 'Unassigned'." },
  ],
  products: [
    { title: "Filters first, then totals", text: "Merchant, vendor, vendor code, PO type, product and variant filters are applied to the raw PO lines, then the quantities are added up." },
    { title: "Product + variant rollup", text: "Keeps each variant (e.g. colour) on its own row." },
    { title: "Product code summary", text: "Combines all variants of a product into one row; 'Variants' is the count of distinct variants." },
    { title: "Pending qty & value", text: "Pending qty = sum of pending pieces; Pending value = sum of (pending qty × item price). Both tables sort by quantity." },
  ],
  "urgent-replenish": [
    { title: "In Process (365d)", text: "Open PO stock arriving soon — open lines whose EDD is set and falls between today and today + 365 days." },
    { title: "Out of Stock", text: "Products with 0 pending quantity across their lines: nothing is currently on the way to replenish them." },
    { title: "How to use this page", text: "Start with the out-of-stock products, then check the In Process table to see what stock is already coming and when." },
  ],
  matrix: [
    { title: "How to read the grid", text: "Each row is a product (or product · variant), each column is a vendor, and each cell is the pending quantity that vendor still owes for that product." },
    { title: "By Variant / By Product Code", text: "Switch between one row per colour/variant and one combined row per product code." },
    { title: "Totals", text: "The Total row, Total column and grand total add only the currently-open pending quantities." },
  ],
};

const fmt = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const money = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});
const colors = [
  "#7b4fbf",
  "#c9a882",
  "#4f7c4d",
  "#f0c61e",
  "#3b6fd4",
  "#b54f7a",
];
const today = istToday();
const norm = (value: string | null | undefined) =>
  (value ?? "").trim().toLowerCase();
const unique = (values: string[]) =>
  [...new Set(values.filter(Boolean))].sort();
const metricIcons = {
  purple: LayoutDashboard,
  teal: Boxes,
  blue: CalendarClock,
  orange: Info,
  red: AlertTriangle,
} as const;

function Card({
  label,
  value,
  note,
  tone = "purple",
  big = false,
  onClick,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: string;
  big?: boolean;
  onClick?: () => void;
}) {
  const Icon = metricIcons[tone as keyof typeof metricIcons] ?? LayoutDashboard;
  return (
    <button
      type="button"
      className={`metric-card tone-${tone}${big ? " big" : ""}`}
      onClick={onClick}
      disabled={!onClick}
    >
      <span className="metric-icon">
        <Icon size={17} strokeWidth={1.8} />
      </span>
      <span className="metric-label">{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
      {onClick && <ArrowUpRight className="metric-action" size={15} />}
    </button>
  );
}

function Empty({ text = "No data for this filter" }: { text?: string }) {
  return (
    <div className="empty-state">
      <PackageSearch size={28} />
      <p>{text}</p>
    </div>
  );
}

const PAGE_SIZE = 25;

function usePaged<T>(rows: T[]) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);
  return {
    pageRows: rows.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE),
    page: current,
    setPage,
    pageCount,
    total: rows.length,
  };
}

function Pager({
  page,
  setPage,
  pageCount,
  total,
}: {
  page: number;
  setPage: (n: number) => void;
  pageCount: number;
  total: number;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="pager">
      <button type="button" disabled={page <= 0} onClick={() => setPage(page - 1)}>
        Prev
      </button>
      <span>
        Page {page + 1} of {pageCount} · {fmt.format(total)} rows
      </span>
      <button
        type="button"
        disabled={page >= pageCount - 1}
        onClick={() => setPage(page + 1)}
      >
        Next
      </button>
    </div>
  );
}

// Vertical-scroll wrapper for horizontal bar charts (vendors on the Y axis):
// grows the plot height per vendor and scrolls when it overflows.
function VScrollChart({
  count,
  per = 30,
  min = 300,
  children,
}: {
  count: number;
  per?: number;
  min?: number;
  children: React.ReactElement;
}) {
  return (
    <div className="chart-vscroll">
      <div style={{ width: "100%", height: Math.max(count * per, min) }}>
        <ResponsiveContainer>{children}</ResponsiveContainer>
      </div>
    </div>
  );
}

function DownloadButton({
  filename,
  headers,
  rows,
}: {
  filename: string;
  headers: string[];
  rows: CsvValue[][];
}) {
  return (
    <button
      type="button"
      className="download-button"
      onClick={() => downloadCsv(filename, headers, rows)}
      disabled={!rows.length}
      title={
        rows.length
          ? `Download ${rows.length} rows as CSV`
          : "No data to download"
      }
    >
      <Download size={13} /> CSV
    </button>
  );
}

function PdfButton({
  filename,
  title,
  headers,
  rows,
}: {
  filename: string;
  title: string;
  headers: string[];
  rows: CsvValue[][];
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="download-button"
      disabled={!rows.length || busy}
      title={
        rows.length
          ? `Download ${rows.length} rows as PDF`
          : "No data to download"
      }
      onClick={async () => {
        setBusy(true);
        try {
          await downloadPdf(filename, title, headers, rows);
        } finally {
          setBusy(false);
        }
      }}
    >
      <FileDown size={13} /> {busy ? "PDF…" : "PDF"}
    </button>
  );
}

function ChartCard({
  title,
  children,
  download,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  download?: { filename: string; headers: string[]; rows: CsvValue[][] };
  wide?: boolean;
}) {
  return (
    <section className={`panel chart-panel${wide ? " chart-wide" : ""}`}>
      <div className="panel-title">
        <div>
          <span className="panel-kicker">Live analysis</span>
          <h3>{title}</h3>
        </div>
        {download ? (
          <DownloadButton {...download} />
        ) : (
          <span className="panel-spark">
            <i />
            <i />
            <i />
          </span>
        )}
      </div>
      <div className="chart-area">{children}</div>
    </section>
  );
}

const vendorCsvHeaders = [
  "Vendor name",
  "Vendor code",
  "Bucket",
  "Merchant",
  "Open POs",
  "Delayed POs",
  "Delay %",
  "Open qty",
  "Open value",
  "Machines",
  "Active karigar",
  "Latest karigar",
  "Capacity/mo",
  "Utilization %",
];
const vendorCsvRows = (rows: VendorRollup[]): CsvValue[][] =>
  rows.map((r) => [
    r.vendorName,
    r.vendorCode,
    r.vendorBucket,
    r.merchant,
    r.openPoCount,
    r.delayedPoCount,
    r.delayPct,
    r.openQty,
    Math.round(r.openValue),
    r.totalMachines,
    r.totalActiveKarigar,
    r.karigarLatest,
    r.capacityPerMonth,
    r.utilizationPct,
  ]);

function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className={`modal ${wide ? "modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All</option>
        {options.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
    </label>
  );
}

function DashboardTab({
  data,
  bucket,
  setBucket,
  onHighRisk,
  onOverdue,
}: {
  data: DashboardData;
  bucket: string;
  setBucket: (v: string) => void;
  onHighRisk: (rows: PendingPo[]) => void;
  onOverdue: (rows: PendingPo[]) => void;
}) {
  const lookups = useMemo(
    () => createLookups(data.vendorTypes, data.vendorMasters, data.tnaRecords),
    [data],
  );
  const rows = useMemo(
    () =>
      data.pendingPos.filter(
        (row) =>
          bucket === "All" || resolveVendor(row, lookups).bucket === bucket,
      ),
    [data.pendingPos, bucket, lookups],
  );
  const open = rows.filter(isOpenPo);
  const delayed = open.filter((row) => isDelayedPo(row, today));
  const highRisk = open.filter((row) => isHighRiskLine(row, lookups.tnaByPo, today));
  const openRefs = unique(open.map((row) => row.po_ref_num ?? ""));
  const delayedRefs = unique(delayed.map((row) => row.po_ref_num ?? ""));
  const tracker = buildTrackerRows(
    rows,
    data.vendorTypes,
    data.vendorMasters,
    data.tnaRecords,
    today,
  );
  const vendor = buildVendorRollups(
    rows,
    data.vendorTypes,
    data.vendorMasters,
    data.tnaRecords,
    today,
  );
  const ageing = [
    "Not Due",
    "0-7 Days",
    "8-15 Days",
    "16-30 Days",
    "30+ Days",
    "No EDD",
  ]
    .map((name) => ({
      name,
      value: unique(
        tracker
          .filter((row) => row.delayBucket === name)
          .map((row) => row.poRef),
      ).length,
    }))
    .filter((item) => item.value);
  const products = Object.values(
    tracker.reduce<Record<string, { name: string; qty: number }>>(
      (acc, row) => {
        acc[row.productCode] ??= { name: row.productCode, qty: 0 };
        acc[row.productCode].qty += row.pendingQty;
        return acc;
      },
      {},
    ),
  )
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 15);
  const codeAgg: Record<
    string,
    { name: string; open: Set<string>; delayed: Set<string> }
  > = {};
  tracker.forEach((row) => {
    const c = (codeAgg[row.productCode] ??= {
      name: row.productCode,
      open: new Set(),
      delayed: new Set(),
    });
    c.open.add(row.poRef);
    if (row.delayDays > 0) c.delayed.add(row.poRef);
  });
  const codeDelay = Object.values(codeAgg)
    .map((c) => ({
      name: c.name,
      delayPct: c.open.size
        ? Math.round((c.delayed.size / c.open.size) * 100)
        : 0,
      open: c.open.size,
    }))
    .sort((a, b) => b.open - a.open)
    .slice(0, 15);
  const varAgg: Record<
    string,
    { name: string; open: Set<string>; delayed: Set<string> }
  > = {};
  tracker.forEach((row) =>
    row.skuRows.forEach((sku) => {
      const key = `${row.productCode} · ${sku.product_variant ?? "Unmapped"}`;
      const v = (varAgg[key] ??= {
        name: key,
        open: new Set(),
        delayed: new Set(),
      });
      v.open.add(row.poRef);
      if (row.delayDays > 0) v.delayed.add(row.poRef);
    }),
  );
  const variantRows = Object.values(varAgg).map((v) => ({
    name: v.name,
    openCount: v.open.size,
    delayPct: v.open.size
      ? Math.round((v.delayed.size / v.open.size) * 100)
      : 0,
  }));
  const variantOpen = [...variantRows]
    .sort((a, b) => b.openCount - a.openCount)
    .slice(0, 15);
  const variantDelay = [...variantRows]
    .sort((a, b) => b.delayPct - a.delayPct)
    .slice(0, 15);
  return (
    <>
      <div className="segment">
        <button
          className={bucket === "All" ? "active" : ""}
          onClick={() => setBucket("All")}
        >
          All
        </button>
        <button
          className={bucket === "Woven" ? "active" : ""}
          onClick={() => setBucket("Woven")}
        >
          Woven
        </button>
        <button
          className={bucket === "Knit" ? "active" : ""}
          onClick={() => setBucket("Knit")}
        >
          Knitted
        </button>
        <button
          className={bucket === "Other" ? "active" : ""}
          onClick={() => setBucket("Other")}
        >
          Other
        </button>
      </div>
      <div className="metric-grid dashboard-metrics">
        <Card
          label="Open POs"
          value={fmt.format(openRefs.length)}
          note={`${fmt.format(open.length)} SKU rows`}
        />
        <Card
          label="Open Qty"
          value={fmt.format(open.reduce((s, r) => s + r.pending_qty_actual, 0))}
          tone="teal"
        />
        <Card
          label="Open Value"
          value={money.format(
            open.reduce((s, r) => s + r.pending_qty_actual * r.item_price, 0),
          )}
          tone="blue"
        />
        <Card
          label="Overdue POs"
          value={fmt.format(delayedRefs.length)}
          note={`${openRefs.length ? Math.round((delayedRefs.length / openRefs.length) * 100) : 0}% of open · audit`}
          tone="orange"
          big
          onClick={() => onOverdue(delayed)}
        />
        <Card
          label="High Risk POs"
          value={fmt.format(
            unique(highRisk.map((r) => r.po_ref_num ?? "")).length,
          )}
          note="View details"
          tone="red"
          big
          onClick={() => onHighRisk(highRisk)}
        />
      </div>
      <div className="chart-grid">
        <ChartCard
          title="PO ageing"
          download={{
            filename: "po-ageing",
            headers: ["Ageing bucket", "Open PO count"],
            rows: ageing.map((a) => [a.name, a.value]),
          }}
        >
          {ageing.length ? (
            <ResponsiveContainer>
              <BarChart data={ageing} margin={{ left: -20, bottom: 20 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="name"
                  interval={0}
                  angle={-35}
                  textAnchor="end"
                  height={60}
                />
                <YAxis />
                <Tooltip />
                <Bar dataKey="value" name="Open PO count" radius={[5, 5, 0, 0]}>
                  {ageing.map((_, i) => (
                    <Cell key={i} fill={colors[i % colors.length]} />
                  ))}
                  <LabelList dataKey="value" position="top" />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <Empty />
          )}
        </ChartCard>
        <ChartCard
          title="Vendor PO status and delay percentage"
          wide
          download={{
            filename: "vendor-po-status-and-delay-percentage",
            headers: vendorCsvHeaders,
            rows: vendorCsvRows(vendor),
          }}
        >
          {vendor.length ? (
            <ResponsiveContainer>
              <ComposedChart
                data={vendor}
                margin={{ top: 20, right: 16, left: -8, bottom: 42 }}
              >
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="vendorCode"
                  interval={0}
                  angle={-35}
                  textAnchor="end"
                  height={64}
                />
                <YAxis yAxisId="count" allowDecimals={false} />
                <YAxis
                  yAxisId="percentage"
                  orientation="right"
                  domain={[0, 100]}
                  unit="%"
                />
                <Tooltip
                  formatter={(value, name) => [
                    name === "Delay percentage" ? `${value}%` : value,
                    name,
                  ]}
                />
                <Legend />
                <Bar
                  yAxisId="count"
                  dataKey="openPoCount"
                  name="Open PO count"
                  fill="#8b5cf6"
                  radius={[5, 5, 0, 0]}
                >
                  <LabelList dataKey="openPoCount" position="top" />
                </Bar>
                <Bar
                  yAxisId="count"
                  dataKey="delayedPoCount"
                  name="Delayed PO count"
                  fill="#f97316"
                  radius={[5, 5, 0, 0]}
                >
                  <LabelList dataKey="delayedPoCount" position="top" />
                </Bar>
                <Line
                  yAxisId="percentage"
                  type="monotone"
                  dataKey="delayPct"
                  name="Delay percentage"
                  stroke="#c0392b"
                  strokeWidth={3}
                  dot={{ r: 4, fill: "#c0392b" }}
                  activeDot={{ r: 6 }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          ) : (
            <Empty />
          )}
        </ChartCard>
        <ChartCard
        title="Top product codes by pending quantity"
          download={{
            filename: "top-product-codes",
            headers: ["Product code", "Pending qty"],
            rows: products.map((p) => [p.name, p.qty]),
          }}
        >
          {products.length ? (
            <ResponsiveContainer>
              <BarChart data={products} layout="vertical" margin={{ left: 15 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" />
                <YAxis type="category" dataKey="name" interval={0} width={75} />
                <Tooltip />
                <Bar
                  dataKey="qty"
                  name="Pending quantity"
                  fill="#14b8a6"
                  radius={[0, 5, 5, 0]}
                >
                  <LabelList dataKey="qty" position="right" />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <Empty />
          )}
        </ChartCard>
        <ChartCard
        title="Product code delay percentage"
          download={{
            filename: "product-code-delay-pct",
            headers: ["Product code", "Delay %", "Open POs"],
            rows: codeDelay.map((c) => [c.name, c.delayPct, c.open]),
          }}
        >
          {codeDelay.length ? (
            <ResponsiveContainer>
              <BarChart
                data={codeDelay}
                layout="vertical"
                margin={{ left: 15 }}
              >
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" unit="%" />
                <YAxis type="category" dataKey="name" interval={0} width={75} />
                <Tooltip formatter={(v) => `${v}%`} />
                <Bar
                  dataKey="delayPct"
                  name="Delay %"
                  fill="#ef4444"
                  radius={[0, 5, 5, 0]}
                >
                  <LabelList
                    dataKey="delayPct"
                    position="right"
                    formatter={(v) => `${v}%`}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <Empty />
          )}
        </ChartCard>
        <ChartCard
        title="Product variant · Open PO count"
          download={{
            filename: "product-variant-open-po-count",
            headers: ["Product · variant", "Open PO count"],
            rows: variantOpen.map((v) => [v.name, v.openCount]),
          }}
        >
          {variantOpen.length ? (
            <ResponsiveContainer>
              <BarChart
                data={variantOpen}
                layout="vertical"
                margin={{ left: 15 }}
              >
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" />
                <YAxis type="category" dataKey="name" interval={0} width={140} />
                <Tooltip />
                <Bar
                  dataKey="openCount"
                  name="Open PO count"
                  fill="#8b5cf6"
                  radius={[0, 5, 5, 0]}
                >
                  <LabelList dataKey="openCount" position="right" />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <Empty />
          )}
        </ChartCard>
        <ChartCard
        title="Product variant · Delay percentage"
          download={{
            filename: "product-variant-delay-pct",
            headers: ["Product · variant", "Delay %"],
            rows: variantDelay.map((v) => [v.name, v.delayPct]),
          }}
        >
          {variantDelay.length ? (
            <ResponsiveContainer>
              <BarChart
                data={variantDelay}
                layout="vertical"
                margin={{ left: 15 }}
              >
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" unit="%" />
                <YAxis type="category" dataKey="name" interval={0} width={140} />
                <Tooltip formatter={(v) => `${v}%`} />
                <Bar
                  dataKey="delayPct"
                  name="Delay %"
                  fill="#f59e0b"
                  radius={[0, 5, 5, 0]}
                >
                  <LabelList
                    dataKey="delayPct"
                    position="right"
                    formatter={(v) => `${v}%`}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <Empty />
          )}
        </ChartCard>
      </div>
    </>
  );
}


const internalStatusTone = (s: string) =>
  s === "Overdue" ? "danger" : s === "High Risk" ? "warn" : "success";

const stageDelayText = (planned?: string | null, actual?: string | null) => {
  const { state, days } = stageDelay(planned, actual);
  if (state === "None") return "";
  if (state === "Pending") return "Pending";
  if (state === "Delay") return `Delay ${days}d`;
  return days ? `On Time ${days}d early` : "On Time";
};

// The sourcing task-list tabs - independent filter lenses over the one master table
// (High Risk/On Time/Overdue = Layer 2, PO Not Closed on EE = Layer 1, Due Today = Layer 3).
// A row can match several; each tab is a lens, not a partition.
const TASK_TABS: { label: string; test: (r: TrackerRow) => boolean }[] = [
  { label: "High Risk", test: (r) => r.highRisk },
  { label: "On Time", test: (r) => !r.highRisk },
  { label: "Overdue", test: (r) => r.delayDays > 0 },
  { label: "PO Not Closed on EE", test: (r) => r.easycomStatus === "Closure Pending" },
  { label: "Due Today", test: (r) => r.dueToday },
];

// Open PO Tracker column headers, in order — index drives the freeze-panes feature.
const TRACKER_COLS = [
  "PO number", "PO reference", "Vendor", "Product", "Product variant", "Pending qty",
  "Pending value", "Delivered", "EasyCom", "EDD", "Delay", "Days Overdue",
  "TNA stage", "Internal status", "TNA sequence", "",
];

function TrackerTab({
  data,
  onView,
}: {
  data: DashboardData;
  onView: (row: TrackerRow) => void;
}) {
  const all = useMemo(
    () =>
      buildTrackerRows(
        data.pendingPos,
        data.vendorTypes,
        data.vendorMasters,
        data.tnaRecords,
        today,
        data.stageInspections,
        { includeClosurePending: true },
      ),
    [data],
  );
  const [filters, set] = useState({
    vendor: "",
    vendorCode: "",
    vendorType: "",
    type: "",
    product: "",
    merchant: "",
    bucket: "",
    status: "",
    search: "",
    easycom: "",
  });
  const [expandedRowKey, setExpandedRowKey] = useState<string | null>(null);
  const [missingOnly, setMissingOnly] = useState(false);
  // Freeze panes: double-click a header to freeze every column up to it (sticky);
  // the rest scrolls. -1 = nothing frozen. Left offsets are measured from the headers.
  const headRowRef = useRef<HTMLTableRowElement>(null);
  const [freezeCol, setFreezeCol] = useState(0);
  const [colLefts, setColLefts] = useState<number[]>([]);
  // Base filters (every filter except the two status axes applied just below).
  const passesBase = (row: TrackerRow) =>
    (!filters.vendor || row.vendorName === filters.vendor) &&
    (!filters.vendorCode || row.vendorCode === filters.vendorCode) &&
    (!filters.vendorType || row.vendorBucket === filters.vendorType) &&
    (!filters.type || row.poType === filters.type) &&
    (!filters.product || row.productCode === filters.product) &&
    (!filters.merchant || row.merchant === filters.merchant) &&
    (!filters.easycom || row.easycomStatus === filters.easycom) &&
    (!missingOnly || row.tnaMissing) &&
    (!filters.search ||
      [row.poRef, row.poNumber, row.productCode, row.vendorName].some((v) =>
        norm(v).includes(norm(filters.search)),
      ));
  // Everything except the internal-status axis — that becomes the table tabs below.
  const preStatus = all.filter(
    (row) => passesBase(row) && (!filters.bucket || row.delayBucket === filters.bucket),
  );
  const statusCounts: Record<string, number> = { All: preStatus.length };
  for (const tab of TASK_TABS) {
    statusCounts[tab.label] = preStatus.filter(tab.test).length;
  }
  const activeTab = TASK_TABS.find((t) => t.label === filters.status);
  const rows = activeTab ? preStatus.filter(activeTab.test) : preStatus;
  const missingTnaCount = all.filter((r) => r.tnaMissing).length;
  const paged = usePaged(rows);

  // Measure each header cell's left offset so frozen columns stack correctly,
  // whatever their (content-driven) widths are. Re-measured on page/data/resize.
  useEffect(() => {
    const rowEl = headRowRef.current;
    if (!rowEl) return;
    const measure = () => {
      let acc = 0;
      const lefts = Array.from(rowEl.children).map((c) => {
        const left = acc;
        acc += (c as HTMLElement).getBoundingClientRect().width;
        return left;
      });
      setColLefts((prev) =>
        prev.length === lefts.length && prev.every((v, i) => Math.abs(v - lefts[i]) < 0.5)
          ? prev
          : lefts,
      );
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [freezeCol, paged.page, rows.length]);

  const frozen = (i: number) => freezeCol >= 0 && i <= freezeCol;
  const colClass = (i: number, base?: string) =>
    [base, frozen(i) ? "frz" : "", i === freezeCol ? "frz-edge" : ""]
      .filter(Boolean)
      .join(" ") || undefined;
  const colStyle = (i: number): CSSProperties | undefined =>
    frozen(i) ? { left: colLefts[i] ?? 0 } : undefined;
  const toggleFreeze = (i: number) => setFreezeCol((c) => (c === i ? -1 : i));

  return (
    <>
      <div className="filter-bar">
        <label className="search-field">
          <Search size={16} />
          <input
            placeholder="Search PO, product or vendor"
            value={filters.search}
            onChange={(e) => set({ ...filters, search: e.target.value })}
          />
        </label>
        <FilterSelect
          label="Vendor"
          value={filters.vendor}
          options={unique(all.map((r) => r.vendorName))}
          onChange={(v) => set({ ...filters, vendor: v })}
        />
        <FilterSelect
          label="Vendor Code"
          value={filters.vendorCode}
          options={unique(all.map((r) => r.vendorCode))}
          onChange={(v) => set({ ...filters, vendorCode: v })}
        />
        <FilterSelect
          label="Vendor Type"
          value={filters.vendorType}
          options={["Woven", "Knit", "Other"]}
          onChange={(v) => set({ ...filters, vendorType: v })}
        />
        <FilterSelect
          label="PO type"
          value={filters.type}
          options={unique(all.map((r) => r.poType))}
          onChange={(v) => set({ ...filters, type: v })}
        />
        <FilterSelect
          label="Product"
          value={filters.product}
          options={unique(all.map((r) => r.productCode))}
          onChange={(v) => set({ ...filters, product: v })}
        />
        <FilterSelect
          label="Merchant"
          value={filters.merchant}
          options={unique(all.map((r) => r.merchant))}
          onChange={(v) => set({ ...filters, merchant: v })}
        />
        <FilterSelect
          label="EasyCom"
          value={filters.easycom}
          options={["Approved", "Partially Received", "Closure Pending"]}
          onChange={(v) => set({ ...filters, easycom: v })}
        />
        <FilterSelect
          label="Days Overdue"
          value={filters.bucket}
          options={[
            "Not Due",
            "0-7 Days",
            "8-15 Days",
            "16-30 Days",
            "30+ Days",
            "No EDD",
          ]}
          onChange={(v) => set({ ...filters, bucket: v })}
        />
      </div>
      <div className="segment tracker-status-tabs">
        <button
          className={filters.status === "" ? "active" : ""}
          onClick={() => set({ ...filters, status: "" })}
        >
          All ({fmt.format(statusCounts.All)})
        </button>
        {TASK_TABS.map((tab) => (
          <button
            key={tab.label}
            className={filters.status === tab.label ? "active" : ""}
            onClick={() => set({ ...filters, status: tab.label })}
          >
            {tab.label} ({fmt.format(statusCounts[tab.label] ?? 0)})
          </button>
        ))}
      </div>
      <div className="panel table-panel">
        <div className="table-meta">
          <span>{fmt.format(rows.length)} PO + product + EDD groups</span>
          <button
            type="button"
            className={missingOnly ? "gap-chip active" : "gap-chip"}
            onClick={() => setMissingOnly((v) => !v)}
            title="Show only POs with no TNA stage data ever entered (adoption gaps)"
          >
            <AlertTriangle size={12} /> {fmt.format(missingTnaCount)} missing TNA
          </button>
          <span className="table-meta-actions">
            <small>Click a TNA stage to expand its full breakdown</small>
            <DownloadButton
              filename="open-po-tracker"
              headers={[
                "PO number",
                "PO reference",
                "Vendor",
                "Vendor code",
                "Product",
                "Product variant",
                "Pending qty",
                "Pending value",
                "Received",
                "Ordered",
                "EasyCom status",
                "EDD",
                "Delay days",
                "Days Overdue",
                "TNA stage",
                "Internal status",
                "Due today",
                "TNA sequence",
                "TNA data",
                "PP TNA",
                "PP Actual",
                "PP on-time/delay",
                "GPT TNA",
                "GPT Actual",
                "GPT on-time/delay",
                "Cutting TNA",
                "Cutting actual",
                "Cutting on-time/delay",
                "Inline TNA",
                "Inline actual",
                "Inline on-time/delay",
                "PO Closer TNA",
                "PO Closer actual",
                "PO Closer on-time/delay",
              ]}
              rows={rows.map((row) => [
                row.poNumber,
                row.poRef,
                row.vendorName,
                row.vendorCode,
                row.productCode,
                row.variantName || `${row.variantCount} variants`,
                row.pendingQty,
                Math.round(row.pendingValue),
                row.receivedQty,
                row.orderedQty,
                row.easycomStatus,
                row.edd ?? "No EDD",
                row.delayDays,
                row.delayBucket,
                row.stage,
                row.internalStatus,
                row.dueToday ? "Due today" : "",
                row.sequenceError ? "ERROR - out of order" : "OK",
                row.tnaMissing ? "Missing" : "OK",
                row.tna?.pp_sample_tna_date ?? "",
                row.tna?.pp_sample_actual_date ?? "",
                stageDelayText(row.tna?.pp_sample_tna_date, row.tna?.pp_sample_actual_date),
                row.tna?.gpt_tna_date ?? "",
                row.tna?.gpt_actual_date ?? "",
                stageDelayText(row.tna?.gpt_tna_date, row.tna?.gpt_actual_date),
                row.tna?.cutting_tna_date ?? "",
                row.tna?.cutting_actual_date_first ?? "",
                stageDelayText(row.tna?.cutting_tna_date, row.tna?.cutting_actual_date_first),
                row.tna?.in_line_tna_date ?? "",
                row.tna?.in_line_actual_date ?? "",
                stageDelayText(row.tna?.in_line_tna_date, row.tna?.in_line_actual_date),
                row.tna?.po_closer_tna_date ?? "",
                row.tna?.po_closer_actual_date ?? "",
                stageDelayText(row.tna?.po_closer_tna_date, row.tna?.po_closer_actual_date),
              ])}
            />
          </span>
        </div>
        {rows.length ? (
          <div className="table-scroll wide-table">
            <table className="freeze-table">
              <thead>
                <tr ref={headRowRef}>
                  {TRACKER_COLS.map((label, i) => (
                    <th
                      key={i}
                      className={colClass(i)}
                      style={colStyle(i)}
                      onDoubleClick={() => toggleFreeze(i)}
                      title="Double-click to freeze the columns up to here (double-click again to unfreeze)"
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {paged.pageRows.map((row) => (
                  <Fragment key={row.key}>
                  <tr>
                    <td className={colClass(0, "mono")} style={colStyle(0)}>{row.poNumber || "—"}</td>
                    <td className={colClass(1, "mono")} style={colStyle(1)}>{row.poRef}</td>
                    <td className={colClass(2)} style={colStyle(2)}>
                      {row.vendorName}
                      <small>{row.vendorCode}</small>
                    </td>
                    <td className={colClass(3)} style={colStyle(3)}>{row.productCode}</td>
                    <td className={colClass(4)} style={colStyle(4)}>{row.variantName || `${row.variantCount} variants`}</td>
                    <td className={colClass(5)} style={colStyle(5)}>{fmt.format(row.pendingQty)}</td>
                    <td className={colClass(6)} style={colStyle(6)}>{money.format(row.pendingValue)}</td>
                    <td className={colClass(7)} style={colStyle(7)}>
                      {fmt.format(row.receivedQty)} / {fmt.format(row.orderedQty)}
                    </td>
                    <td className={colClass(8)} style={colStyle(8)}>
                      <span className={`badge ${row.easycomStatus === "Closure Pending" ? "warn" : row.easycomStatus === "Partially Received" ? "info" : "success"}`}>
                        {row.easycomStatus}
                      </span>
                    </td>
                    <td className={colClass(9)} style={colStyle(9)}>{row.edd ?? "No EDD"}</td>
                    <td className={colClass(10)} style={colStyle(10)}>
                      {row.delayDays ? (
                        <span className="badge danger">{row.delayDays}d</span>
                      ) : (
                        <span className="badge success">On time</span>
                      )}
                    </td>
                    <td className={colClass(11)} style={colStyle(11)}>{row.delayBucket}</td>
                    <td className={colClass(12)} style={colStyle(12)}>
                      <button
                        type="button"
                        className="tna-stage-button"
                        onClick={() =>
                          setExpandedRowKey(expandedRowKey === row.key ? null : row.key)
                        }
                        aria-expanded={expandedRowKey === row.key}
                      >
                        {row.sequenceError ? (
                          <span
                            className="badge danger"
                            title="Data-entry error: a later TNA stage is completed while an earlier stage is still pending."
                          >
                            <Lock size={11} /> {row.stage}
                          </span>
                        ) : row.tnaMissing ? (
                          <span className="badge warn" title="No TNA stage data has ever been entered for this PO (adoption gap).">
                            <AlertTriangle size={11} /> TNA not entered
                          </span>
                        ) : (
                          <span className="badge info">{row.stage}</span>
                        )}
                        <ChevronDown
                          size={13}
                          className={expandedRowKey === row.key ? "tna-chevron open" : "tna-chevron"}
                        />
                      </button>
                    </td>
                    <td className={colClass(13)} style={colStyle(13)}>
                      <span className={`badge ${internalStatusTone(row.internalStatus)}`}>
                        {row.internalStatus}
                      </span>
                    </td>
                    <td className={colClass(14)} style={colStyle(14)}>
                      {row.sequenceError ? (
                        <span className="badge danger" title="Later stage completed before an earlier one.">
                          <Lock size={11} /> Error
                        </span>
                      ) : (
                        <span className="badge success">OK</span>
                      )}
                    </td>
                    <td className={colClass(15)} style={colStyle(15)}>
                      <button
                        className="link-button"
                        onClick={() => onView(row)}
                      >
                        View <ChevronRight size={14} />
                      </button>
                    </td>
                  </tr>
                  {expandedRowKey === row.key && (
                    <tr className="tna-expand-row">
                      <td colSpan={16}>
                        <TnaBreakdown row={row} />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty />
        )}
        <Pager
          page={paged.page}
          setPage={paged.setPage}
          pageCount={paged.pageCount}
          total={paged.total}
        />
      </div>
    </>
  );
}

const utilizationBands = ["Over utilised (>100%)", "80–100%", "Under 80%"];
const delayBands = ["With delayed POs", "No delayed POs"];

function VendorTable({
  rows: allRows,
  filename,
  exportTitle = "Vendor performance",
  searchPlaceholder = "Filter by vendor name or code",
  withFilters = false,
}: {
  rows: VendorRollup[];
  filename?: string;
  exportTitle?: string;
  searchPlaceholder?: string;
  withFilters?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [merchant, setMerchant] = useState("");
  const [bucket, setBucket] = useState("");
  const [utilBand, setUtilBand] = useState("");
  const [delayBand, setDelayBand] = useState("");
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allRows.filter((r) => {
      if (
        q &&
        !(r.vendorName ?? "").toLowerCase().includes(q) &&
        !(r.vendorCode ?? "").toLowerCase().includes(q)
      )
        return false;
      if (merchant && r.merchant !== merchant) return false;
      if (bucket && r.vendorBucket !== bucket) return false;
      if (utilBand === utilizationBands[0] && r.utilizationPct <= 100)
        return false;
      if (
        utilBand === utilizationBands[1] &&
        (r.utilizationPct < 80 || r.utilizationPct > 100)
      )
        return false;
      if (utilBand === utilizationBands[2] && r.utilizationPct >= 80)
        return false;
      if (delayBand === delayBands[0] && r.delayedPoCount === 0) return false;
      if (delayBand === delayBands[1] && r.delayedPoCount > 0) return false;
      return true;
    });
  }, [allRows, query, merchant, bucket, utilBand, delayBand]);
  const filtered = rows.length !== allRows.length;
  const filterSummary = [
    query.trim() && `"${query.trim()}"`,
    merchant,
    bucket,
    utilBand,
    delayBand,
  ]
    .filter(Boolean)
    .join(", ");
  const paged = usePaged(rows);
  return (
    <>
      {filename && (
        <div className={`table-meta${withFilters ? " has-filters" : ""}`}>
          <div className="table-meta-filters">
            <label className="search-field table-meta-search">
              <Search size={14} />
              <input
                placeholder={searchPlaceholder}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Clear filter"
                  onClick={() => setQuery("")}
                >
                  <X size={13} />
                </button>
              )}
            </label>
            {withFilters && (
              <>
                <select
                  className="meta-select"
                  value={merchant}
                  onChange={(e) => setMerchant(e.target.value)}
                >
                  <option value="">All merchants</option>
                  {unique(allRows.map((r) => r.merchant)).map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
                <select
                  className="meta-select"
                  value={bucket}
                  onChange={(e) => setBucket(e.target.value)}
                >
                  <option value="">All types</option>
                  {unique(allRows.map((r) => r.vendorBucket)).map((b) => (
                    <option key={b}>{b}</option>
                  ))}
                </select>
                <select
                  className="meta-select"
                  value={utilBand}
                  onChange={(e) => setUtilBand(e.target.value)}
                >
                  <option value="">All utilization</option>
                  {utilizationBands.map((b) => (
                    <option key={b}>{b}</option>
                  ))}
                </select>
                <select
                  className="meta-select"
                  value={delayBand}
                  onChange={(e) => setDelayBand(e.target.value)}
                >
                  <option value="">All delays</option>
                  {delayBands.map((b) => (
                    <option key={b}>{b}</option>
                  ))}
                </select>
              </>
            )}
          </div>
          <div className="table-meta-actions">
            <span>
              {filtered
                ? `${fmt.format(rows.length)} of ${fmt.format(allRows.length)} rows`
                : `${fmt.format(rows.length)} rows`}
            </span>
            <DownloadButton
              filename={filename}
              headers={vendorCsvHeaders}
              rows={vendorCsvRows(rows)}
            />
            <PdfButton
              filename={filename}
              title={
                filterSummary
                  ? `${exportTitle} - filter: ${filterSummary}`
                  : exportTitle
              }
              headers={vendorCsvHeaders}
              rows={vendorCsvRows(rows)}
            />
          </div>
        </div>
      )}
      {rows.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Vendor</th>
                <th>Merchant</th>
                <th>Open POs</th>
                <th>Delayed</th>
                <th>Delay %</th>
                <th>Open qty</th>
                <th>Open value</th>
                <th>Machines</th>
                <th>Active karigar</th>
                <th>Latest karigar</th>
                <th>Capacity/mo</th>
                <th>PO capacity</th>
                <th>Utilization</th>
              </tr>
            </thead>
            <tbody>
              {paged.pageRows.map((row) => (
                <tr key={row.vendorCode || row.vendorName}>
                  <td>
                    {row.vendorName}
                    <small>
                      {row.vendorCode} · {row.vendorBucket}
                    </small>
                  </td>
                  <td>{row.merchant}</td>
                  <td>{row.openPoCount}</td>
                  <td>{row.delayedPoCount}</td>
                  <td>{row.delayPct}%</td>
                  <td>{fmt.format(row.openQty)}</td>
                  <td>{money.format(row.openValue)}</td>
                  <td>{fmt.format(row.totalMachines)}</td>
                  <td>{fmt.format(row.totalActiveKarigar)}</td>
                  <td>{fmt.format(row.karigarLatest)}</td>
                  <td>{fmt.format(row.capacityPerMonth)}</td>
                  <td>{fmt.format(row.poCapacity)}</td>
                  <td>
                    {row.utilizationPct > 100 ? (
                      <span
                        className="badge danger"
                        title={`Booked at ${row.utilizationPct}% of capacity`}
                      >
                        100% · Over utilised
                      </span>
                    ) : (
                      <span className="badge info">{row.utilizationPct}%</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty />
      )}
      <Pager
        page={paged.page}
        setPage={paged.setPage}
        pageCount={paged.pageCount}
        total={paged.total}
      />
    </>
  );
}

function VendorTab({ data }: { data: DashboardData }) {
  const rows = useMemo(() => {
    const capacityByVendor = new Map(
      (data.vendorCapacity ?? []).map((c) => [
        norm(c.vendor_code),
        { machines: Number(c.machines_allocated) || 0, karigar: Number(c.active_karigar) || 0 },
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
  }, [data]);
  const openCodes = new Set(rows.map((row) => norm(row.vendorCode)));
  const zero = data.vendorTypes.filter(
    (v) => norm(v.status) === "active" && !openCodes.has(norm(v.vendor_code)),
  );
  const types = unique(data.pendingPos.map((r) => r.po_type ?? "Unknown"));
  const typeQty = (vendorCode: string, t: string) =>
    data.pendingPos
      .filter(
        (p) =>
          isOpenPo(p) &&
          norm(p.vendor_code) === norm(vendorCode) &&
          (p.po_type ?? "Unknown") === t,
      )
      .reduce((s, p) => s + p.pending_qty_actual, 0);
  return (
    <>
      <div className="metric-grid compact">
        <Card
          label="Active vendors"
          value={fmt.format(
            data.vendorTypes.filter((v) => norm(v.status) === "active").length,
          )}
        />
        <Card
          label="Active with 0 open PO"
          value={fmt.format(zero.length)}
          note={
            zero
              .slice(0, 3)
              .map((v) => v.vendor_code)
              .join(", ") || "None"
          }
          tone="orange"
        />
        <Card
          label="Total monthly capacity"
          value={fmt.format(rows.reduce((s, r) => s + r.capacityPerMonth, 0))}
          tone="teal"
        />
        <Card
          label="Total Open PO Quantity"
          value={fmt.format(rows.reduce((s, r) => s + r.openQty, 0))}
          tone="blue"
        />
      </div>
      <div className="chart-grid">
        <ChartCard
          title="Open quantity vs monthly capacity"
          wide
          download={{
            filename: "vendor-open-qty-vs-capacity",
            headers: vendorCsvHeaders,
            rows: vendorCsvRows(rows),
          }}
        >
          {rows.length ? (
            <ResponsiveContainer>
              <BarChart data={rows} margin={{ left: -20, bottom: 28 }}>
                <XAxis
                  dataKey="vendorCode"
                  interval={0}
                  angle={-35}
                  textAnchor="end"
                  height={50}
                />
                <YAxis />
                <Tooltip />
                <Legend />
                <Bar dataKey="openQty" name="Open quantity" fill="#8b5cf6">
                  <LabelList
                    dataKey="openQty"
                    position="top"
                    angle={-90}
                    offset={14}
                    fontSize={9}
                  />
                </Bar>
                <Bar
                  dataKey="capacityPerMonth"
                  name="Monthly capacity"
                  fill="#14b8a6"
                >
                  <LabelList
                    dataKey="capacityPerMonth"
                    position="top"
                    angle={-90}
                    offset={14}
                    fontSize={9}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <Empty />
          )}
        </ChartCard>
        <ChartCard
          title="Vendor × PO type (open quantity)"
          download={{
            filename: "vendor-by-po-type",
            headers: ["Vendor", ...types],
            rows: rows.map((vendor) => [
              vendor.vendorCode,
              ...types.map((t) => typeQty(vendor.vendorCode, t)),
            ]),
          }}
        >
          <div className="matrix-mini">
            <table>
              <thead>
                <tr>
                  <th>Vendor</th>
                  {types.map((t) => (
                    <th key={t}>{t}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((vendor) => (
                  <tr key={vendor.vendorCode}>
                    <td>{vendor.vendorCode}</td>
                    {types.map((t) => (
                      <td key={t}>
                        {fmt.format(typeQty(vendor.vendorCode, t))}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ChartCard>
      </div>
      <VendorTypeCharts data={data} />
      <section className="panel table-panel">
        <div className="panel-title">
          <h3>Vendor performance</h3>
        </div>
        <VendorTable
          rows={rows}
          filename="vendor-performance"
          exportTitle="Vendor performance"
          searchPlaceholder="Filter by vendor name or code"
          withFilters
        />
      </section>
    </>
  );
}

function VendorTypeCharts({ data }: { data: DashboardData }) {
  const all = useMemo(
    () =>
      buildVendorRollups(
        data.pendingPos,
        data.vendorTypes,
        data.vendorMasters,
        data.tnaRecords,
        today,
      ),
    [data],
  );
  const allTracker = useMemo(
    () =>
      buildTrackerRows(
        data.pendingPos,
        data.vendorTypes,
        data.vendorMasters,
        data.tnaRecords,
        today,
      ),
    [data],
  );
  return (
    <div className="split-columns">
      {(["Woven", "Knit", "Other"] as const).map((bucket) => {
        const rows = all.filter((r) => r.vendorBucket === bucket);
        const trackerRows = allTracker.filter((r) => r.vendorBucket === bucket);
        const openVsDelayed = trackerRows.reduce<
          Record<
            string,
            { vendor: string; openQty: number; delayedQty: number }
          >
        >((acc, row) => {
          const key = row.vendorCode || row.vendorName;
          if (!acc[key]) acc[key] = { vendor: key, openQty: 0, delayedQty: 0 };
          acc[key].openQty += row.pendingQty;
          if (row.delayDays > 0) acc[key].delayedQty += row.pendingQty;
          return acc;
        }, {});
        const chartData = Object.values(openVsDelayed);
        return (
          <section className="panel" key={bucket}>
            <div className="panel-title">
              <h3>{bucket === "Knit" ? "Knitted" : bucket} vendors</h3>
              <span className="table-meta-actions">
                <span>{rows.length} with open POs</span>
                <DownloadButton
                  filename={
                    bucket === "Knit"
                      ? "knitted-vendors"
                      : bucket === "Other"
                        ? "other-vendors"
                        : "woven-vendors"
                  }
                  headers={vendorCsvHeaders}
                  rows={vendorCsvRows(rows)}
                />
              </span>
            </div>
            <div className="chart-area tall">
              {chartData.length ? (
                <VScrollChart count={chartData.length}>
                  <BarChart
                    data={chartData}
                    layout="vertical"
                    margin={{ left: 50 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                    <XAxis type="number" />
                    <YAxis
                      type="category"
                      dataKey="vendor"
                      interval={0}
                      width={72}
                    />
                    <Tooltip />
                    <Legend />
                    <Bar
                      dataKey="openQty"
                      name="Open quantity"
                      fill={
                        bucket === "Woven"
                          ? "#8b5cf6"
                          : bucket === "Knit"
                            ? "#14b8a6"
                            : "#64748b"
                      }
                    >
                      <LabelList dataKey="openQty" position="right" />
                    </Bar>
                    <Bar
                      dataKey="delayedQty"
                      name="Delayed quantity"
                      fill="#f97316"
                    >
                      <LabelList dataKey="delayedQty" position="right" />
                    </Bar>
                  </BarChart>
                </VScrollChart>
              ) : (
                <Empty />
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
function MerchantTab({ data }: { data: DashboardData }) {
  const vendors = useMemo(
    () =>
      buildVendorRollups(
        data.pendingPos,
        data.vendorTypes,
        data.vendorMasters,
        data.tnaRecords,
        today,
      ),
    [data],
  );
  const rows = Object.values(
    vendors.reduce<Record<string, VendorRollup>>((acc, row) => {
      const current = acc[row.merchant] ?? {
        ...row,
        vendorCode: row.merchant,
        vendorName: row.merchant,
        openPoCount: 0,
        delayedPoCount: 0,
        delayPct: 0,
        openQty: 0,
        openValue: 0,
        totalMachines: 0,
        totalActiveKarigar: 0,
        karigarLatest: 0,
        capacityPerMonth: 0,
        utilizationPct: 0,
      };
      current.openPoCount += row.openPoCount;
      current.delayedPoCount += row.delayedPoCount;
      current.openQty += row.openQty;
      current.openValue += row.openValue;
      current.capacityPerMonth += row.capacityPerMonth;
      current.totalMachines += row.totalMachines;
      current.totalActiveKarigar += row.totalActiveKarigar;
      current.karigarLatest += row.karigarLatest;
      acc[row.merchant] = current;
      return acc;
    }, {}),
  )
    .map((row) => ({
      ...row,
      delayPct: row.openPoCount
        ? Math.round((row.delayedPoCount / row.openPoCount) * 100)
        : 0,
      utilizationPct: row.capacityPerMonth
        ? Math.round((row.openQty / row.capacityPerMonth) * 100)
        : 0,
    }))
    .sort((a, b) => b.openValue - a.openValue);
  return (
    <>
      <div className="chart-grid">
        <ChartCard
          title="Open vs delayed by merchant"
          download={{
            filename: "merchant-open-vs-delayed",
            headers: vendorCsvHeaders,
            rows: vendorCsvRows(rows),
          }}
        >
          {rows.length ? (
            <ResponsiveContainer>
              <BarChart data={rows}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="merchant"
                  interval={0}
                  angle={-35}
                  textAnchor="end"
                  height={55}
                />
                <YAxis />
                <Tooltip />
                <Legend />
                <Bar dataKey="openPoCount" name="Open PO count" fill="#8b5cf6">
                  <LabelList dataKey="openPoCount" position="top" />
                </Bar>
                <Bar
                  dataKey="delayedPoCount"
                  name="Delayed PO count"
                  fill="#f97316"
                >
                  <LabelList dataKey="delayedPoCount" position="top" />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <Empty />
          )}
        </ChartCard>
        <ChartCard
          title="Merchant open qty"
          download={{
            filename: "merchant-open-qty",
            headers: vendorCsvHeaders,
            rows: vendorCsvRows(rows),
          }}
        >
          {rows.length ? (
            <ResponsiveContainer>
              <BarChart data={rows}>
                <XAxis
                  dataKey="merchant"
                  interval={0}
                  angle={-35}
                  textAnchor="end"
                  height={55}
                />
                <YAxis />
                <Tooltip />
                <Bar dataKey="openQty" name="Open quantity" fill="#14b8a6">
                  <LabelList dataKey="openQty" position="top" />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <Empty />
          )}
        </ChartCard>
      </div>
      <section className="panel table-panel">
        <div className="panel-title">
          <h3>Merchant performance</h3>
        </div>
        <VendorTable
          rows={rows}
          filename="merchant-performance"
          exportTitle="Merchant performance"
          searchPlaceholder="Filter by merchant name"
        />
      </section>
    </>
  );
}

function ProductTab({ data }: { data: DashboardData }) {
  const lookups = useMemo(
    () => createLookups(data.vendorTypes, data.vendorMasters, data.tnaRecords),
    [data],
  );
  const [filters, set] = useState({
    merchant: "",
    vendor: "",
    vendorCode: "",
    type: "",
    variant: "",
    product: "",
    search: "",
  });
  const filteredSource = data.pendingPos.filter((row) => {
    const resolved = resolveVendor(row, lookups);
    return (
      isOpenPo(row) &&
      (!filters.merchant || resolved.merchant === filters.merchant) &&
      (!filters.vendor || row.vendor_name === filters.vendor) &&
      (!filters.vendorCode || row.vendor_code === filters.vendorCode) &&
      (!filters.type || row.po_type === filters.type) &&
      (!filters.product || row.product_code === filters.product) &&
      (!filters.variant || row.product_variant === filters.variant) &&
      (!filters.search ||
        [row.product_code, row.product_variant, row.sku].some((v) =>
          norm(v).includes(norm(filters.search)),
        ))
    );
  });
  const tracker = buildTrackerRows(
    filteredSource,
    data.vendorTypes,
    data.vendorMasters,
    data.tnaRecords,
    today,
  );
  const products = aggregateProductRows(tracker);
  const summary = Object.values(
    products.reduce<
      Record<
        string,
        {
          productCode: string;
          variants: Set<string>;
          qty: number;
          value: number;
        }
      >
    >((acc, row) => {
      acc[row.productCode] ??= {
        productCode: row.productCode,
        variants: new Set(),
        qty: 0,
        value: 0,
      };
      acc[row.productCode].variants.add(row.variant);
      acc[row.productCode].qty += row.qty;
      acc[row.productCode].value += row.value;
      return acc;
    }, {}),
  ).sort((a, b) => b.qty - a.qty);
  const merchants = unique(
    data.pendingPos.map((row) => resolveVendor(row, lookups).merchant),
  );
  const allVariants = unique(
    data.pendingPos
      .filter((p) => p.product_variant)
      .map((r) => r.product_variant ?? ""),
  );
  const allProducts = unique(
    data.pendingPos
      .filter((p) => p.product_code)
      .map((r) => r.product_code ?? ""),
  );
  const pagedProducts = usePaged(products);
  const pagedSummary = usePaged(summary);
  return (
    <>
      <div className="filter-bar">
        <label className="search-field">
          <Search size={16} />
          <input
            placeholder="Search product, variant or SKU"
            value={filters.search}
            onChange={(e) => set({ ...filters, search: e.target.value })}
          />
        </label>
        <FilterSelect
          label="Merchant"
          value={filters.merchant}
          options={merchants}
          onChange={(v) => set({ ...filters, merchant: v })}
        />
        <FilterSelect
          label="Vendor"
          value={filters.vendor}
          options={unique(data.pendingPos.map((r) => r.vendor_name ?? ""))}
          onChange={(v) => set({ ...filters, vendor: v })}
        />
        <FilterSelect
          label="Vendor Code"
          value={filters.vendorCode}
          options={unique(data.pendingPos.map((r) => r.vendor_code ?? ""))}
          onChange={(v) => set({ ...filters, vendorCode: v })}
        />
        <FilterSelect
          label="PO type"
          value={filters.type}
          options={unique(data.pendingPos.map((r) => r.po_type ?? ""))}
          onChange={(v) => set({ ...filters, type: v })}
        />
        <FilterSelect
          label="Product"
          value={filters.product}
          options={allProducts}
          onChange={(v) => set({ ...filters, product: v })}
        />
        <FilterSelect
          label="Variant"
          value={filters.variant}
          options={allVariants}
          onChange={(v) => set({ ...filters, variant: v })}
        />
      </div>
      <section className="panel table-panel product-table">
        <div className="panel-title">
          <h3>Product + variant rollup</h3>
          <span className="table-meta-actions">
            <span>{products.length} rows</span>
            <DownloadButton
              filename="product-variant-rollup"
              headers={[
                "Product code",
                "Variant",
                "Pending qty",
                "Pending value",
              ]}
              rows={products.map((row) => [
                row.productCode,
                row.variant,
                row.qty,
                Math.round(row.value),
              ])}
            />
          </span>
        </div>
        {products.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Product code</th>
                  <th>Variant</th>
                  <th>Pending qty</th>
                  <th>Pending value</th>
                </tr>
              </thead>
              <tbody>
                {pagedProducts.pageRows.map((row) => (
                  <tr key={`${row.productCode}-${row.variant}`}>
                    <td>{row.productCode}</td>
                    <td>{row.variant}</td>
                    <td>{fmt.format(row.qty)}</td>
                    <td>{money.format(row.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty />
        )}
        <Pager
          page={pagedProducts.page}
          setPage={pagedProducts.setPage}
          pageCount={pagedProducts.pageCount}
          total={pagedProducts.total}
        />
      </section>
      <section className="panel table-panel">
        <div className="panel-title">
          <h3>Product code summary</h3>
          <DownloadButton
            filename="product-code-summary"
            headers={[
              "Product code",
              "Variants",
              "Pending qty",
              "Pending value",
            ]}
            rows={summary.map((row) => [
              row.productCode,
              row.variants.size,
              row.qty,
              Math.round(row.value),
            ])}
          />
        </div>
        {summary.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Product code</th>
                  <th>Variants</th>
                  <th>Pending qty</th>
                  <th>Pending value</th>
                </tr>
              </thead>
              <tbody>
                {pagedSummary.pageRows.map((row) => (
                  <tr key={row.productCode}>
                    <td>{row.productCode}</td>
                    <td>{row.variants.size}</td>
                    <td>{fmt.format(row.qty)}</td>
                    <td>{money.format(row.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty />
        )}
        <Pager
          page={pagedSummary.page}
          setPage={pagedSummary.setPage}
          pageCount={pagedSummary.pageCount}
          total={pagedSummary.total}
        />
      </section>
    </>
  );
}

function UrgentReplenishmentTab({ data }: { data: DashboardData }) {
  const tracker = useMemo(
    () =>
      buildTrackerRows(
        data.pendingPos,
        data.vendorTypes,
        data.vendorMasters,
        data.tnaRecords,
        today,
      ),
    [data],
  );
  const inProcess365 = tracker.filter((row) => {
    if (!row.edd) return false;
    const eddDate = new Date(row.edd);
    const daysUntilEdd = Math.floor(
      (eddDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
    );
    return daysUntilEdd <= 365 && daysUntilEdd >= 0;
  });
  const productOOS = Object.values(
    data.pendingPos
      .filter((p) => p.pending_qty_actual === 0)
      .reduce<
        Record<
          string,
          { productCode: string; count: number; lastVendor: string }
        >
      >((acc, row) => {
        const key = row.product_code || "Unmapped";
        if (!acc[key])
          acc[key] = { productCode: key, count: 0, lastVendor: "" };
        acc[key].count += 1;
        acc[key].lastVendor = row.vendor_name || "Unknown";
        return acc;
      }, {}),
  ).slice(0, 20);

  const inProcessData = inProcess365.slice(0, 15).map((row) => ({
    productCode: row.productCode,
    vendor: row.vendorCode || row.vendorName,
    qty: row.pendingQty,
    edd: row.edd,
    delayDays: row.delayDays,
  }));
  const pagedInProcess = usePaged(inProcess365);

  return (
    <>
      <div className="metric-grid compact summary">
        <Card
          label="In Process (365d)"
          value={fmt.format(inProcess365.length)}
          note="Expected within 365 days"
          tone="teal"
          big
        />
        <Card
          label="Out of Stock"
          value={fmt.format(productOOS.length)}
          note="0 pending quantity"
          tone="orange"
          big
        />
      </div>
      <div className="chart-grid">
        <ChartCard
          title="In Process - Top products by pending quantity"
          download={{
            filename: "in-process-365",
            headers: ["Product", "Vendor", "Qty", "EDD", "Delay days"],
            rows: inProcessData.map((row) => [
              row.productCode,
              row.vendor,
              row.qty,
              row.edd ?? "No EDD",
              row.delayDays,
            ]),
          }}
        >
          {inProcessData.length ? (
            <ResponsiveContainer>
              <BarChart
                data={inProcessData}
                layout="vertical"
                margin={{ left: 100 }}
              >
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" />
                <YAxis
                  type="category"
                  dataKey="productCode"
                  interval={0}
                  width={100}
                />
                <Tooltip />
                <Bar
                  dataKey="qty"
                  name="Pending quantity"
                  fill="#39bfa7"
                  radius={[0, 5, 5, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <Empty text="No products expected within 365 days" />
          )}
        </ChartCard>
        <ChartCard
          title="Out of Stock products by occurrence count"
          download={{
            filename: "out-of-stock",
            headers: ["Product code", "Count", "Last vendor"],
            rows: productOOS.map((row) => [
              row.productCode,
              row.count,
              row.lastVendor,
            ]),
          }}
        >
          {productOOS.length ? (
            <ResponsiveContainer>
              <BarChart
                data={productOOS}
                layout="vertical"
                margin={{ left: 100 }}
              >
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" />
                <YAxis
                  type="category"
                  dataKey="productCode"
                  interval={0}
                  width={100}
                />
                <Tooltip />
                <Bar
                  dataKey="count"
                  name="Out-of-stock count"
                  fill="#ef6a7a"
                  radius={[0, 5, 5, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <Empty text="No out of stock products" />
          )}
        </ChartCard>
      </div>
      <section className="panel table-panel">
        <div className="panel-title">
          <h3>In Process inventory (365 days)</h3>
        </div>
        {inProcess365.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Vendor</th>
                  <th>PO</th>
                  <th>Qty</th>
                  <th>EDD</th>
                  <th>Delay days</th>
                </tr>
              </thead>
              <tbody>
                {pagedInProcess.pageRows.map((row, i) => (
                  <tr key={i}>
                    <td>{row.productCode}</td>
                    <td>{row.vendorCode || row.vendorName}</td>
                    <td className="mono">{row.poRef}</td>
                    <td>{fmt.format(row.pendingQty)}</td>
                    <td>{row.edd ?? "No EDD"}</td>
                    <td>
                      {row.delayDays ? (
                        <span className="badge danger">{row.delayDays}d</span>
                      ) : (
                        <span className="badge success">On time</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty text="No products in process within 365 days" />
        )}
        <Pager
          page={pagedInProcess.page}
          setPage={pagedInProcess.setPage}
          pageCount={pagedInProcess.pageCount}
          total={pagedInProcess.total}
        />
      </section>
    </>
  );
}

function MatrixTab({ data }: { data: DashboardData }) {
  const [mode, setMode] = useState<"variant" | "product">("variant");
  const [filters, set] = useState({
    product: "",
    vendor: "",
    vendorCode: "",
    search: "",
  });
  const tracker = useMemo(
    () =>
      buildTrackerRows(
        data.pendingPos,
        data.vendorTypes,
        data.vendorMasters,
        data.tnaRecords,
        today,
      ),
    [data],
  );
  const filteredTracker = tracker.filter(
    (row) =>
      (!filters.product || row.productCode === filters.product) &&
      (!filters.vendor ||
        row.vendorCode === filters.vendor ||
        row.vendorName === filters.vendor) &&
      (!filters.vendorCode || row.vendorCode === filters.vendorCode) &&
      (!filters.search ||
        [row.productCode, row.vendorCode, row.vendorName].some((v) =>
          norm(v).includes(norm(filters.search)),
        )),
  );
  const vendors = unique(
    filteredTracker.map((r) => r.vendorCode || r.vendorName),
  );
  const cells = new Map<string, number>();
  const SEP = "|@|";
  filteredTracker.forEach((row) =>
    row.skuRows.forEach((sku) => {
      const r =
        mode === "variant"
          ? `${row.productCode} · ${sku.product_variant ?? "Unmapped"}`
          : row.productCode;
      const k = `${r}${SEP}${row.vendorCode || row.vendorName}`;
      cells.set(k, (cells.get(k) ?? 0) + sku.pending_qty_actual);
    }),
  );
  const rowNames = unique([...cells.keys()].map((k) => k.split(SEP)[0]));
  const matrixRows: CsvValue[][] = [
    ...rowNames.map((r) => [
      r,
      ...vendors.map((v) => cells.get(`${r}${SEP}${v}`) ?? 0),
      vendors.reduce((s, v) => s + (cells.get(`${r}${SEP}${v}`) ?? 0), 0),
    ]),
    [
      "Total",
      ...vendors.map((v) =>
        rowNames.reduce((s, r) => s + (cells.get(`${r}${SEP}${v}`) ?? 0), 0),
      ),
      [...cells.values()].reduce((s, v) => s + v, 0),
    ],
  ];
  const allProducts = unique(tracker.map((r) => r.productCode));
  const allVendorNames = unique(tracker.map((r) => r.vendorName));
  const allVendorCodes = unique(tracker.map((r) => r.vendorCode));
  const pagedRowNames = usePaged(rowNames);
  return (
    <>
      <div className="segment">
        <button
          className={mode === "variant" ? "active" : ""}
          onClick={() => setMode("variant")}
        >
          By Variant
        </button>
        <button
          className={mode === "product" ? "active" : ""}
          onClick={() => setMode("product")}
        >
          By Product Code
        </button>
      </div>
      <div className="filter-bar">
        <label className="search-field">
          <Search size={16} />
          <input
            placeholder="Search product or vendor"
            value={filters.search}
            onChange={(e) => set({ ...filters, search: e.target.value })}
          />
        </label>
        <FilterSelect
          label="Product"
          value={filters.product}
          options={allProducts}
          onChange={(v) => set({ ...filters, product: v })}
        />
        <FilterSelect
          label="Vendor"
          value={filters.vendor}
          options={allVendorNames}
          onChange={(v) => set({ ...filters, vendor: v })}
        />
        <FilterSelect
          label="Vendor Code"
          value={filters.vendorCode}
          options={allVendorCodes}
          onChange={(v) => set({ ...filters, vendorCode: v })}
        />
      </div>
      <section className="panel table-panel">
        <div className="table-meta">
          <span>
            {fmt.format(rowNames.length)}{" "}
            {mode === "variant" ? "product · variant" : "product"} rows ×{" "}
            {vendors.length} vendors
          </span>
          <DownloadButton
            filename={
              mode === "variant" ? "matrix-by-variant" : "matrix-by-product"
            }
            headers={[
              mode === "variant" ? "Product · variant" : "Product code",
              ...vendors,
              "Total",
            ]}
            rows={matrixRows}
          />
        </div>
        <div className="table-scroll matrix-table">
          {rowNames.length ? (
            <table>
              <thead>
                <tr>
                  <th>
                    {mode === "variant" ? "Product · variant" : "Product code"}
                  </th>
                  {vendors.map((v) => (
                    <th key={v}>{v}</th>
                  ))}
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {pagedRowNames.pageRows.map((r) => (
                  <tr key={r}>
                    <td>{r}</td>
                    {vendors.map((v) => (
                      <td key={v}>
                        {fmt.format(cells.get(`${r}${SEP}${v}`) ?? 0)}
                      </td>
                    ))}
                    <td>
                      <strong>
                        {fmt.format(
                          vendors.reduce(
                            (s, v) => s + (cells.get(`${r}${SEP}${v}`) ?? 0),
                            0,
                          ),
                        )}
                      </strong>
                    </td>
                  </tr>
                ))}
                <tr>
                  <td>
                    <strong>Total</strong>
                  </td>
                  {vendors.map((v) => (
                    <td key={v}>
                      <strong>
                        {fmt.format(
                          rowNames.reduce(
                            (s, r) => s + (cells.get(`${r}${SEP}${v}`) ?? 0),
                            0,
                          ),
                        )}
                      </strong>
                    </td>
                  ))}
                  <td>
                    <strong>
                      {fmt.format(
                        [...cells.values()].reduce((s, v) => s + v, 0),
                      )}
                    </strong>
                  </td>
                </tr>
              </tbody>
            </table>
          ) : (
            <Empty />
          )}
        </div>
        <Pager
          page={pagedRowNames.page}
          setPage={pagedRowNames.setPage}
          pageCount={pagedRowNames.pageCount}
          total={pagedRowNames.total}
        />
      </section>
    </>
  );
}
export function DashboardShell({
  data,
  userEmail,
  role = 'viewer',
}: {
  data: DashboardData;
  userEmail: string | null;
  role?: SdRole;
}) {
  const [tab, setTab] = useState<TabId>("dashboard");
  const [info, setInfo] = useState(false);
  const [detail, setDetail] = useState<TrackerRow | null>(null);
  const [highRisk, setHighRisk] = useState<PendingPo[] | null>(null);
  const [overdue, setOverdue] = useState<PendingPo[] | null>(null);
  const [bucket, setBucket] = useState("All");
  // Let /?tab=<id> deep-link a specific tab (used by the sidebar on other pages).
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("tab");
    if (requested && tabs.some(([id]) => id === requested)) {
      const timer = window.setTimeout(() => setTab(requested as TabId), 0);
      return () => window.clearTimeout(timer);
    }
  }, []);
  const current = tabs.find(([id]) => id === tab)!;
  const helpItems: HelpItem[] = simpleGlossary[tab] ?? [];
  return (
    <div className="app-shell">
      <SideNav activeTab={tab} onTab={setTab} userEmail={userEmail} role={role} />
      <main>
        <header>
          <div>
            <p>Sourcing dashboard</p>
            <h1>{current[1]}</h1>
          </div>
          <div className="header-actions">
            <button className="help-button" onClick={() => setInfo(true)}>
              <CircleHelp size={17} /> What do these mean?
            </button>
            {role === 'admin' && <ApprovalsBell />}
            {userEmail && (
              <div className="account">
                <span className="account-email" title={userEmail}>
                  {userEmail}
                </span>
                <form action={signOut}>
                  <button type="submit" className="account-signout">
                    <LogOut size={15} /> Sign out
                  </button>
                </form>
              </div>
            )}
          </div>
        </header>
        {data.warnings.map((warning) => (
          <div className="notice" key={warning}>
            <Info size={16} />
            {warning}
          </div>
        ))}
        <div className="content">
          {tab === "dashboard" && (
            <DashboardTab
              data={data}
              bucket={bucket}
              setBucket={setBucket}
              onHighRisk={setHighRisk}
              onOverdue={setOverdue}
            />
          )}{" "}
          {tab === "open-po" && <TrackerTab data={data} onView={setDetail} />}{" "}
          {tab === "vendors" && <VendorTab data={data} />}{" "}
          {tab === "merchants" && <MerchantTab data={data} />}{" "}
          {tab === "products" && <ProductTab data={data} />}{" "}
          {tab === "urgent-replenish" && <UrgentReplenishmentTab data={data} />}{" "}
          {tab === "matrix" && <MatrixTab data={data} />}
        </div>
      </main>
      {info && (
        <Modal title={`About ${current[1]}`} onClose={() => setInfo(false)} wide>
          <div className="help-intro">
            <span className="help-intro-icon"><CircleHelp size={20} /></span>
            <div>
              <strong>A quick guide to this page</strong>
              <p>Here is what the main numbers and sections mean.</p>
            </div>
          </div>
          <div className="definition-grid">
            {helpItems.map((item, index) => (
              <article className="definition-card" key={item.title}>
                <span className="definition-number">{index + 1}</span>
                <div>
                  <h3>{item.title}</h3>
                  <p>{item.text}</p>
                  {item.tip && <small>{item.tip}</small>}
                </div>
              </article>
            ))}
          </div>
        </Modal>
      )}
      {detail && (
        <Modal title={detail.poRef} onClose={() => setDetail(null)} wide>
          <div className="detail-summary">
            <span>{detail.vendorName}</span>
            <span>{detail.productCode}</span>
            <span>{fmt.format(detail.pendingQty)} pending</span>
            <span>{detail.stage}</span>
          </div>
          <div className="table-meta">
            <span>{fmt.format(detail.skuRows.length)} SKU rows</span>
            <DownloadButton
              filename={`po-${detail.poRef}-skus`}
              headers={[
                "SKU",
                "Variant",
                "Size",
                "Original",
                "Pending actual",
                "Price",
              ]}
              rows={detail.skuRows.map((row) => [
                row.sku,
                row.product_variant,
                row.size,
                row.original_quantity,
                row.pending_qty_actual,
                row.item_price,
              ])}
            />
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Variant</th>
                  <th>Size</th>
                  <th>Original</th>
                  <th>Pending actual</th>
                  <th>Price</th>
                </tr>
              </thead>
              <tbody>
                {detail.skuRows.map((row, i) => (
                  <tr key={row.source_row_key ?? i}>
                    <td>{row.sku}</td>
                    <td>{row.product_variant}</td>
                    <td>{row.size}</td>
                    <td>{fmt.format(row.original_quantity)}</td>
                    <td>{fmt.format(row.pending_qty_actual)}</td>
                    <td>{money.format(row.item_price)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}
      {highRisk && (
        <Modal title="High risk POs" onClose={() => setHighRisk(null)} wide>
          {highRisk.length ? (
            <>
              <div className="table-meta">
                <span>{fmt.format(highRisk.length)} SKU rows</span>
                <DownloadButton
                  filename="high-risk-pos"
                  headers={[
                    "PO",
                    "Vendor",
                    "SKU",
                    "EDD",
                    "Original",
                    "Pending",
                  ]}
                  rows={highRisk.map((row) => [
                    row.po_ref_num,
                    row.vendor_name,
                    row.sku,
                    row.expected_delivery_date,
                    row.original_quantity,
                    row.pending_qty_actual,
                  ])}
                />
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>PO</th>
                      <th>Vendor</th>
                      <th>SKU</th>
                      <th>EDD</th>
                      <th>Original</th>
                      <th>Pending</th>
                    </tr>
                  </thead>
                  <tbody>
                    {highRisk.slice(0, 500).map((row, i) => (
                      <tr key={row.source_row_key ?? i}>
                        <td>{row.po_ref_num}</td>
                        <td>{row.vendor_name}</td>
                        <td>{row.sku}</td>
                        <td>{row.expected_delivery_date}</td>
                        <td>{fmt.format(row.original_quantity)}</td>
                        <td>{fmt.format(row.pending_qty_actual)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <Empty />
          )}
        </Modal>
      )}
      {overdue && (
        <Modal
          title="Overdue POs — audit (close date passed)"
          onClose={() => setOverdue(null)}
          wide
        >
          {overdue.length ? (
            <>
              <div className="table-meta">
                <span>{fmt.format(overdue.length)} SKU rows</span>
                <DownloadButton
                  filename="overdue-audit"
                  headers={[
                    "PO",
                    "Vendor",
                    "SKU",
                    "EDD",
                    "Original",
                    "Pending",
                  ]}
                  rows={overdue.map((row) => [
                    row.po_ref_num,
                    row.vendor_name,
                    row.sku,
                    row.expected_delivery_date,
                    row.original_quantity,
                    row.pending_qty_actual,
                  ])}
                />
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>PO</th>
                      <th>Vendor</th>
                      <th>SKU</th>
                      <th>EDD</th>
                      <th>Original</th>
                      <th>Pending</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overdue.slice(0, 500).map((row, i) => (
                      <tr key={row.source_row_key ?? i}>
                        <td>{row.po_ref_num}</td>
                        <td>{row.vendor_name}</td>
                        <td>{row.sku}</td>
                        <td>{row.expected_delivery_date}</td>
                        <td>{fmt.format(row.original_quantity)}</td>
                        <td>{fmt.format(row.pending_qty_actual)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <Empty />
          )}
        </Modal>
      )}
    </div>
  );
}
