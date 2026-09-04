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
  IndianRupee,
  Info,
  LayoutDashboard,
  Lock,
  LogOut,
  PackageSearch,
  Search,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  LabelList,
  Legend,
  Line,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import {
  TNA_STAGES,
  aggregateProductRows,
  buildTrackerRows,
  buildVendorRollups,
  createLookups,
  isDelayedPo,
  isHighRiskLine,
  isOpenPo,
  istToday,
  parseIsoDate,
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
import { InfoDot } from "./info-dot";
import { SideNav, tabs, type TabId } from "./side-nav";
import { AnalyticsCards } from "./analytics-cards";
import { canView } from "@/lib/views";
import type { AnalyticsExtras, PoClosureView, SdRole } from "@/lib/forms/types";
import { signOut } from "@/lib/auth-actions";
import { ApprovalsBell } from "@/components/forms/approvals-bell";


type HelpItem = { title: string; text: string; tip?: string };

const simpleGlossary: Record<string, HelpItem[]> = {
  dashboard: [
    { title: "Open POs", text: "Purchase orders that still have pieces left to receive — counted as unique PO references where pending quantity (actual) is above 0. Fully received POs drop off.", tip: "Open quantity = sum of pending pieces; Open value = sum of (pending qty × item price)." },
    { title: "Overdue POs", text: "Open POs whose expected delivery date (EDD) is already in the past (Layer 2 · Overdue). The % on the card is overdue ÷ open POs.", tip: "Click the card to open the overdue audit list." },
    { title: "High-risk POs", text: "A live early-warning flag: an open PO where any critical-path stage (PP Sample → GPT → Cutting → Inline → First Delivery → PO Closer) is past its planned TNA date with no actual date yet. It is a snapshot, not a permanent label — the moment that stage is marked done, even late, the PO stops being High Risk.", tip: "Independent of the final delivery date; click the card to see which POs and stages." },
    { title: "Deliveries due (±30 days)", text: "Pending quantity summed into weekly buckets by expected delivery date, 30 days back and 30 days ahead, split by vendor type. Weeks left of the This-week line are overdue backlog; right of it is the upcoming delivery load." },
    { title: "Production pipeline", text: "Every open PO placed at its current TNA stage — the earliest stage without an actual date. The centre number is the count of live (open) POs.", tip: "'No TNA' means the PO has no TNA timeline at all — an adoption gap, not a production state." },
    { title: "PO ageing", text: "Open POs grouped by how overdue they are: Not Due, 0–7, 8–15, 16–30, 30+ days, or No EDD when no delivery date is set. Colours run from safe green to worst-case dark red." },
    { title: "Open-PO checkpoints", text: "Distinct open POs at each operational checkpoint (due today, closure pending, missing TNA, sequence errors), plus TNA coverage (share of open POs with a timeline) and quantity delivered (received ÷ ordered)." },
    { title: "Stage turnaround", text: "For each production stage, the average days late among POs that completed that stage after its planned TNA date. Green ≤3d, amber ≤7d, red >7d." },
    { title: "Variants on order", text: "Top product · variant pairs by open PO count; the badge is the share of that variant's POs already past EDD." },
    { title: "Vendor & product charts", text: "Open vs delayed POs per vendor with a delay-% line, plus the top product codes and product·variant pairs by pending quantity and by delay %." },
    { title: "All / Woven / Knitted / Other", text: "Filter every card and chart by weave. Weave comes from the product master (per product code): each PO counts as Woven or Knitted by its product; a code the master doesn't cover falls back to the vendor's type, and anything still unresolved is grouped as Other." },
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
    { title: "Woven, Knitted & Other charts", text: "Open vs delayed quantity for each vendor, split into Woven, Knitted and Other by each PO's product weave (from the product master). A vendor supplying both weaves appears under each, with its quantity split accordingly." },
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
const today = istToday();
const norm = (value: string | null | undefined) =>
  (value ?? "").trim().toLowerCase();
// Stable colour per product code (hashed hue) — the EDD scatter's colour
// dimension, so the same code is always the same colour without a huge legend.
const productColor = (code: string) => {
  let h = 0;
  for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) % 360;
  return `hsl(${h}, 60%, 50%)`;
};
const eddTick = (ms: number) =>
  new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const unique = (values: string[]) =>
  [...new Set(values.filter(Boolean))].sort();
const metricIcons: Record<string, LucideIcon> = {
  purple: LayoutDashboard,
  teal: Boxes,
  blue: CalendarClock,
  amber: Boxes,
  orange: Info,
  red: AlertTriangle,
};

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return reduced;
}

// Count a formatted metric string up from zero — "₹70,19,989", "1,96,051", "12.5%".
// Falls back to static text for reduced-motion or non-single-number values
// (e.g. ranges like "465 / 500"), and preserves the ₹/%/prefix + Indian grouping.
function CountUp({ text }: { text: string }) {
  const reduced = useReducedMotion();
  const m = /^(\D*)([\d,]+(?:\.\d+)?)(\D*)$/.exec(text.trim());
  const target = m ? parseFloat(m[2].replace(/,/g, "")) : NaN;
  const decimals = m && m[2].includes(".") ? m[2].split(".")[1].length : 0;
  const [display, setDisplay] = useState<number | null>(m && !Number.isNaN(target) ? 0 : null);

  useEffect(() => {
    if (!m || Number.isNaN(target)) return;
    if (reduced) { setDisplay(target); return; }
    let raf = 0;
    let start = 0;
    const dur = 700;
    const tick = (t: number) => {
      if (!start) start = t;
      const p = Math.min(1, (t - start) / dur);
      setDisplay(target * (1 - Math.pow(1 - p, 3))); // easeOutCubic
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, reduced]);

  if (!m || Number.isNaN(target) || display === null) return <>{text}</>;
  const formatted = display.toLocaleString("en-IN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return <>{m[1]}{formatted}{m[3]}</>;
}

// DAM-style KPI card: colored top border + head row (icon · label · ⓘ), big
// count-up number, muted note. A <div>, not a <button>, so the InfoDot's own
// button can nest legally; clickable cards get role/tabIndex instead.
function Card({
  label,
  value,
  note,
  tone = "purple",
  big = false,
  icon,
  info,
  onClick,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: string;
  big?: boolean;
  icon?: LucideIcon;
  info?: string;
  onClick?: () => void;
}) {
  const Icon = icon ?? metricIcons[tone] ?? LayoutDashboard;
  return (
    <div
      className={`metric-card tone-${tone}${big ? " big" : ""}${onClick ? " clickable" : ""}`}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      <span className="metric-head">
        <span className="metric-head-left">
          <span className="metric-icon">
            <Icon size={13} strokeWidth={2} />
          </span>
          <span className="metric-label">{label}</span>
        </span>
        {info && <InfoDot text={info} label={`About ${label}`} />}
      </span>
      <strong><CountUp text={value} /></strong>
      {note && <small>{note}</small>}
      {onClick && <ArrowUpRight className="metric-action" size={15} />}
    </div>
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
  kicker = "Live analysis",
  info,
  children,
  download,
  wide = false,
  footer,
  actions,
}: {
  title: string;
  kicker?: string;
  info?: string;
  children: React.ReactNode;
  download?: { filename: string; headers: string[]; rows: CsvValue[][] };
  wide?: boolean;
  footer?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <section className={`panel chart-panel${wide ? " chart-wide" : ""}`}>
      <div className="panel-title">
        <div>
          <span className="panel-kicker">{kicker}</span>
          <h3>
            {title}
            {info && <InfoDot text={info} label={`About ${title}`} />}
          </h3>
        </div>
        <span className="panel-actions">
          {actions}
          {download && <DownloadButton {...download} />}
        </span>
      </div>
      <div className="chart-area">{children}</div>
      {footer}
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
  onVendorSelect,
  expectedVsActual = null,
}: {
  data: DashboardData;
  bucket: string;
  setBucket: (v: string) => void;
  onHighRisk: (rows: PendingPo[]) => void;
  onOverdue: (rows: PendingPo[]) => void;
  onVendorSelect?: (vendorCode: string) => void;
  expectedVsActual?: AnalyticsExtras["expectedVsActual"];
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
  const dayMs = 86_400_000;
  // EDD scatter (item 2): one point per open PO line with an EDD, X = EDD date,
  // Y = vendor, coloured by product code, sized by pending qty — so what's
  // arriving (and what's overdue, left of the This-week line) reads at a glance.
  const eddScatter = tracker
    .map((row) => {
      const edd = row.edd ? parseIsoDate(row.edd) : null;
      return edd
        ? {
            x: edd.getTime(),
            vendor: row.vendorName || "Unknown",
            z: Math.max(1, row.pendingQty),
            productCode: row.productCode || "Unmapped",
            poRef: row.poRef,
            edd: row.edd as string,
          }
        : null;
    })
    .filter(
      (p): p is NonNullable<typeof p> =>
        p != null && p.x >= today.getTime() - 45 * dayMs && p.x <= today.getTime() + 90 * dayMs,
    );
  const hasEddScatter = eddScatter.length > 0;
  // Item 3 — expected vs actual delivery volume by week, with the gap between the
  // two shaded (base = the lower line, band = |expected−actual| stacked on top).
  const eva = (expectedVsActual ?? []).map((d) => ({
    week: eddTick(new Date(`${d.week}T00:00:00Z`).getTime()),
    expected: d.expected,
    actual: d.actual,
    base: Math.min(d.expected, d.actual),
    band: Math.abs(d.expected - d.actual),
  }));
  const hasEva = eva.some((d) => d.expected || d.actual);
  // Production pipeline donut: distinct open POs at each TNA stage.
  const stageMeta: [stage: string, label: string, color: string][] = [
    ["Not in TNA Tracker", "No TNA", "#c9c2ae"],
    ["PP Sample Pending", "PP Sample", "#c9a882"],
    ["GPT Pending", "GPT", "#7b4fbf"],
    ["Cutting Pending", "Cutting", "#e68950"],
    ["Inline / Midline QC Pending", "Inline QC", "#3b6fd4"],
    ["First Delivery Pending", "First Delivery", "#d9b113"],
    ["PO Closer Pending", "PO Closer", "#b54f7a"],
    ["Production", "Production", "#3d9e6b"],
  ];
  const stageRefs = new Map<string, Set<string>>();
  tracker.forEach((row) => {
    if (!stageRefs.has(row.stage)) stageRefs.set(row.stage, new Set());
    stageRefs.get(row.stage)!.add(row.poRef);
  });
  const pipeline = stageMeta
    .map(([stage, name, color]) => ({
      name,
      color,
      value: stageRefs.get(stage)?.size ?? 0,
    }))
    .filter((s) => s.value);
  const pipelineTotal = pipeline.reduce((s, p) => s + p.value, 0);
  // Per-stage turnaround: among POs that completed a stage late, avg days late.
  const tnaByPoRef = new Map<string, NonNullable<TrackerRow["tna"]>>();
  tracker.forEach((row) => {
    if (row.tna) tnaByPoRef.set(row.poRef, row.tna);
  });
  const stageTat = TNA_STAGES.map((s) => {
    let done = 0;
    let late = 0;
    let lateDays = 0;
    tnaByPoRef.forEach((tna) => {
      const d = stageDelay(tna[s.tnaField], tna[s.actualField]);
      if (d.state === "Delay") {
        done += 1;
        late += 1;
        lateDays += d.days;
      } else if (d.state === "On Time") {
        done += 1;
      }
    });
    return {
      name: s.name === "Inline / Midline QC" ? "Inline QC" : s.name,
      avg: late ? Number((lateDays / late).toFixed(1)) : 0,
      late,
      done,
    };
  });
  const tatColor = (avg: number) =>
    avg <= 3 ? "#4f7c4d" : avg <= 7 ? "#d9a514" : "#c0392b";
  // Execution health: distinct-PO checkpoint counters + progress coverage.
  const distinct = (test: (r: TrackerRow) => boolean) =>
    unique(tracker.filter(test).map((r) => r.poRef)).length;
  const withTna = distinct((r) => !r.tnaMissing);
  const coveragePct = openRefs.length
    ? Math.round((withTna / openRefs.length) * 100)
    : 0;
  const orderedTotal = tracker.reduce((s, r) => s + r.orderedQty, 0);
  const deliveredPct = orderedTotal
    ? Math.round(
        (tracker.reduce((s, r) => s + r.receivedQty, 0) / orderedTotal) * 100,
      )
    : 0;
  const health = [
    { label: "Due Today", value: distinct((r) => r.dueToday), note: "TNA stage planned today", tone: "amber" },
    { label: "Closure Pending", value: distinct((r) => r.easycomStatus === "Closure Pending"), note: "≥95% received, not closed", tone: "blue" },
    { label: "Missing TNA", value: distinct((r) => r.tnaMissing), note: "no timeline entered", tone: "orange" },
    { label: "Sequence Errors", value: distinct((r) => r.sequenceError), note: "stages done out of order", tone: "red" },
  ];
  // PO ageing: fixed severity-ordered buckets, zeros kept so the scale reads.
  const ageingMeta: [name: string, color: string][] = [
    ["Not Due", "#4f7c4d"],
    ["0-7 Days", "#d9a514"],
    ["8-15 Days", "#e68950"],
    ["16-30 Days", "#c0392b"],
    ["30+ Days", "#7f231a"],
    ["No EDD", "#c9c2ae"],
  ];
  const ageing = ageingMeta.map(([name, color]) => ({
    name,
    color,
    value: unique(
      tracker.filter((row) => row.delayBucket === name).map((row) => row.poRef),
    ).length,
  }));
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
    .slice(0, 10);
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
  // Only codes actually running late — a wall of 0% bars says nothing.
  const codeDelay = Object.values(codeAgg)
    .map((c) => ({
      name: c.name,
      delayPct: c.open.size
        ? Math.round((c.delayed.size / c.open.size) * 100)
        : 0,
      open: c.open.size,
    }))
    .filter((c) => c.delayPct > 0)
    .sort((a, b) => b.delayPct - a.delayPct || b.open - a.open)
    .slice(0, 10);
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
  // One ranked list replaces the two old variant bar charts (their bars were
  // all-equal counts — a chart said nothing a precise list can't say better).
  const variants = Object.values(varAgg)
    .map((v) => ({
      name: v.name,
      openCount: v.open.size,
      delayPct: v.open.size
        ? Math.round((v.delayed.size / v.open.size) * 100)
        : 0,
    }))
    .sort((a, b) => b.openCount - a.openCount || b.delayPct - a.delayPct)
    .slice(0, 12);
  const maxVariantOpen = Math.max(1, ...variants.map((v) => v.openCount));
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
          tone="blue"
          icon={LayoutDashboard}
          info="Unique PO references that still have pending quantity above 0. Fully received POs drop off."
        />
        <Card
          label="Overdue POs"
          value={fmt.format(delayedRefs.length)}
          note={`${openRefs.length ? Math.round((delayedRefs.length / openRefs.length) * 100) : 0}% of open · view audit`}
          tone="red"
          icon={CalendarClock}
          info="Open POs whose expected delivery date is already past. Click to open the audit list."
          onClick={() => onOverdue(delayed)}
        />
        <Card
          label="High Risk POs"
          value={fmt.format(
            unique(highRisk.map((r) => r.po_ref_num ?? "")).length,
          )}
          note="TNA stage slipped · view details"
          tone="orange"
          icon={AlertTriangle}
          info="A critical-path TNA stage is past its planned date with no actual date yet. Clears the moment the stage is marked done."
          onClick={() => onHighRisk(highRisk)}
        />
        <Card
          label="Open Qty"
          value={fmt.format(open.reduce((s, r) => s + r.pending_qty_actual, 0))}
          note="pieces pending"
          tone="amber"
          info="Sum of pending pieces across every open SKU row."
        />
        <Card
          label="Open Value"
          value={money.format(
            open.reduce((s, r) => s + r.pending_qty_actual * r.item_price, 0),
          )}
          note="pending qty × item price"
          tone="teal"
          icon={IndianRupee}
          info="Pending quantity times item price, summed across open SKU rows."
        />
      </div>
      <div className="bento-grid">
        <ChartCard
          title="EDD schedule — by vendor & product"
          kicker="EDD schedule"
          info="One dot per open PO line at its expected delivery date (X), grouped by vendor (Y) and coloured by product code; dot size is pending quantity. Dots left of the dashed This-week line are overdue. Shows the −45 to +90 day window."
          actions={
            <span className="legend-pills">
              <span className="legend-pill" style={{ "--pill-color": "#8a8477" } as CSSProperties}>
                <i /> colour = product code · size = qty
              </span>
            </span>
          }
        >
          {hasEddScatter ? (
            <ResponsiveContainer>
              <ScatterChart margin={{ left: 8, right: 26, top: 14, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  type="number"
                  dataKey="x"
                  domain={["dataMin", "dataMax"]}
                  tickFormatter={eddTick}
                  tickLine={false}
                  fontSize={10}
                />
                <YAxis
                  type="category"
                  dataKey="vendor"
                  width={110}
                  tickLine={false}
                  fontSize={9}
                  interval={0}
                />
                <ZAxis type="number" dataKey="z" range={[30, 340]} />
                <ReferenceLine
                  x={today.getTime()}
                  stroke="#161513"
                  strokeDasharray="4 3"
                  label={{ value: "This week", position: "top", fontSize: 9, fill: "#6e695e" }}
                />
                <Tooltip
                  cursor={{ strokeDasharray: "3 3" }}
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const p = payload[0].payload as {
                      productCode: string; vendor: string; poRef: string; z: number; edd: string;
                    };
                    return (
                      <div
                        style={{
                          background: "#fff",
                          border: "1px solid #e3d6bd",
                          borderRadius: 8,
                          padding: "7px 10px",
                          fontSize: 11,
                          boxShadow: "0 6px 18px rgba(22,21,19,.12)",
                        }}
                      >
                        <strong>{p.productCode}</strong>
                        <div>{p.vendor}</div>
                        <div>PO {p.poRef}</div>
                        <div>{fmt.format(p.z)} pcs · EDD {p.edd}</div>
                      </div>
                    );
                  }}
                />
                <Scatter data={eddScatter} fillOpacity={0.78}>
                  {eddScatter.map((p, i) => (
                    <Cell key={i} fill={productColor(p.productCode)} />
                  ))}
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>
          ) : (
            <Empty text="No EDDs inside the −45 to +90 day window" />
          )}
        </ChartCard>
        <ChartCard
          title="Expected vs actual delivery"
          kicker="Delivery slippage"
          info="Weekly delivery volume from completed POs: Expected = quantity due that week (by EDD), Actual = quantity that actually completed that week. The shaded band is the gap between them — the delivery slippage. Last 12 weeks."
          actions={
            <span className="legend-pills">
              <span className="legend-pill" style={{ "--pill-color": "#3b6fd4" } as CSSProperties}>
                <i /> Expected
              </span>
              <span className="legend-pill" style={{ "--pill-color": "#3d9e6b" } as CSSProperties}>
                <i /> Actual
              </span>
              <span className="legend-pill" style={{ "--pill-color": "#e0a13c" } as CSSProperties}>
                <i /> Gap
              </span>
            </span>
          }
        >
          {hasEva ? (
            <ResponsiveContainer>
              <ComposedChart data={eva} margin={{ left: -8, right: 26, top: 14 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="week" interval="preserveStartEnd" tickLine={false} fontSize={10} />
                <YAxis allowDecimals={false} tickLine={false} fontSize={10} />
                <Tooltip
                  formatter={(value, name) => [
                    fmt.format(Number(value)),
                    name === "band" ? "Gap" : name,
                  ]}
                />
                {/* Shaded gap band: invisible base to the lower line, then the |Δ| on top. */}
                <Area dataKey="base" stackId="band" stroke="none" fill="transparent" isAnimationActive={false} legendType="none" />
                <Area dataKey="band" stackId="band" stroke="none" fill="#e0a13c" fillOpacity={0.28} isAnimationActive={false} name="Gap" />
                <Line type="monotone" dataKey="expected" name="Expected" stroke="#3b6fd4" strokeWidth={2.2} dot={false} />
                <Line type="monotone" dataKey="actual" name="Actual" stroke="#3d9e6b" strokeWidth={2.2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          ) : (
            <Empty text="No completed-PO delivery data in the last 12 weeks" />
          )}
        </ChartCard>
        <section className="panel chart-panel">
          <div className="panel-title">
            <div>
              <span className="panel-kicker">Work in progress</span>
              <h3>
                Production pipeline
                <InfoDot
                  text="Every open PO placed at its current TNA stage — the earliest stage without an actual date. The centre number is the count of live (open) POs."
                  label="About Production pipeline"
                />
              </h3>
            </div>
          </div>
          {pipeline.length ? (
            <div className="donut-wrap">
              <div className="donut-chart">
                <ResponsiveContainer>
                  <PieChart>
                    <Pie
                      data={pipeline}
                      dataKey="value"
                      nameKey="name"
                      innerRadius="68%"
                      outerRadius="94%"
                      paddingAngle={2}
                      cornerRadius={4}
                      strokeWidth={0}
                    >
                      {pipeline.map((s) => (
                        <Cell key={s.name} fill={s.color} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
                <div className="donut-center">
                  <strong><CountUp text={fmt.format(pipelineTotal)} /></strong>
                  <span>Live POs</span>
                </div>
              </div>
              <div className="donut-legend">
                {pipeline.map((s) => (
                  <div className="donut-row" key={s.name}>
                    <i style={{ background: s.color }} />
                    {s.name}
                    <b>{fmt.format(s.value)}</b>
                    <em>{Math.round((s.value / pipelineTotal) * 100)}%</em>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="chart-area">
              <Empty />
            </div>
          )}
        </section>
      </div>
      <div className="bento-grid">
        <ChartCard
          title="PO ageing"
          kicker="Overdue buckets"
          info="Open POs grouped by how far past their EDD they are, ordered from safe (Not Due) to worst (30+ days). No EDD means no delivery date is set at all."
          download={{
            filename: "po-ageing",
            headers: ["Ageing bucket", "Open PO count"],
            rows: ageing.map((a) => [a.name, a.value]),
          }}
          footer={
            <div className="chart-legend">
              {ageing.map((a) => (
                <span className="chart-legend-item" key={a.name}>
                  <i style={{ background: a.color }} />
                  {a.name} <b>{fmt.format(a.value)}</b>
                </span>
              ))}
            </div>
          }
        >
          <ResponsiveContainer>
            <BarChart data={ageing} margin={{ left: -22, top: 16 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="name" interval={0} tickLine={false} />
              <YAxis allowDecimals={false} tickLine={false} />
              <Tooltip />
              <Bar dataKey="value" name="Open POs" barSize={36} radius={[5, 5, 0, 0]}>
                {ageing.map((a) => (
                  <Cell key={a.name} fill={a.color} />
                ))}
                <LabelList dataKey="value" position="top" fontSize={10} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <section className="panel chart-panel">
          <div className="panel-title">
            <div>
              <span className="panel-kicker">Execution health</span>
              <h3>
                Open-PO checkpoints
                <InfoDot
                  text="Distinct open POs at each operational checkpoint, plus how much of the book is covered: TNA coverage = share of open POs with a timeline entered; Qty delivered = pieces received ÷ pieces ordered across open POs."
                  label="About Open-PO checkpoints"
                />
              </h3>
            </div>
          </div>
          <div className="stat-tiles">
            {health.map((h) => (
              <div className={`stat-tile tone-${h.tone}`} key={h.label}>
                <span className="stat-label">{h.label}</span>
                <strong><CountUp text={fmt.format(h.value)} /></strong>
                <small>{h.note}</small>
              </div>
            ))}
          </div>
          <div className="coverage">
            <div className="coverage-row">
              <span>TNA coverage</span>
              <b>{coveragePct}%</b>
            </div>
            <div className="coverage-bar">
              <i style={{ width: `${coveragePct}%` }} />
            </div>
            <div className="coverage-row">
              <span>Qty delivered</span>
              <b>{deliveredPct}%</b>
            </div>
            <div className="coverage-bar teal">
              <i style={{ width: `${deliveredPct}%` }} />
            </div>
          </div>
        </section>
      </div>
      <div className="bento-grid">
        <ChartCard
          title="Stage turnaround — avg days late"
          kicker="TNA discipline"
          info="For each production stage: among POs that completed the stage later than its planned TNA date, the average days late. Green ≤3d, amber ≤7d, red >7d. Pending stages are not counted until an actual date lands."
          download={{
            filename: "stage-turnaround",
            headers: ["Stage", "Avg days late", "Late completions", "Total completions"],
            rows: stageTat.map((s) => [s.name, s.avg, s.late, s.done]),
          }}
          footer={
            <div className="chart-legend">
              <span className="chart-legend-item"><i style={{ background: "#4f7c4d" }} />≤3d avg</span>
              <span className="chart-legend-item"><i style={{ background: "#d9a514" }} />≤7d avg</span>
              <span className="chart-legend-item"><i style={{ background: "#c0392b" }} />&gt;7d avg</span>
            </div>
          }
        >
          <ResponsiveContainer>
            <BarChart data={stageTat} layout="vertical" margin={{ left: 26, right: 38, top: 4 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" unit="d" tickLine={false} />
              <YAxis type="category" dataKey="name" interval={0} width={82} tickLine={false} />
              <Tooltip
                formatter={(v) => [`${v}d average`, "Late by"]}
                labelFormatter={(l) => {
                  const s = stageTat.find((x) => x.name === l);
                  return s ? `${l} · ${s.late} of ${s.done} completions late` : l;
                }}
              />
              <Bar dataKey="avg" name="Avg days late" barSize={9} radius={[0, 5, 5, 0]}>
                {stageTat.map((s) => (
                  <Cell key={s.name} fill={tatColor(s.avg)} />
                ))}
                <LabelList
                  dataKey="avg"
                  position="right"
                  fontSize={10}
                  formatter={(v) => `${v}d`}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard
          title="Delay % by product code"
          kicker="Problem codes"
          info="Product codes with at least one overdue PO, ranked by the share of their open POs that are past EDD. Codes running fully on time are hidden."
          download={{
            filename: "product-code-delay-pct",
            headers: ["Product code", "Delay %", "Open POs"],
            rows: codeDelay.map((c) => [c.name, c.delayPct, c.open]),
          }}
        >
          {codeDelay.length ? (
            <ResponsiveContainer>
              <BarChart data={codeDelay} layout="vertical" margin={{ left: 8, right: 36, top: 4 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" domain={[0, 100]} unit="%" tickLine={false} />
                <YAxis type="category" dataKey="name" interval={0} width={70} tickLine={false} />
                <Tooltip formatter={(v) => `${v}%`} />
                <Bar dataKey="delayPct" name="Delay %" fill="#c0392b" barSize={9} radius={[0, 5, 5, 0]}>
                  <LabelList
                    dataKey="delayPct"
                    position="right"
                    fontSize={10}
                    formatter={(v) => `${v}%`}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <Empty text="No delayed product codes — everything on time" />
          )}
        </ChartCard>
      </div>
      <div className="chart-grid">
        <ChartCard
          title="Vendor PO status and delay percentage"
          info="Per vendor: open PO count, how many are past EDD, and the delay percentage line on the right axis. Click a vendor to open its POs in the tracker."
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
                style={onVendorSelect ? { cursor: "pointer" } : undefined}
                onClick={(state) => {
                  // Recharts hands the clicked category via activeLabel (the X-axis
                  // vendorCode). Jump to the Open PO tracker filtered to that vendor.
                  const code = (state as { activeLabel?: string } | null)?.activeLabel;
                  if (code && onVendorSelect) onVendorSelect(String(code));
                }}
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
                  fill="#7b4fbf"
                  radius={[5, 5, 0, 0]}
                >
                  <LabelList dataKey="openPoCount" position="top" />
                </Bar>
                <Bar
                  yAxisId="count"
                  dataKey="delayedPoCount"
                  name="Delayed PO count"
                  fill="#f0a732"
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
          kicker="Volume ranking"
          info="The 10 product codes with the most pieces still to be delivered across open POs."
          download={{
            filename: "top-product-codes",
            headers: ["Product code", "Pending qty"],
            rows: products.map((p) => [p.name, p.qty]),
          }}
        >
          {products.length ? (
            <ResponsiveContainer>
              <BarChart data={products} layout="vertical" margin={{ left: 8, right: 42, top: 4 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" tickLine={false} />
                <YAxis type="category" dataKey="name" interval={0} width={72} tickLine={false} />
                <Tooltip />
                <Bar
                  dataKey="qty"
                  name="Pending quantity"
                  fill="#3d9e6b"
                  barSize={13}
                  radius={[0, 5, 5, 0]}
                >
                  <LabelList dataKey="qty" position="right" fontSize={10} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <Empty />
          )}
        </ChartCard>
        <section className="panel chart-panel">
          <div className="panel-title">
            <div>
              <span className="panel-kicker">Variant ranking</span>
              <h3>
                Variants on order
                <InfoDot
                  text="Top product · variant pairs by open PO count. The bar shows relative volume; the badge is the share of that variant's POs past EDD (green 0%, amber ≤50%, red >50%)."
                  label="About Variants on order"
                />
              </h3>
            </div>
            <span className="panel-actions">
              <DownloadButton
                filename="variants-on-order"
                headers={["Product · variant", "Open POs", "Delay %"]}
                rows={variants.map((v) => [v.name, v.openCount, v.delayPct])}
              />
            </span>
          </div>
          {variants.length ? (
            <div className="rank-list">
              {variants.map((v) => (
                <div className="rank-row" key={v.name}>
                  <span className="rank-name" title={v.name}>{v.name}</span>
                  <span className="rank-bar">
                    <i style={{ width: `${(v.openCount / maxVariantOpen) * 100}%` }} />
                  </span>
                  <b>{fmt.format(v.openCount)}</b>
                  <span
                    className={`badge ${v.delayPct === 0 ? "success" : v.delayPct <= 50 ? "warn" : "danger"}`}
                  >
                    {v.delayPct}%
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <Empty />
          )}
        </section>
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

/**
 * Pending-closure surface on the Open PO Tracker tab. Completed POs leave the
 * Approved-only tracker feed, so their closure status can't ride on the tracker
 * rows — this panel puts it on the same screen instead (spec §7).
 */
function PendingClosurePanel({ closures }: { closures: PoClosureView[] }) {
  if (!closures.length) return null;
  const breached = closures.filter((c) => c.compliance.rag === "red").length;
  const stage = (c: PoClosureView) =>
    c.compliance.leg === "finance" ? "Finance pending" : c.closure_initiated_at ? "In progress" : "Pending";
  return (
    <details className="wf-closure-panel" open={breached > 0}>
      <summary>
        <span className={`wf-rag wf-rag-${breached ? "red" : "amber"}`} />
        Pending closure — {closures.length} PO{closures.length === 1 ? "" : "s"}
        {breached > 0 && <strong className="wf-closure-breach"> · {breached} breached</strong>}
      </summary>
      <div className="wf-closure-list">
        {closures.slice(0, 12).map((c) => (
          <div key={c.id} className="wf-closure-item">
            <span className={`wf-rag wf-rag-${c.compliance.rag}`} />
            <span className="mono">{c.po_ref_num}</span>
            <span className="wf-subtle">
              {c.compliance.totalDays ?? "—"}d open · {stage(c)}
            </span>
          </div>
        ))}
        <a href="/po-closure" className="wf-btn wf-btn-ghost wf-btn-sm wf-closure-open">
          Open PO Closure →
        </a>
      </div>
    </details>
  );
}

function TrackerTab({
  data,
  closures = [],
  onView,
  initialVendorCode = "",
}: {
  data: DashboardData;
  closures?: PoClosureView[];
  onView: (row: TrackerRow) => void;
  /** Item 6 — seed the vendor filter when arrived-at from a vendor-chart click. */
  initialVendorCode?: string;
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
    vendorCode: initialVendorCode,
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
      <PendingClosurePanel closures={closures} />
      <div className="metric-grid compact">
        <Card
          label="Open PO lines"
          value={fmt.format(all.length)}
          info="Open purchase-order lines in the tracker (Approved, not yet completed)."
        />
        <Card
          label="Delayed lines"
          value={fmt.format(all.filter((r) => r.delayDays > 0).length)}
          tone="orange"
          info="Open lines already past their expected delivery date."
        />
        <Card
          label="Missing TNA"
          value={fmt.format(missingTnaCount)}
          tone="red"
          info="Open lines with no TNA timeline entered at all — an adoption gap, not a production state."
        />
        <Card
          label="Open quantity"
          value={fmt.format(all.reduce((s, r) => s + r.pendingQty, 0))}
          tone="teal"
          info="Total pending pieces across all open PO lines."
        />
      </div>
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

  // Capacity-load donut: vendors bucketed by open-qty ÷ modelled monthly capacity.
  const totalCap = rows.reduce((s, r) => s + r.capacityPerMonth, 0);
  const totalOpen = rows.reduce((s, r) => s + r.openQty, 0);
  const overallUtil = totalCap ? Math.round((totalOpen / totalCap) * 100) : 0;
  const utilBands = (() => {
    let over = 0, near = 0, under = 0, noData = 0;
    for (const r of rows) {
      if (!r.capacityPerMonth) { noData++; continue; }
      const ratio = r.openQty / r.capacityPerMonth;
      if (ratio > 1) over++;
      else if (ratio >= 0.7) near++;
      else under++;
    }
    return [
      { name: "Over capacity", value: over, color: "#c0392b" },
      { name: "Near capacity", value: near, color: "#d9a514" },
      { name: "Under capacity", value: under, color: "#4f7c4d" },
      { name: "No capacity data", value: noData, color: "#9a9384" },
    ].filter((b) => b.value > 0);
  })();
  const utilTotal = utilBands.reduce((s, b) => s + b.value, 0);

  return (
    <>
      <div className="metric-grid compact">
        <Card
          label="Active vendors"
          value={fmt.format(
            data.vendorTypes.filter((v) => norm(v.status) === "active").length,
          )}
          info="Vendors marked active in the Vendor Type master."
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
          info="Active vendors with no open purchase order right now — idle capacity worth chasing."
        />
        <Card
          label="Total monthly capacity"
          value={fmt.format(totalCap)}
          tone="teal"
          info="Sum of each vendor's modelled monthly production capacity."
        />
        <Card
          label="Total open PO quantity"
          value={fmt.format(totalOpen)}
          tone="blue"
          info="Total pending pieces across all open POs."
        />
      </div>
      <div className="bento-grid">
        <ChartCard
          title="Open quantity vs monthly capacity"
          info="Per vendor: total open-PO pieces vs modelled monthly capacity. A vendor whose open quantity tops its capacity is over-committed."
          download={{
            filename: "vendor-open-qty-vs-capacity",
            headers: vendorCsvHeaders,
            rows: vendorCsvRows(rows),
          }}
          footer={
            <div className="chart-legend">
              <span className="chart-legend-item"><i style={{ background: "#7b4fbf" }} />Open quantity</span>
              <span className="chart-legend-item"><i style={{ background: "#3d9e6b" }} />Monthly capacity</span>
            </div>
          }
        >
          {rows.length ? (
            <ResponsiveContainer>
              <BarChart data={rows} margin={{ left: -14, bottom: 30, top: 8 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="vendorCode"
                  interval={0}
                  angle={-35}
                  textAnchor="end"
                  height={56}
                  tickLine={false}
                  fontSize={9}
                />
                <YAxis tickLine={false} />
                <Tooltip />
                <Bar dataKey="openQty" name="Open quantity" fill="#7b4fbf" radius={[4, 4, 0, 0]} />
                <Bar dataKey="capacityPerMonth" name="Monthly capacity" fill="#3d9e6b" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <Empty />
          )}
        </ChartCard>
        <section className="panel chart-panel">
          <div className="panel-title">
            <div>
              <span className="panel-kicker">Capacity load</span>
              <h3>
                Capacity utilisation
                <InfoDot
                  text="Vendors split by load: Over (open qty above capacity), Near (70–100%), Under (below 70%), or no capacity data on file. Centre shows total vendors; the bar is book-wide open qty ÷ capacity."
                  label="About Capacity utilisation"
                />
              </h3>
            </div>
          </div>
          {utilTotal ? (
            <div className="donut-wrap">
              <div className="donut-chart">
                <ResponsiveContainer>
                  <PieChart>
                    <Pie
                      data={utilBands}
                      dataKey="value"
                      nameKey="name"
                      innerRadius="68%"
                      outerRadius="94%"
                      paddingAngle={2}
                      cornerRadius={4}
                      strokeWidth={0}
                    >
                      {utilBands.map((b) => (
                        <Cell key={b.name} fill={b.color} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
                <div className="donut-center">
                  <strong><CountUp text={fmt.format(utilTotal)} /></strong>
                  <span>Vendors</span>
                </div>
              </div>
              <div className="donut-legend">
                {utilBands.map((b) => (
                  <div className="donut-row" key={b.name}>
                    <i style={{ background: b.color }} />
                    {b.name}
                    <b>{fmt.format(b.value)}</b>
                    <em>{Math.round((b.value / utilTotal) * 100)}%</em>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="chart-area">
              <Empty />
            </div>
          )}
          <div className="coverage">
            <div className="coverage-row">
              <span>Overall utilisation</span>
              <b>{overallUtil}%</b>
            </div>
            <div className="coverage-bar">
              <i style={{ width: `${Math.min(overallUtil, 100)}%` }} />
            </div>
          </div>
        </section>
      </div>
      <ChartCard
        title="Vendor × PO type (open quantity)"
        info="Open pieces per vendor broken down by PO type (EFOB / FOB / JOB …)."
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
      <VendorTypeCharts data={data} />
      <section className="panel table-panel">
        <div className="panel-title">
          <h3>
            Vendor performance
            <InfoDot text="Per-vendor rollup of open and delayed POs, quantities, value, capacity and utilisation. Search, filter and export below." />
          </h3>
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
              <h3>
                {bucket === "Knit" ? "Knitted" : bucket} vendors
                <InfoDot
                  text={`Open vs delayed quantity for every ${bucket === "Knit" ? "knitted" : bucket.toLowerCase()} vendor with open POs.`}
                  label={`About ${bucket} vendors`}
                />
              </h3>
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
                      maxBarSize={22}
                      radius={[0, 4, 4, 0]}
                      fill={
                        bucket === "Woven"
                          ? "#7b4fbf"
                          : bucket === "Knit"
                            ? "#3d9e6b"
                            : "#9a9384"
                      }
                    >
                      <LabelList dataKey="openQty" position="right" fontSize={9} />
                    </Bar>
                    <Bar
                      dataKey="delayedQty"
                      name="Delayed quantity"
                      maxBarSize={22}
                      radius={[0, 4, 4, 0]}
                      fill="#f0a732"
                    >
                      <LabelList dataKey="delayedQty" position="right" fontSize={9} />
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

  const totalMerchants = rows.length;
  const totalOpenPo = rows.reduce((s, r) => s + r.openPoCount, 0);
  const totalDelayed = rows.reduce((s, r) => s + r.delayedPoCount, 0);
  const totalOpenQty = rows.reduce((s, r) => s + r.openQty, 0);
  const onTimePct = totalOpenPo
    ? Math.round(((totalOpenPo - totalDelayed) / totalOpenPo) * 100)
    : 0;
  const delayBands = [
    { name: "On-time", value: totalOpenPo - totalDelayed, color: "#4f7c4d" },
    { name: "Delayed", value: totalDelayed, color: "#f0a732" },
  ].filter((b) => b.value > 0);

  return (
    <>
      <div className="metric-grid compact">
        <Card
          label="Merchants"
          value={fmt.format(totalMerchants)}
          info="Distinct merchants across vendors that currently have open POs."
        />
        <Card
          label="Open POs"
          value={fmt.format(totalOpenPo)}
          tone="blue"
          info="Total open purchase orders across all merchants."
        />
        <Card
          label="Delayed POs"
          value={fmt.format(totalDelayed)}
          tone="orange"
          info="Open POs already past their expected delivery date."
        />
        <Card
          label="Open quantity"
          value={fmt.format(totalOpenQty)}
          tone="teal"
          info="Total pending pieces across open POs."
        />
      </div>
      <div className="bento-grid">
        <ChartCard
          title="Open vs delayed by merchant"
          info="Per merchant: open PO count vs how many are delayed. A tall orange bar flags a merchant with a delivery problem."
          download={{
            filename: "merchant-open-vs-delayed",
            headers: vendorCsvHeaders,
            rows: vendorCsvRows(rows),
          }}
          footer={
            <div className="chart-legend">
              <span className="chart-legend-item"><i style={{ background: "#7b4fbf" }} />Open POs</span>
              <span className="chart-legend-item"><i style={{ background: "#f0a732" }} />Delayed POs</span>
            </div>
          }
        >
          {rows.length ? (
            <ResponsiveContainer>
              <BarChart data={rows} margin={{ left: -14, bottom: 30, top: 8 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="merchant"
                  interval={0}
                  angle={-35}
                  textAnchor="end"
                  height={56}
                  tickLine={false}
                  fontSize={9}
                />
                <YAxis tickLine={false} />
                <Tooltip />
                <Bar dataKey="openPoCount" name="Open PO count" fill="#7b4fbf" radius={[4, 4, 0, 0]} />
                <Bar dataKey="delayedPoCount" name="Delayed PO count" fill="#f0a732" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <Empty />
          )}
        </ChartCard>
        <section className="panel chart-panel">
          <div className="panel-title">
            <div>
              <span className="panel-kicker">Delivery health</span>
              <h3>
                On-time vs delayed
                <InfoDot
                  text="Open POs split into on-time and delayed (past expected delivery). Centre is total open POs; the bar is the on-time share."
                  label="About On-time vs delayed"
                />
              </h3>
            </div>
          </div>
          {totalOpenPo ? (
            <div className="donut-wrap">
              <div className="donut-chart">
                <ResponsiveContainer>
                  <PieChart>
                    <Pie
                      data={delayBands}
                      dataKey="value"
                      nameKey="name"
                      innerRadius="68%"
                      outerRadius="94%"
                      paddingAngle={2}
                      cornerRadius={4}
                      strokeWidth={0}
                    >
                      {delayBands.map((b) => (
                        <Cell key={b.name} fill={b.color} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
                <div className="donut-center">
                  <strong><CountUp text={fmt.format(totalOpenPo)} /></strong>
                  <span>Open POs</span>
                </div>
              </div>
              <div className="donut-legend">
                {delayBands.map((b) => (
                  <div className="donut-row" key={b.name}>
                    <i style={{ background: b.color }} />
                    {b.name}
                    <b>{fmt.format(b.value)}</b>
                    <em>{Math.round((b.value / totalOpenPo) * 100)}%</em>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="chart-area">
              <Empty />
            </div>
          )}
          <div className="coverage">
            <div className="coverage-row">
              <span>On-time share</span>
              <b>{onTimePct}%</b>
            </div>
            <div className="coverage-bar teal">
              <i style={{ width: `${onTimePct}%` }} />
            </div>
          </div>
        </section>
      </div>
      <ChartCard
        title="Merchant open quantity"
        info="Total pending pieces per merchant across open POs."
        download={{
          filename: "merchant-open-qty",
          headers: vendorCsvHeaders,
          rows: vendorCsvRows(rows),
        }}
      >
        {rows.length ? (
          <ResponsiveContainer>
            <BarChart data={rows} margin={{ left: -10, bottom: 30, top: 8 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="merchant"
                interval={0}
                angle={-35}
                textAnchor="end"
                height={56}
                tickLine={false}
                fontSize={9}
              />
              <YAxis tickLine={false} />
              <Tooltip />
              <Bar dataKey="openQty" name="Open quantity" fill="#3d9e6b" radius={[4, 4, 0, 0]} maxBarSize={48} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <Empty />
        )}
      </ChartCard>
      <section className="panel table-panel">
        <div className="panel-title">
          <h3>
            Merchant performance
            <InfoDot text="Vendor metrics rolled up to the merchant who manages them — open/delayed POs, quantities, value and capacity." />
          </h3>
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
      <div className="metric-grid compact">
        <Card
          label="Product codes"
          value={fmt.format(summary.length)}
          info="Distinct product codes with open PO quantity under the current filters."
        />
        <Card
          label="Variant rows"
          value={fmt.format(products.length)}
          tone="blue"
          info="Distinct product-code × variant combinations with open quantity."
        />
        <Card
          label="Open quantity"
          value={fmt.format(summary.reduce((s, r) => s + r.qty, 0))}
          tone="teal"
          info="Total pending pieces across the filtered products."
        />
        <Card
          label="Open value"
          value={money.format(summary.reduce((s, r) => s + r.value, 0))}
          tone="orange"
          info="Total pending value across the filtered products."
        />
      </div>
      <section className="panel table-panel product-table">
        <div className="panel-title">
          <h3>
            Product + variant rollup
            <InfoDot
              text="Open pending quantity and value for every product-code × variant combination, after the filters above."
              label="About Product + variant rollup"
            />
          </h3>
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
          <h3>
            Product code summary
            <InfoDot
              text="One row per product code: how many variants it spans, plus total pending quantity and value."
              label="About Product code summary"
            />
          </h3>
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
          info="Distinct SKUs with pending PO quantity expected to arrive within the next 365 days."
        />
        <Card
          label="Out of Stock"
          value={fmt.format(productOOS.length)}
          note="0 pending quantity"
          tone="orange"
          big
          info="SKUs currently at zero pending quantity — nothing on order to replenish them."
        />
      </div>
      <div className="chart-grid">
        <ChartCard
          title="In Process — top products by pending quantity"
          info="The SKUs with the largest pending PO quantity arriving within 365 days — your biggest inbound replenishment."
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
                  fill="#4f7c4d"
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
          info="SKUs that have gone out of stock most often, by number of recorded occurrences — the repeat offenders to prioritise."
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
                  fill="#b54f7a"
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
          <h3>
            In Process inventory (365 days)
            <InfoDot text="Every open PO line expected within the next 365 days — product, vendor, quantity, EDD and current delay." />
          </h3>
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
          <InfoDot
            text="Open pending quantity for each product (or product · variant) split across the vendors producing it. Use the toggle above to group by variant or by product code."
            label="About the product matrix"
          />
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
  closures = [],
  userEmail,
  role = 'viewer',
  allowedPages = null,
  analyticsRules = {},
  analyticsExtras = null,
}: {
  data: DashboardData;
  closures?: PoClosureView[];
  userEmail: string | null;
  role?: SdRole;
  allowedPages?: string[] | null;
  /** Card thresholds from the Rules Master (sd_analytics_rule). */
  analyticsRules?: Record<string, number>;
  /** Server-computed sections for the cross-module cards. */
  analyticsExtras?: AnalyticsExtras | null;
}) {
  const [tab, setTab] = useState<TabId>("dashboard");
  const [info, setInfo] = useState(false);
  const [detail, setDetail] = useState<TrackerRow | null>(null);
  const [highRisk, setHighRisk] = useState<PendingPo[] | null>(null);
  const [overdue, setOverdue] = useState<PendingPo[] | null>(null);
  const [bucket, setBucket] = useState("All");
  // Item 6 — clicking a vendor on the "Vendor PO status" chart jumps to the Open PO
  // tracker pre-filtered to that vendor. Held here (above both tabs) so the click on
  // the Dashboard tab seeds the tracker's vendor filter when it mounts.
  const [vendorFilter, setVendorFilter] = useState("");
  const openVendorPos = (code: string) => {
    setVendorFilter(code);
    setTab("open-po");
  };
  // Let /?tab=<id> deep-link a specific tab (used by the sidebar on other pages).
  // Tabs are individually grantable views (tab:<id>) — a deep-link to a tab the
  // caller's roles don't include stays on the Dashboard tab.
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("tab");
    if (
      requested &&
      tabs.some(([id]) => id === requested) &&
      canView(`tab:${requested}`, role, allowedPages)
    ) {
      const timer = window.setTimeout(() => setTab(requested as TabId), 0);
      return () => window.clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const current = tabs.find(([id]) => id === tab)!;
  const helpItems: HelpItem[] = simpleGlossary[tab] ?? [];
  return (
    <div className="app-shell">
      <SideNav activeTab={tab} onTab={setTab} userEmail={userEmail} role={role} allowedPages={allowedPages} />
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
            <>
              {/* Cross-tab decision cards — the "so what" layer above the KPIs. */}
              <AnalyticsCards data={data} rules={analyticsRules} extras={analyticsExtras} onTab={setTab} isAdmin={role === "admin"} />
              <DashboardTab
                data={data}
                bucket={bucket}
                setBucket={setBucket}
                onHighRisk={setHighRisk}
                onOverdue={setOverdue}
                onVendorSelect={openVendorPos}
                expectedVsActual={analyticsExtras?.expectedVsActual ?? null}
              />
            </>
          )}{" "}
          {tab === "open-po" && <TrackerTab data={data} closures={closures} onView={setDetail} initialVendorCode={vendorFilter} />}{" "}
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
