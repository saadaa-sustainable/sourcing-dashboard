"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { HeaderInfo } from '@/components/header-info';
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ClipboardList,
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
  MoreHorizontal,
  PackageSearch,
  Timer,
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
  capacityRulesFrom,
  DEFAULT_CAPACITY_RULES,
  type CapacityRules,
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
import { MATRIX_DEFAULT_MODE } from "@/lib/matrix-defaults";
import { FilterTable } from "@/components/filter-table";
import type {
  DashboardData,
  PendingPo,
  TrackerRow,
  VendorRollup,
} from "@/lib/types";
import { TnaBreakdown } from "./tna-breakdown";
import { InfoDot } from "./info-dot";
import { SideNav, tabs, type TabId } from "./side-nav";
import { COINED_TERMS } from "@/lib/glossary";
import { AnalyticsCards, ObjectiveStockCards } from "@/components/analytics-cards";
import { canView } from "@/lib/views";
import type { AnalyticsExtras, PoClosureView, SdRole } from "@/lib/forms/types";
import { signOut } from "@/lib/auth-actions";
import { ApprovalsBell } from "@/components/forms/approvals-bell";
import { FeedbackBell } from "@/components/forms/feedback-bell";
import { ReportButton } from "@/components/forms/report-button";


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
    { title: "Arriving this month", text: "Pieces still to arrive whose delivery date falls inside the current month. The schedule beneath it groups every open line by the month it is due, with anything already past its date separated out and undated lines shown last.", tip: "A year-long window was meaningless against 60 to 90 day production, so arrivals are read by month." },
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
// "Today" is re-read on every render (via istToday()) — a dashboard left open
// overnight must roll its Overdue / Due-today logic to the new date without a reload.
const norm = (value: string | null | undefined) =>
  (value ?? "").trim().toLowerCase();
// Stable colour per product code (hashed hue) — the EDD scatter's colour
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
    // Reduced motion: jump straight to the final value — intentional set-in-effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
  note,
}: {
  filename: string;
  title: string;
  headers: string[];
  rows: CsvValue[][];
  note?: string;
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
          await downloadPdf(filename, title, headers, rows, note);
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
  tall = false,
  footer,
  actions,
}: {
  title: string;
  kicker?: string;
  info?: string;
  children: React.ReactNode;
  download?: { filename: string; headers: string[]; rows: CsvValue[][] };
  wide?: boolean;
  tall?: boolean;
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
      <div className={`chart-area${tall ? " tall" : ""}`}>{children}</div>
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

/**
 * The Main Dashboard is read in seven passes, each answering one question, so nobody scrolls
 * a single page looking for the number they came for.
 *
 * "Objectives" is the standing five plus the two money cards — what is at stake sits with the
 * problems it is at stake over. "Open orders today" is the working view exactly as it was. The
 * rest group the cross-module analytics by the decision they serve rather than by which module
 * produced them.
 */
const DASH_GROUPS = [
  ["objectives", "Objectives"],
  ["orders", "Open orders today"],
  ["stock", "Will we run out"],
  ["plan", "Buying to plan"],
  ["vendors", "Who we buy from"],
  ["datahealth", "Trust the numbers"],
] as const;

type DashGroup = (typeof DASH_GROUPS)[number][0];

function DashboardTab({
  capacityRules = DEFAULT_CAPACITY_RULES,
  data,
  bucket,
  setBucket,
  onHighRisk,
  onOverdue,
  onVendorSelect,
  onTab,
  section,
  expectedVsActual = null,
  extras = null,
}: {
  capacityRules?: CapacityRules;
  data: DashboardData;
  bucket: string;
  setBucket: (v: string) => void;
  onHighRisk: (rows: PendingPo[]) => void;
  onOverdue: (rows: PendingPo[]) => void;
  onVendorSelect?: (vendorCode: string) => void;
  /** Switches the shell's own tab — the stock objectives link into other views. */
  onTab: (tab: TabId) => void;
  /**
   * "objectives" renders the five standing objectives; "orders" renders the open-order view
   * and its charts. Both keep the weave filter, because both are read weave by weave.
   */
  section: "objectives" | "orders";
  expectedVsActual?: AnalyticsExtras["expectedVsActual"];
  /** Server-computed sections — the stock and OTIF objectives read from these. */
  extras?: AnalyticsExtras | null;
}) {
  const lookups = useMemo(
    () => createLookups(data.vendorTypes, data.vendorMasters, data.tnaRecords),
    [data],
  );
  const rows = useMemo(
    () =>
      data.pendingPos.filter(
        // Weave of the PRODUCT (master weave), falling back to the vendor's type —
        // same rule the tracker and vendor rollups use, so all tabs agree.
        (row) =>
          bucket === "All" ||
          (row.master_weave ?? resolveVendor(row, lookups).bucket) === bucket,
      ),
    [data.pendingPos, bucket, lookups],
  );
  const router = useRouter();
  const today = istToday();
  const open = rows.filter(isOpenPo);
  const delayed = open.filter((row) => isDelayedPo(row, today));
  const highRisk = open.filter((row) => isHighRiskLine(row, lookups.tnaByPo, today));
  const openRefs = unique(open.map((row) => row.po_ref_num ?? ""));
  const delayedRefs = unique(delayed.map((row) => row.po_ref_num ?? ""));
  /*
    Overdue is judged on the expected delivery date, so a PO with no date can never be counted
    however long it sits. The figure worth stating is how many POs are INVISIBLE to the
    measure, which is not the same as how many have a blank line on them.

    Today 328 open lines carry no date, spread across 8 POs — but 6 of those 8 also have dated
    lines, so the PO is already being judged (5 of them already count as overdue). Only the POs
    where NOT ONE open line has a date are genuinely unmeasurable: 2 of them. Counting the 8
    would overstate the blind spot fourfold.
  */
  const refsWithDate = new Set(
    open.filter((r) => r.expected_delivery_date).map((r) => r.po_ref_num ?? ""),
  );
  const undatedRefs = openRefs.filter((ref) => !refsWithDate.has(ref)).length;

  /**
   * The five standing objectives. Each carries a count and a value and each is clickable:
   * the two PO objectives open their audit list, the stock and OTIF ones open the page that
   * owns that number.
   *
   * High Risk and Overdue stay separate. A PO is high risk when a TNA stage has slipped and
   * overdue when its delivery date has passed; either can be true alone, and they call for
   * different action, so they are never added together into one figure.
   */
  const lineValue = (r: PendingPo) => r.pending_qty_actual * r.item_price;
  const sumValue = (rowsIn: PendingPo[]) => rowsIn.reduce((acc, r) => acc + lineValue(r), 0);
  // OTIF is measured on COMPLETED POs only: a finished order either arrived on time and in
  // full or it did not. Open POs have not had their chance yet, so including them would flatter
  // the figure. Delivery Reliability, which does span both, stays as its own separate card.
  const otif = extras?.otif ?? null;
  const otifPct =
    otif && otif.completedPos > 0 ? Math.round((otif.otif / otif.completedPos) * 100) : null;

  // Figures the objective cards below need.
  const highRiskRefs = unique(highRisk.map((r) => r.po_ref_num ?? "")).length;

  /*
    Open value, by PO type.

    Two things this gets right that a plain sum over open lines does not.

    First, it nets reversals. A cancelled or reversed line comes back as a NEGATIVE pending
    quantity on the same purchase order. Summing only the positive lines counts the original
    order in full and ignores the credit against it, so the book reads high. Value is summed
    over every line of a purchase order that is still open, negatives included.

    Second, job work is valued at the job-work rate, not at a garment price: item_price on a
    JOB line is already the CMT rate (around Rs 112 a piece against Rs 320 on FOB), so the
    three types must be shown apart rather than blended into one number.
  */
  const openRefSet = new Set(openRefs);
  const poTypeOf = (r: PendingPo) => {
    const t = (r.po_type ?? "").trim().toUpperCase();
    if (t === "FOB" || t === "EFOB" || t === "JOB") return t;
    return "Other";
  };
  const valueByType = rows
    .filter((r) => openRefSet.has(r.po_ref_num ?? ""))
    .reduce<Record<string, { value: number; qty: number }>>((acc, r) => {
      const key = poTypeOf(r);
      const cur = (acc[key] ??= { value: 0, qty: 0 });
      cur.value += r.pending_qty_actual * r.item_price;
      cur.qty += r.pending_qty_actual;
      return acc;
    }, {});
  const openValueNet = Object.values(valueByType).reduce((sum, v) => sum + v.value, 0);
  const typeOrder = ["FOB", "EFOB", "JOB", "Other"] as const;
  const typeLabel: Record<string, string> = { FOB: "FOB", EFOB: "E-FOB", JOB: "Job work", Other: "Untyped" };
  const valueSplit = typeOrder
    .filter((t) => valueByType[t]?.value)
    .map((t) => `${typeLabel[t]} ${money.format(valueByType[t].value)}`)
    .join(" · ");
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
    new Map(),
    capacityRules,
  );
  const dayMs = 86_400_000;
  /* EDD schedule: one bubble per open PO, X = expected delivery date, Y = vendor code,
     size = pending quantity.

     Only POs with something genuinely left to receive are plotted. A PO sitting on under 5%
     of its ordered quantity is finished in every way that matters — it is waiting on a closure
     click, not on goods — and leaving those in filled the chart with dots nobody can act on.

     Colour marks the ones that should already have closed: received in full or nearly so but
     still open, or past their delivery date with the goods not in. Those are the dots worth
     looking at, which is a better use of colour than repeating the product code. */
  const REMAINING_FLOOR = 0.05;
  const stillOpen = tracker.filter((row) => {
    if (row.pendingQty <= 0) return false;
    if (row.orderedQty <= 0) return true;
    /* The should-have-closed POs are the exception to the 5% rule, not a casualty of it.
       "Closure Pending" means 95% or more received, which is the same thing as 5% or less
       pending — so excluding everything under 5% removed exactly the POs the red colour was
       meant to highlight, and red could never appear however the data looked. Keep them. */
    if (row.easycomStatus === "Closure Pending") return true;
    return row.pendingQty / row.orderedQty >= REMAINING_FLOOR;
  });
  const nearlyDone = tracker.length - stillOpen.length;
  const eddBubbleKind = (row: (typeof tracker)[number]) => {
    if (row.easycomStatus === "Closure Pending") return "to_close" as const;
    if (row.delayDays > 0) return "late" as const;
    return "on_track" as const;
  };
  const eddScatter = stillOpen
    .map((row) => {
      const edd = row.edd ? parseIsoDate(row.edd) : null;
      return edd
        ? {
            x: edd.getTime(),
            vendor: row.vendorCode || row.vendorName || "Unknown",
            z: Math.max(1, row.pendingQty),
            productCode: row.productCode || "(no product code)",
            poRef: row.poRef,
            edd: row.edd as string,
            kind: eddBubbleKind(row),
            delayDays: row.delayDays,
          }
        : null;
    })
    .filter(
      (p): p is NonNullable<typeof p> =>
        p != null && p.x >= today.getTime() - 45 * dayMs && p.x <= today.getTime() + 90 * dayMs,
    );

  /* The TNA critical path, as a Gantt.

     One bar per open PO, running from the earliest planned stage date to the last, with the
     stage that has slipped marked on it. Read together with the bubbles above: those say when
     goods are due, this says whether the work behind them is running to time. */
  // The tracker rows are per PO LINE (one per colour), so a PO with four colours came out
  // as four identical bars. The TNA is one per PO: roll the lines up and sum the pending.
  const ganttByPo = new Map<string, (typeof stillOpen)[number]>();
  for (const row of stillOpen) {
    if (!row.tna) continue;
    const cur = ganttByPo.get(row.poRef);
    if (cur) cur.pendingQty += row.pendingQty;
    else ganttByPo.set(row.poRef, { ...row });
  }
  const gantt = [...ganttByPo.values()]
    .map((row) => {
      // TNA_STAGES is the shared critical path (business-logic) — same list the High Risk
      // rule walks, so the chart cannot drift from the flag.
      const t = row.tna!;
      const stages = TNA_STAGES.map((stage) => {
        const planned = t[stage.tnaField] as string | null | undefined;
        const actual = t[stage.actualField] as string | null | undefined;
        const plannedAt = planned ? parseIsoDate(planned) : null;
        const daysLate = plannedAt && !actual ? Math.floor((today.getTime() - plannedAt.getTime()) / dayMs) : 0;
        return {
          key: stage.tnaField,
          label: stage.name === "Inline / Midline QC" ? "Inline QC" : stage.name,
          short: TNA_STAGE_SHORT[stage.name] ?? stage.name,
          plannedAt: plannedAt ? plannedAt.getTime() : null,
          done: Boolean(actual),
          late: Boolean(plannedAt && !actual && plannedAt.getTime() < today.getTime()),
          daysLate: Math.max(0, daysLate),
        };
      }).filter((st) => st.plannedAt != null);
      if (!stages.length) return null;
      const from = Math.min(...stages.map((st) => st.plannedAt!));
      const to = Math.max(...stages.map((st) => st.plannedAt!));
      // The bar is drawn in pieces, one per gap between stages, coloured by the state of the
      // stage the piece leads to: green when that stage is done, red when its date has passed
      // with nothing recorded, grey when it is still to come.
      const segments = stages.slice(1).map((st, i) => ({
        key: st.key,
        from: stages[i].plannedAt!,
        to: st.plannedAt!,
        state: st.done ? "done" : st.late ? "late" : "ahead",
      }));
      return {
        poRef: row.poRef,
        vendorCode: row.vendorCode || row.vendorName,
        productCode: row.productCode,
        pendingQty: row.pendingQty,
        from,
        to,
        stages,
        segments,
        slipped: stages.filter((st) => st.late).length,
        worstLate: Math.max(0, ...stages.map((st) => st.daysLate)),
      };
    })
    .filter((g): g is NonNullable<typeof g> => g != null)
    .sort((a, b) => b.slipped - a.slipped || b.worstLate - a.worstLate || a.from - b.from)
    .slice(0, 14);
  // The axis always includes today, with a week of air either side, so the Today line is
  // never on the edge and "how far past" can be read off the month ticks.
  const ganttFrom = gantt.length ? Math.min(today.getTime(), ...gantt.map((g) => g.from)) - 7 * dayMs : 0;
  const ganttTo = gantt.length ? Math.max(today.getTime(), ...gantt.map((g) => g.to)) + 7 * dayMs : 1;
  const ganttSpan = Math.max(1, ganttTo - ganttFrom);
  const ganttPct = (t: number) => ((t - ganttFrom) / ganttSpan) * 100;
  const ganttTicks: { at: number; label: string }[] = [];
  if (gantt.length) {
    const d = new Date(ganttFrom);
    let tick = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    while (tick < ganttTo) {
      ganttTicks.push({
        at: tick,
        label: new Date(tick).toLocaleDateString("en-IN", { month: "short", timeZone: "UTC" }),
      });
      const n = new Date(tick);
      tick = Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 1);
    }
  }
  /* One bubble per vendor per WEEK, not per PO.

     Plotted per PO the chart was mostly white space: twenty vendor rows, dots too small to
     compare and too many to count. Rolling each vendor's POs into the week they are due gives
     a few large bubbles whose size can actually be read against each other, and the week is
     the finest unit anyone schedules against anyway.

     A bubble takes the worst status of the POs inside it, because that is what needs acting
     on: a week containing one PO that should have closed is a week worth opening. */
  const weekStartOf = (ms: number) => {
    const d = new Date(ms);
    const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow);
  };
  const kindRank = { to_close: 3, late: 2, on_track: 1 } as const;
  const eddWeekly = [
    ...eddScatter
      .reduce((acc, p) => {
        const week = weekStartOf(p.x);
        const key = `${p.vendor}|${week}`;
        const cur = acc.get(key);
        if (cur) {
          cur.z += p.z;
          cur.pos += 1;
          if (kindRank[p.kind] > kindRank[cur.kind]) cur.kind = p.kind;
          cur.worstDelay = Math.max(cur.worstDelay, p.delayDays);
        } else {
          acc.set(key, {
            x: week,
            vendor: p.vendor,
            z: p.z,
            pos: 1,
            kind: p.kind,
            worstDelay: p.delayDays,
          });
        }
        return acc;
      }, new Map<string, { x: number; vendor: string; z: number; pos: number; kind: "to_close" | "late" | "on_track"; worstDelay: number }>())
      .values(),
  ];
  const hasEddScatter = eddWeekly.length > 0;
  // Y is a numeric row index, not a category axis: with several bubbles per vendor a category
  // axis positions marks by data index while labelling rows by unique vendor, so marks landed
  // on the wrong row. Only vendors that actually have something due are listed.
  const eddVendors = [...new Set(eddWeekly.map((p) => p.vendor))].sort((a, b) => a.localeCompare(b));
  const eddVendorIndex = new Map(eddVendors.map((v, i) => [v, i] as const));
  const eddPoints = eddWeekly.map((p) => ({ ...p, y: eddVendorIndex.get(p.vendor) ?? 0 }));
  const eddVendorCount = eddVendors.length;
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
      const key = `${row.productCode} · ${sku.product_variant ?? "(no variant)"}`;
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
      {section === "objectives" ? (
        <>
          <div className="metric-grid dashboard-metrics">
            <Card
              label="Overdue POs"
              value={fmt.format(delayedRefs.length)}
              note={`${money.format(sumValue(delayed))} pending · ${openRefs.length ? Math.round((delayedRefs.length / openRefs.length) * 100) : 0}% of open · view audit`}
              tone="red"
              icon={CalendarClock}
              info={`Open POs whose expected delivery date is already past, with the pending value still sitting behind them. Click to open the audit list. Kept separate from High Risk: a PO can be overdue without any TNA stage having slipped.${undatedRefs ? ` ${undatedRefs} open PO${undatedRefs === 1 ? " has" : "s have"} no expected delivery date on any line, so ${undatedRefs === 1 ? "it cannot" : "they cannot"} be counted here however long ${undatedRefs === 1 ? "it has" : "they have"} been open — see the No EDD bucket in PO ageing.` : ""}`}
              onClick={() => onOverdue(delayed)}
            />
            <Card
              label="High Risk POs"
              value={fmt.format(highRiskRefs)}
              note={`${money.format(sumValue(highRisk))} pending · TNA stage slipped · view details`}
              tone="orange"
              icon={AlertTriangle}
              info={"WHAT: open POs where the work is running late — a critical-path TNA stage (PP sample, GPT, cutting, inline QC) is past its planned date and nobody has recorded it as done. The value is the pending pieces on those POs × item price.\n\nHOW: planned stage date < today AND no actual date for that stage. Example: cutting was planned for 10 Sep, today is 22 Sep, the cutting date is still blank → High Risk. The moment the actual date is entered, the PO drops out.\n\nUSE: chase the vendor or the merchandiser now, before the delivery date arrives. Deliberately separate from Overdue: a High Risk PO may still be days away from its delivery date — this is the early warning, Overdue is the missed date."}
              onClick={() => onHighRisk(highRisk)}
            />
            <Card
              label="OTIF"
              value={otifPct == null ? "—" : `${otifPct}%`}
              note={
                otif
                  ? `${fmt.format(otif.otif)} of ${fmt.format(otif.completedPos)} completed POs · ${money.format(otif.otifValue)} delivered OTIF`
                  : "completed-PO data unavailable"
              }
              tone={otifPct != null && otifPct < 80 ? "red" : "teal"}
              icon={Timer}
              info={
                otif
                  ? `Completed POs over the last ${otif.windowDays} days that arrived on time AND in full: closed on or before the expected delivery date with nothing left pending. ${fmt.format(otif.onTime)} were on time and ${fmt.format(otif.inFull)} were in full; OTIF counts only those that were both. Open POs are excluded — they have not had their chance yet. Click to open Vendor OTIF.`
                  : "Completed-PO data is not available."
              }
              onClick={otif ? () => router.push("/vendor-otif") : undefined}
            />
            <Card
              label="Open issues"
              value={extras?.openIssues == null ? "—" : fmt.format(extras.openIssues)}
              note="raised by people and by the dashboard's own checks · open the tracker"
              tone={extras?.openIssues ? "orange" : "teal"}
              icon={ClipboardList}
              info={"WHAT: how many issues are open on the Issue Tracker right now — raised by people to each other, and raised by the dashboard from its own checks.\n\nHOW: issues in Open or In progress. The dashboard raises one per open PO with no TNA timeline, per open PO with no delivery date, per discontinued product still on order, and per stale feed; it closes them itself when the condition is gone.\n\nUSE: click to open the tracker. This number should trend down; days from raise to resolve are tracked there."}
              onClick={() => router.push("/issues")}
            />
          </div>
          <ObjectiveStockCards extras={extras} onTab={onTab} />
        </>
      ) : (
      <>
      <div className="metric-grid dashboard-metrics">
        <Card
          label="Open POs"
          value={fmt.format(openRefs.length)}
          note={`${fmt.format(open.length)} SKU rows`}
          tone="blue"
          icon={LayoutDashboard}
          info={"WHAT: how many purchase orders are still open — counted as PO numbers, not lines.\n\nHOW: a PO is open while any of its lines still has pending quantity above 0. A PO with three colours on it counts once. Fully received POs drop off, even if EasyEcom has not closed them yet.\n\nUSE: the size of the book the team is chasing. Read with 'Pending pieces' beside it — many POs with few pieces is a closure problem, few POs with many pieces is a delivery problem."}
        />
        <Card
          label="Open Qty"
          value={fmt.format(open.reduce((s, r) => s + r.pending_qty_actual, 0))}
          note="pieces pending"
          tone="amber"
          info={"WHAT: how many pieces are still to arrive across every open PO.\n\nHOW: ordered quantity − received quantity, summed over every open PO line (each colour and size). Example: a line ordered 500, received 320 → 180 pending.\n\nUSE: the physical volume still in vendors' hands. Divide by the vendors' monthly capacity (Vendor Performance tab) to see whether the backlog is more than a month's work."}
        />
        <Card
          label="Open Value"
          value={money.format(openValueNet)}
          note={valueSplit || "pending qty × item price"}
          tone="teal"
          icon={IndianRupee}
          info={"WHAT: the money committed on open POs — pending pieces × item price, shown per PO type.\n\nHOW: for every open line, pending quantity × the price on the PO, summed by type. Job Work lines are priced at the job-work (stitching) rate, not a full garment price, so the three types are shown side by side rather than added into one misleading total. Reversed or cancelled lines carry negative quantities and are netted off, not dropped.\n\nUSE: what is tied up with vendors right now. A rising FOB figure with flat arrivals means goods are being ordered faster than they land. Compare with the Buying Plan's approved value for the month."}
        />
      </div>
      <div className="bento-grid">
        <ChartCard
          title="Expected vs actual delivery"
          kicker="Delivery slippage"
          info={"WHAT: week by week, how much was due to arrive against how much actually did — the delivery slippage.\n\nHOW: from completed POs over the last 12 weeks. Expected = pieces whose expected delivery date fell in that week. Actual = pieces whose PO completed in that week. The shaded band is the gap. Example: 8,000 due in week 36, 5,200 completed → a 2,800 shortfall that week.\n\nUSE: a widening band means vendors are falling further behind plan; a band that closes after a bad week means the backlog was caught up. Completed POs only — open POs are on the Open PO Tracker."}
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
                  text={"WHAT: where every open PO is in production right now.\n\nHOW: each PO is placed at its current stage — the earliest TNA stage that has no actual date yet. Example: PP sample and GPT dated, cutting blank → the PO sits at Cutting. The centre number is the count of open POs. 'No TNA' means no timeline was entered at all.\n\nUSE: a pile-up at one stage points at where the process is stuck (often GPT approvals or cutting). A large 'No TNA' slice is an adoption problem — merchandisers not filling the timeline — not a production one."}
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
          info={"WHAT: how late the open POs are, grouped into bands.\n\nHOW: today − expected delivery date (EDD), per PO. Not Due = EDD still ahead. Then 1–7, 8–15, 16–30 and 30+ days past. 'No EDD' = no delivery date on the PO at all, so lateness cannot be judged.\n\nUSE: the 30+ band is the list to escalate or close out; a big No EDD band means POs are being raised without dates and should be fixed at PO Approval."}
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
                  text={"WHAT: how many open POs have reached each checkpoint, and how well the book is covered by timelines and deliveries.\n\nHOW: distinct open POs at each checkpoint. TNA coverage = open POs with a timeline entered ÷ all open POs. Qty delivered = pieces received ÷ pieces ordered across open POs. Example: 96 open POs, 72 with a TNA → 75% coverage.\n\nUSE: coverage below 100% means the High Risk flag is blind to those POs — they cannot be late on a stage that was never planned. Get the timelines entered first, then read the rest."}
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
          info={"WHAT: which production stage loses the most time.\n\nHOW: for each stage, take the POs that completed it later than planned and average the days late. Example: 12 POs finished cutting late by 2, 5, 9… days → average 6 days. Stages still pending are not counted until an actual date lands. Green ≤ 3 days, amber ≤ 7, red > 7.\n\nUSE: the red stage is where the lead time is really being lost. Fixing it (say GPT approval turnaround) shortens every PO."}
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
          info={"WHAT: the products whose deliveries are most behind.\n\nHOW: per product code, overdue open POs ÷ all its open POs. Example: 4 open POs, 3 past their delivery date → 75%. Codes with nothing overdue are hidden.\n\nUSE: a product at 100% with high demand is a stock-out in the making — cross-check it on the Stock Out Risk tab and chase those POs first."}
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
          info={"WHAT: which vendors are late, and how much of their book is late.\n\nHOW: per vendor, open POs (bar), how many are past their expected delivery date (darker bar), and delayed ÷ open as the line on the right axis. Example: 10 open, 4 past EDD → 40%.\n\nUSE: a high line on a small bar is one bad PO; a high line on a tall bar is a vendor problem. Click a vendor to open its POs in the tracker."}
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
          info={"WHAT: the ten products with the most pieces still to arrive.\n\nHOW: pending pieces summed per product code across open POs; top ten.\n\nUSE: these are the products whose stock position depends most on vendors delivering. If one of them is also on the Stock Out Risk tab, it is the first to chase."}
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
                  text={"WHAT: the product-and-colour combinations with the most open POs, and how many of those POs are late.\n\nHOW: open POs counted per product · variant; the bar is relative volume. The badge is POs past their expected delivery date ÷ open POs for that variant — green 0%, amber up to 50%, red above.\n\nUSE: a red badge on a top row means a best-selling colour is being let down by its vendors."}
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
      {/* EDD scatter last: a full-width, tall panel (not a half bento cell) so every
          vendor gets vertical room — labels never collide, date axis stays in view.
          Removing it from the top row let Expected-vs-actual + Production pipeline
          pair up and fill the slot that donut used to leave empty. */}
      <ChartCard
        tall
        title="EDD schedule — pieces due by vendor and week"
        kicker="EDD schedule"
        info={`One bubble per vendor per week (X = week due, Y = vendor code), sized by the pieces due that week — POs are rolled into their week so the sizes can be compared instead of a cloud of single dots. Vendors with nothing due are not listed. Colour marks what needs acting on: red for POs received in full or nearly so but never closed, amber for POs past their delivery date with goods still out, green for those running to time. POs with less than 5% of their quantity left are left out — they are waiting on a closure click, not on goods${nearlyDone ? ` (${fmt.format(nearlyDone)} excluded today)` : ""}. Bubbles left of the dashed This-week line are overdue. Window is −45 to +90 days.`}
        actions={
          <span className="legend-pills">
            {(["to_close", "late", "on_track"] as const).map((k) => (
              <span
                key={k}
                className="legend-pill"
                style={{ "--pill-color": EDD_KIND_COLOR[k] } as CSSProperties}
              >
                <i /> {EDD_KIND_LABEL[k]}
              </span>
            ))}
          </span>
        }
      >
        {hasEddScatter ? (
          <VScrollChart count={eddVendorCount} per={26} min={300}>
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
                type="number"
                dataKey="y"
                domain={[-0.5, Math.max(0, eddVendors.length - 0.5)]}
                ticks={eddVendors.map((_, i) => i)}
                tickFormatter={(i: number) => eddVendors[i] ?? ""}
                reversed
                allowDecimals={false}
                width={130}
                tickLine={false}
                fontSize={10}
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
                    vendor: string; z: number; x: number; pos: number;
                    kind: "to_close" | "late" | "on_track"; worstDelay: number;
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
                      <strong>{p.vendor}</strong>
                      <div>
                        week of{" "}
                        {new Date(p.x).toLocaleDateString("en-IN", {
                          day: "numeric",
                          month: "short",
                          timeZone: "UTC",
                        })}
                      </div>
                      <div>
                        {fmt.format(p.z)} pcs · {p.pos} PO{p.pos === 1 ? "" : "s"}
                      </div>
                      <div>
                        {EDD_KIND_LABEL[p.kind]}
                        {p.worstDelay > 0 ? ` · up to ${p.worstDelay}d late` : ""}
                      </div>
                    </div>
                  );
                }}
              />
              <Scatter data={eddPoints} fillOpacity={0.78}>
                {eddPoints.map((p, i) => (
                  <Cell key={i} fill={EDD_KIND_COLOR[p.kind]} />
                ))}
              </Scatter>
            </ScatterChart>
          </VScrollChart>
        ) : (
          <Empty text="No EDDs inside the −45 to +90 day window" />
        )}
      </ChartCard>

      <ChartCard
        tall
        title="TNA critical path — planned stage dates"
        kicker="Is the work on time"
        info={"WHAT: is the work behind each open PO running to time. One row per PO, its planned stages laid on a calendar with today marked.\n\nHOW: the stages are PP sample → GPT → cutting → inline QC → first delivery → PO close. Each piece of the bar is coloured by the stage it leads to: green = done, red = planned date passed with nothing recorded (this is what makes a PO High Risk), grey = still to come. The chips under the PO number name every stage; a red chip shows how many days past it is. Hover a dot for the planned date.\n\nUSE: read with the delivery bubbles above — those say WHEN goods are due, this says WHETHER the work will get there. Most-slipped POs are at the top (top 14; scroll inside the card for the rest)."}
        actions={
          <span className="legend-pills">
            <span className="legend-pill" style={{ "--pill-color": "#4f7c4d" } as CSSProperties}>
              <i /> done
            </span>
            <span className="legend-pill" style={{ "--pill-color": "#c0392b" } as CSSProperties}>
              <i /> past planned date, not done
            </span>
            <span className="legend-pill" style={{ "--pill-color": "#b9b3a4" } as CSSProperties}>
              <i /> still to come
            </span>
          </span>
        }
      >
        {gantt.length ? (
          <div className="gantt">
            <div className="gantt-row gantt-axis">
              <span className="gantt-label" />
              <span className="gantt-track">
                {ganttTicks.map((tk) => (
                  <b key={tk.at} className="gantt-tick" style={{ left: `${ganttPct(tk.at)}%` }}>
                    {tk.label}
                  </b>
                ))}
                <b className="gantt-tick is-today" style={{ left: `${ganttPct(today.getTime())}%` }}>
                  Today
                </b>
              </span>
            </div>
            {gantt.map((g) => (
              <div className="gantt-row" key={g.poRef}>
                <span className="gantt-label">
                  <b>{g.poRef}</b>
                  <small>
                    {g.vendorCode} · {fmt.format(g.pendingQty)} pcs
                    {g.slipped ? <strong className="gantt-late-count"> · {g.slipped} stage{g.slipped > 1 ? "s" : ""} late</strong> : null}
                  </small>
                  {/* Stage names and days-late live here, not on the bar: chips wrap, so
                      they can never overprint each other or run out of the track. */}
                  <span className="gantt-stages">
                    {g.stages.map((st) => (
                      <span
                        key={st.key}
                        className={`gantt-chip is-${st.done ? "done" : st.late ? "late" : "ahead"}`}
                        title={`${st.label} — planned ${new Date(st.plannedAt!).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" })}`}
                      >
                        {st.short}
                        {st.late ? ` +${st.daysLate}d` : st.done ? " ✓" : ""}
                      </span>
                    ))}
                  </span>
                </span>
                <span className="gantt-track">
                  {ganttTicks.map((tk) => (
                    <u key={tk.at} className="gantt-grid" style={{ left: `${ganttPct(tk.at)}%` }} />
                  ))}
                  <u className="gantt-grid is-today" style={{ left: `${ganttPct(today.getTime())}%` }} />
                  {g.segments.map((sg) => (
                    <i
                      key={sg.key}
                      className={`gantt-bar is-${sg.state}`}
                      style={{
                        left: `${ganttPct(sg.from)}%`,
                        width: `${Math.max(0.4, ganttPct(sg.to) - ganttPct(sg.from))}%`,
                      }}
                    />
                  ))}
                  {g.stages.map((st) => (
                    <em
                      key={st.key}
                      className={`gantt-dot${st.done ? " is-done" : st.late ? " is-late" : ""}`}
                      style={{ left: `${ganttPct(st.plannedAt!)}%` }}
                      title={`${st.label} — planned ${new Date(st.plannedAt!).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" })}${st.done ? " · done" : st.late ? ` · ${st.daysLate} days past, not done` : " · not due yet"}`}
                    />
                  ))}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <Empty text="No open PO has a TNA timeline to plot" />
        )}
      </ChartCard>
      </>
      )}
    </>
  );
}


/* Stage names short enough to sit on the Gantt bar; the full name is in the tooltip. */
const TNA_STAGE_SHORT: Record<string, string> = {
  "PP Sample": "PP",
  GPT: "GPT",
  Cutting: "Cut",
  "Inline / Midline QC": "QC",
  "First Delivery": "1st del",
  "PO Closer": "Close",
};

/* EDD bubbles are coloured by what to do about them, not by product. "To close" is the one
   worth chasing: goods are in but the PO is still open. */
const EDD_KIND_COLOR: Record<"to_close" | "late" | "on_track", string> = {
  to_close: "#c0392b",
  late: "#d9a441",
  on_track: "#4f7c4d",
};
const EDD_KIND_LABEL: Record<"to_close" | "late" | "on_track", string> = {
  to_close: "received, still open",
  late: "past delivery date",
  on_track: "on time",
};

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
  const today = istToday();
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
    [data, today],
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
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const moreFilterCount = [
    filters.vendor,
    filters.product,
    filters.easycom,
    filters.bucket,
  ].filter(Boolean).length;
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
          value={fmt.format(all.filter((r) => r.pendingQty > 0).length)}
          info={"WHAT: how many open PO lines still have pieces to arrive. A line is one colour on one PO.\n\nHOW: Approved lines with pending quantity above 0. Lines that are fully received but not yet closed on EasyEcom appear in the table (for closure) but are not counted here.\n\nUSE: the working list. The count of POs is on the Objectives tab; this is lines, so one PO with four colours contributes four."}
        />
        <Card
          label="Delayed lines"
          value={fmt.format(all.filter((r) => r.pendingQty > 0 && r.delayDays > 0).length)}
          tone="orange"
          info={"WHAT: open lines whose expected delivery date has passed with pieces still pending.\n\nHOW: expected delivery date < today AND pending quantity > 0.\n\nUSE: each of these is a promise already broken — either chase the vendor for a new committed date or close the line if it will never come."}
        />
        <Card
          label="Missing TNA"
          value={fmt.format(missingTnaCount)}
          tone="red"
          note="each one is an issue on the tracker · open it"
          onClick={() => window.location.assign("/issues?category=tna")}
          info={"WHAT: open lines with no production timeline (TNA) entered.\n\nHOW: no TNA record found for the PO.\n\nUSE: the High Risk rule cannot see these lines — they can be late on every stage and never flag. This is a data-entry gap for the merchandiser to close, not a production problem."}
        />
        <Card
          label="Open quantity"
          value={fmt.format(all.reduce((s, r) => s + r.pendingQty, 0))}
          tone="teal"
          info={"WHAT: pieces still to arrive across all open lines.\n\nHOW: ordered − received, summed over every open line.\n\nUSE: the volume vendors still owe. Compare with monthly capacity on Vendor Performance."}
        />
      </div>
      <div className="filter-bar tracker-filter-bar">
        <label className="search-field">
          <Search size={16} />
          <input
            placeholder="Search PO, product or vendor"
            value={filters.search}
            onChange={(e) => set({ ...filters, search: e.target.value })}
          />
        </label>
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
          label="Merchant"
          value={filters.merchant}
          options={unique(all.map((r) => r.merchant))}
          onChange={(v) => set({ ...filters, merchant: v })}
        />
        <button
          type="button"
          className={moreFiltersOpen ? "tracker-more-button active" : "tracker-more-button"}
          aria-expanded={moreFiltersOpen}
          aria-controls="tracker-more-filters"
          onClick={() => setMoreFiltersOpen((open) => !open)}
        >
          <MoreHorizontal size={15} aria-hidden="true" />
          More filters
          {moreFilterCount > 0 && (
            <span className="tracker-more-count">{moreFilterCount}</span>
          )}
        </button>
        <div
          id="tracker-more-filters"
          className="tracker-more-filters"
          role="group"
          aria-label="More filters"
          hidden={!moreFiltersOpen}
        >
          <FilterSelect
            label="Vendor"
            value={filters.vendor}
            options={unique(all.map((r) => r.vendorName))}
            onChange={(v) => set({ ...filters, vendor: v })}
          />
          <FilterSelect
            label="Product"
            value={filters.product}
            options={unique(all.map((r) => r.productCode))}
            onChange={(v) => set({ ...filters, product: v })}
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
  reportNote,
}: {
  rows: VendorRollup[];
  filename?: string;
  exportTitle?: string;
  searchPlaceholder?: string;
  withFilters?: boolean;
  /** Item 5 — free-text remark included in the exported PDF. */
  reportNote?: string;
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
              note={reportNote}
            />
          </div>
        </div>
      )}
      {rows.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Vendor <HeaderInfo label="Vendor" /></th>
                <th>Merchant <HeaderInfo label="Merchant" /></th>
                <th>Open POs <HeaderInfo label="Open POs" /></th>
                <th>Delayed <HeaderInfo label="Delayed" /></th>
                <th>Delay % <HeaderInfo label="Delay %" /></th>
                <th>Open qty <HeaderInfo label="Open qty" /></th>
                <th>Open value <HeaderInfo label="Open value" /></th>
                <th>Machines <HeaderInfo label="Machines" /></th>
                <th>Active karigar <HeaderInfo label="Active karigar" /></th>
                <th>Latest karigar <HeaderInfo label="Latest karigar" /></th>
                <th>Capacity/mo <HeaderInfo label="Capacity/mo" /></th>
                <th>PO capacity <HeaderInfo label="PO capacity" /></th>
                <th>Utilization <HeaderInfo label="Utilization" /></th>
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
                    {!row.capacityEntered ? (
                      <span className="badge">Not entered</span>
                    ) : row.utilizationPct > 100 ? (
                      <span
                        className="badge danger"
                        title="More on order than the vendor can make inside its PO lead time"
                      >
                        {row.utilizationPct}% · over
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

function VendorTab({ data, capacityRules = DEFAULT_CAPACITY_RULES }: { data: DashboardData; capacityRules?: CapacityRules }) {
  const today = istToday();
  // Item 4 — period for the PDF export: All time / YTD / a specific quarter.
  // Filters the underlying POs by po_date before the rollups the report exports.
  const [period, setPeriod] = useState<'all' | 'ytd' | 'q1' | 'q2' | 'q3' | 'q4'>('all');
  // Item 5 — a remark attached to this report generation (not the vendor record).
  const [remark, setRemark] = useState('');
  const year = today.getUTCFullYear();
  const periodLabel =
    period === 'all'
      ? 'All time'
      : period === 'ytd'
        ? `YTD ${year}`
        : `${period.toUpperCase()} ${year}`;
  const periodPos = useMemo(() => {
    if (period === 'all') return data.pendingPos;
    const bounds: Record<string, [string, string]> = {
      ytd: [`${year}-01-01`, `${year + 1}-01-01`],
      q1: [`${year}-01-01`, `${year}-04-01`],
      q2: [`${year}-04-01`, `${year}-07-01`],
      q3: [`${year}-07-01`, `${year}-10-01`],
      q4: [`${year}-10-01`, `${year + 1}-01-01`],
    };
    const [from, to] = bounds[period];
    return data.pendingPos.filter((p) => {
      const d = (p.po_date ?? p.po_created_date ?? '').slice(0, 10);
      return d >= from && d < to;
    });
  }, [data.pendingPos, period, year]);
  const rows = useMemo(() => {
    const capacityByVendor = new Map(
      (data.vendorCapacity ?? []).map((c) => [
        norm(c.vendor_code),
        { machines: Number(c.machines_allocated) || 0, karigar: Number(c.active_karigar) || 0 },
      ]),
    );
    return buildVendorRollups(
      periodPos,
      data.vendorTypes,
      data.vendorMasters,
      data.tnaRecords,
      today,
      capacityByVendor,
      capacityRules,
    );
  }, [data, periodPos, capacityRules]);
  const openCodes = new Set(rows.map((row) => norm(row.vendorCode)));
  const zero = data.vendorTypes.filter(
    (v) => norm(v.status) === "active" && !openCodes.has(norm(v.vendor_code)),
  );
  // Same period as the rollups — otherwise a Q1 view shows all-time type columns.
  const types = unique(periodPos.map((r) => r.po_type ?? "Unknown"));
  const typeQty = (vendorCode: string, t: string) =>
    periodPos
      .filter(
        (p) =>
          isOpenPo(p) &&
          norm(p.vendor_code) === norm(vendorCode) &&
          (p.po_type ?? "Unknown") === t,
      )
      .reduce((s, p) => s + p.pending_qty_actual, 0);

  // Capacity-load donut: vendors bucketed by open-qty ÷ modelled monthly capacity.
  // Capacity is vendor-level; a vendor split across Woven + Knit rows carries the
  // same figure on each row, so count it once per vendor.
  // PO capacity (the one model), counted once per vendor; "not entered" is left out.
  const totalCap = [...new Map(rows.filter((r) => r.capacityEntered).map((r) => [norm(r.vendorCode) || r.vendorName, r.poCapacity])).values()]
    .reduce((s, c) => s + c, 0);
  const totalOpen = rows.filter((r) => r.capacityEntered).reduce((s, r) => s + r.openQty, 0);
  const overallUtil = totalCap ? Math.round((totalOpen / totalCap) * 100) : 0;
  const utilBands = (() => {
    let over = 0, near = 0, under = 0, noData = 0;
    for (const r of rows) {
      if (!r.capacityEntered || !r.poCapacity) { noData++; continue; }
      const ratio = r.openQty / r.poCapacity;
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
          info={"WHAT: how many vendors the team can currently place orders with.\n\nHOW: vendors marked Active — EasyEcom's status once synced, otherwise the Vendor Type master's status.\n\nUSE: the denominator for 'Nothing on order' beside it."}
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
          info={"WHAT: active vendors with no open PO at all right now.\n\nHOW: active vendors minus vendors that appear on any open PO.\n\nUSE: idle capacity. If the Stock Out Risk list is long and these vendors make the right products (Product Allocation on Vendor Capacity), that is where the next orders can go."}
        />
        <Card
          label="Total monthly capacity"
          value={fmt.format(totalCap)}
          tone="teal"
          info={"WHAT: how many pieces all vendors together can make in a month.\n\nHOW: per vendor, workers × pieces a worker makes a day × working days a month (Rules Master), summed over vendors with an entry. Example: 25 karigars × 20 × 26 = 13,000 a month for one vendor. Utilisation elsewhere is judged on PO capacity (this × lead days ÷ 30), not on this monthly figure.\n\nUSE: read against 'Pending pieces' beside it for a rough months-of-backlog."}
        />
        <Card
          label="Total open PO quantity"
          value={fmt.format(totalOpen)}
          tone="blue"
          info={"WHAT: pieces still to arrive across all open POs.\n\nHOW: ordered − received, summed over every open line.\n\nUSE: the load on vendors. Divide by monthly capacity for a rough 'months of backlog'."}
        />
      </div>
      <div className="bento-grid">
        <ChartCard
          title="Open quantity vs monthly capacity"
          info={"WHAT: per vendor, the pieces on order against what the vendor can make inside its PO type's lead time (PO capacity).\n\nHOW: open-PO pieces (bar) vs PO capacity = capacity/month × lead days ÷ 30, where capacity/month = karigars × daily output × working days (all Rules Master). An E-FOB vendor is judged on 45 days of output, a FOB vendor on 90 — not one month. Over 100% = more on order than that.\n\nUSE: an over-committed vendor will be late on something; decide which PO, rather than let the vendor decide. Under-used vendors are where new orders can go."}
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
                <Bar dataKey="poCapacity" name="PO capacity" fill="#3d9e6b" radius={[4, 4, 0, 0]} />
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
                  text={"WHAT: how vendors are loaded, in four bands.\n\nHOW: open pieces ÷ PO capacity per vendor (what it can make inside its PO type's lead time). Over = above 100%, Near = 70–100%, Under = below 70%, 'No data' = no capacity entered on Vendor Capacity. The centre is the vendor count; the bar is book-wide open pieces ÷ total PO capacity. Bands are editable in Rules Master.\n\nUSE: many in 'No data' means the capacity sheet is not being kept up — fix that before reading the rest."}
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
        info={"WHAT: per vendor, the open pieces split by PO type.\n\nHOW: pending pieces on open POs, stacked by type — Job Work, E-FOB, FOB.\n\nUSE: a vendor carrying mostly Job Work is dependent on SAADAA fabric; a FOB-heavy vendor carries the fabric risk. Useful when deciding where a new PO of each type can go."}
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
                <th>Vendor <HeaderInfo label="Vendor" /></th>
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
      <VendorTypeCharts data={data} capacityRules={capacityRules} />
      <section className="panel table-panel">
        <div className="panel-title">
          <h3>
            Vendor performance
            <InfoDot text={"WHAT: one row per vendor — open and delayed POs, pieces, value, capacity and utilisation.\n\nHOW: rolled up from every open PO line; delayed = past expected delivery date; utilisation = open pieces ÷ monthly capacity.\n\nUSE: the vendor review table. Pick a period and add a remark to print it as the PPM PDF; search, filter and export below."} />
          </h3>
        </div>
        <div className="vendor-report-controls">
          <label className="meta-field">
            <span>Period</span>
            <select
              className="meta-select"
              value={period}
              onChange={(e) => setPeriod(e.target.value as typeof period)}
            >
              <option value="all">All time</option>
              <option value="ytd">Year to date</option>
              <option value="q1">Q1 (Jan–Mar)</option>
              <option value="q2">Q2 (Apr–Jun)</option>
              <option value="q3">Q3 (Jul–Sep)</option>
              <option value="q4">Q4 (Oct–Dec)</option>
            </select>
          </label>
          <label className="meta-field vendor-report-remark">
            <span>Remark (added to the PDF)</span>
            <input
              type="text"
              placeholder="Optional comment for this report…"
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
            />
          </label>
        </div>
        <VendorTable
          rows={rows}
          filename={`vendor-performance-${period}`}
          exportTitle={`Vendor performance — ${periodLabel}`}
          searchPlaceholder="Filter by vendor name or code"
          reportNote={remark}
          withFilters
        />
      </section>
    </>
  );
}

function VendorTypeCharts({ data, capacityRules = DEFAULT_CAPACITY_RULES }: { data: DashboardData; capacityRules?: CapacityRules }) {
  const today = istToday();
  const all = useMemo(
    () =>
      buildVendorRollups(
        data.pendingPos,
        data.vendorTypes,
        data.vendorMasters,
        data.tnaRecords,
        today,
        new Map(),
        capacityRules,
      ),
    [data, capacityRules],
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
                  text={`WHAT: for every ${bucket === "Knit" ? "knitted" : bucket.toLowerCase()} vendor, the pieces on order and how many of them are already late.

HOW: open pieces (full bar) vs pieces on lines past their expected delivery date (darker part).

USE: a vendor whose dark part is most of the bar is late on nearly everything — a vendor conversation, not a PO chase.`}
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
function MerchantTab({ data, capacityRules = DEFAULT_CAPACITY_RULES }: { data: DashboardData; capacityRules?: CapacityRules }) {
  const today = istToday();
  const vendors = useMemo(
    () =>
      buildVendorRollups(
        data.pendingPos,
        data.vendorTypes,
        data.vendorMasters,
        data.tnaRecords,
        today,
        new Map(),
        capacityRules,
      ),
    [data, capacityRules],
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
        poCapacity: 0,
        capacitySigned: 0,
        capacityEntered: false,
        utilizationPct: 0,
      };
      current.openPoCount += row.openPoCount;
      current.delayedPoCount += row.delayedPoCount;
      current.openQty += row.openQty;
      current.openValue += row.openValue;
      current.capacityPerMonth += row.capacityPerMonth;
      current.poCapacity += row.capacityEntered ? row.poCapacity : 0;
      current.capacityEntered = current.capacityEntered || row.capacityEntered;
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
      utilizationPct: row.poCapacity
        ? Math.round((row.openQty / row.poCapacity) * 1000) / 10
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
          info={"WHAT: how many merchandisers currently have vendors with open POs.\n\nHOW: each vendor is managed by one merchandiser (vendor master); count the distinct merchandisers behind the open POs.\n\nUSE: the people whose numbers are on this tab."}
        />
        <Card
          label="Open POs"
          value={fmt.format(totalOpenPo)}
          tone="blue"
          info={"WHAT: open POs across all merchandisers.\n\nHOW: distinct PO numbers with pending quantity, attributed to the merchandiser who manages the vendor.\n\nUSE: the workload being shared out below."}
        />
        <Card
          label="Delayed POs"
          value={fmt.format(totalDelayed)}
          tone="orange"
          info={"WHAT: open POs whose expected delivery date has passed.\n\nHOW: any line on the PO past its EDD with pending quantity.\n\nUSE: the ones to chase this week, by merchandiser."}
        />
        <Card
          label="Open quantity"
          value={fmt.format(totalOpenQty)}
          tone="teal"
          info={"WHAT: pieces still to arrive across all open POs.\n\nHOW: ordered − received, summed over every open line.\n\nUSE: the volume behind the PO count."}
        />
      </div>
      <div className="bento-grid">
        <ChartCard
          title="Open vs delayed by merchant"
          info={"WHAT: per merchandiser, open POs against how many of them are late.\n\nHOW: open POs (bar) and POs past their expected delivery date (orange), attributed through the vendor's merchandiser.\n\nUSE: a tall orange bar is a merchandiser whose vendors are behind — worth a look at whether it is one vendor or all of them."}
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
                  text={"WHAT: the open book split into on time and late.\n\nHOW: late = past expected delivery date with pending quantity; on time = everything else. Centre is total open POs; the bar is the on-time share. Example: 96 open, 30 late → 69% on time.\n\nUSE: the single number for the weekly review."}
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
        info={"WHAT: per merchandiser, pieces still to arrive.\n\nHOW: ordered − received on open lines, attributed through the vendor's merchandiser.\n\nUSE: volume, not count — a merchandiser with few POs can still carry the most pieces."}
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
            <InfoDot text={"WHAT: the vendor table rolled up to the merchandiser who manages each vendor.\n\nHOW: open and delayed POs, pieces, value and capacity summed across each merchandiser's vendors.\n\nUSE: the per-person view of the same book. Search, filter and export below."} />
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
  const today = istToday();
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
          info={"WHAT: how many products have something on order, under the filters above.\n\nHOW: distinct product codes with pending quantity on any open PO line.\n\nUSE: the breadth of what is being bought right now."}
        />
        <Card
          label="Variant rows"
          value={fmt.format(products.length)}
          tone="blue"
          info={"WHAT: how many product-and-colour combinations have something on order.\n\nHOW: distinct product code × variant with pending quantity.\n\nUSE: finer than product codes — a code with six colours on order counts six here."}
        />
        <Card
          label="Open quantity"
          value={fmt.format(summary.reduce((s, r) => s + r.qty, 0))}
          tone="teal"
          info={"WHAT: pieces still to arrive for the products shown.\n\nHOW: ordered − received on open lines, under the filters above.\n\nUSE: the volume behind the counts."}
        />
        <Card
          label="Open value"
          value={money.format(summary.reduce((s, r) => s + r.value, 0))}
          tone="orange"
          info={"WHAT: the money still committed on the products shown.\n\nHOW: pending pieces × item price on open lines, under the filters above.\n\nUSE: where the open value sits, by product."}
        />
      </div>
      <section className="panel table-panel product-table">
        <div className="panel-title">
          <h3>
            Product + variant rollup
            <InfoDot
              text={"WHAT: every product-and-colour combination with something on order — pieces and value.\n\nHOW: pending quantity and pending × price, per product code × variant, after the filters.\n\nUSE: the detail behind the Product Tracker numbers; sort by value to see where the money is."}
              label="About Product + variant rollup"
            />
          </h3>
        </div>
        <FilterTable
          rows={products}
          columns={[
            { key: "productCode", label: "Product code" },
            { key: "variant", label: "Variant" },
            { key: "qty", label: "Pending qty", kind: "num" },
            { key: "value", label: "Pending value", kind: "num", render: (r) => money.format(r.value) },
          ]}
          rowKey={(r) => `${r.productCode}-${r.variant}`}
          defaultSource="easyecom"
          unit="rows"
          searchPlaceholder="Product or variant…"
          emptyText="No products match."
          download={{ filename: "product-variant-rollup" }}
        />
      </section>
      <section className="panel table-panel">
        <div className="panel-title">
          <h3>
            Product code summary
            <InfoDot
              text={"WHAT: one row per product code — how many colours are on order, with pieces and value.\n\nHOW: variants counted, pending pieces and value summed per product code.\n\nUSE: the product-level roll-up; switch to variant view for the colour split."}
              label="About Product code summary"
            />
          </h3>
        </div>
        <FilterTable
          rows={summary}
          columns={[
            { key: "productCode", label: "Product code" },
            { key: "variants", label: "Variants", kind: "num", source: "computed", accessor: (r) => r.variants.size, render: (r) => r.variants.size },
            { key: "qty", label: "Pending qty", kind: "num" },
            { key: "value", label: "Pending value", kind: "num", render: (r) => money.format(r.value) },
          ]}
          rowKey={(r) => r.productCode}
          defaultSource="easyecom"
          unit="products"
          searchPlaceholder="Product code…"
          emptyText="No products match."
          download={{ filename: "product-code-summary" }}
        />
      </section>
    </>
  );
}

function UrgentReplenishmentTab({ data }: { data: DashboardData }) {
  const today = istToday();
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
  /* Arrivals, month by month.

     "Within 365 days" was not a horizon anyone plans against: production runs 60 to 90 days,
     so a year-long window swept in everything and answered nothing. What a buyer needs is
     when goods actually land — this month, next month, the month after — with whatever is
     already late called out first, because that is the part needing a phone call today.

     Anything due beyond the third month is grouped as "Later": at that distance the month is
     a promise, not a plan, and splitting it further implies a precision the dates do not have. */
  const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const monthLabelOf = (d: Date) =>
    d.toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });
  const horizonMonths = [0, 1, 2].map((add) => {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + add, 1));
    return { key: monthKey(d), label: monthLabelOf(d) };
  });
  const arrivalsOpen = tracker.filter((row) => row.pendingQty > 0);
  const arrivalBuckets = [
    { key: "overdue", label: "Already late", qty: 0, lines: 0, tone: "red" },
    ...horizonMonths.map((m, i) => ({
      key: m.key,
      label: i === 0 ? `${m.label} (this month)` : m.label,
      qty: 0,
      lines: 0,
      tone: i === 0 ? "amber" : "teal",
    })),
    { key: "later", label: "Later", qty: 0, lines: 0, tone: "blue" },
    { key: "nodate", label: "No delivery date", qty: 0, lines: 0, tone: "orange" },
  ];
  const bucketOf = (row: (typeof arrivalsOpen)[number]) => {
    if (!row.edd) return "nodate";
    const edd = new Date(row.edd);
    if (edd.getTime() < today.getTime()) return "overdue";
    const k = monthKey(edd);
    return horizonMonths.some((m) => m.key === k) ? k : "later";
  };
  arrivalsOpen.forEach((row) => {
    const b = arrivalBuckets.find((x) => x.key === bucketOf(row));
    if (!b) return;
    b.qty += row.pendingQty;
    b.lines += 1;
  });
  const arrivalsTotal = arrivalBuckets.reduce((sum, b) => sum + b.qty, 0);
  const maxBucketQty = Math.max(1, ...arrivalBuckets.map((b) => b.qty));
  const dueThisMonth = arrivalBuckets.find((b) => b.key === horizonMonths[0].key);
  const lateBucket = arrivalBuckets.find((b) => b.key === "overdue");
  // Products whose PO lines are fully received (nothing left on order) — ranked by
  // how many such lines, most first. The KPI counts all of them; the chart shows 20.
  const productOOSAll = Object.values(
    data.pendingPos
      .filter((p) => p.pending_qty_actual === 0)
      .reduce<
        Record<
          string,
          { productCode: string; count: number; lastVendor: string }
        >
      >((acc, row) => {
        // A PO line with no product code is not a product code — label it for what it is
        // rather than letting it sit silently under a "Product code" heading.
        const key = row.product_code || "(no product code)";
        if (!acc[key])
          acc[key] = { productCode: key, count: 0, lastVendor: "" };
        acc[key].count += 1;
        acc[key].lastVendor = row.vendor_name || "Unknown";
        return acc;
      }, {}),
  ).sort((a, b) => b.count - a.count);
  const productOOS = productOOSAll.slice(0, 20);


  return (
    <>
      <div className="metric-grid compact summary">
        <Card
          label="Arriving this month"
          value={fmt.format(dueThisMonth?.qty ?? 0)}
          note={`pieces due this month${lateBucket?.qty ? ` · ${fmt.format(lateBucket.qty)} already late` : ""}`}
          tone="teal"
          big
          info={"WHAT: how many pieces are due to land this month.\n\nHOW: pending pieces on open lines whose expected delivery date falls inside the current calendar month.\n\nUSE: production runs 60–90 days, so the month is the unit worth planning against. The schedule below shows the months after this one; anything already past its date is separated out there."}
        />
        <Card
          label="Nothing on order"
          value={fmt.format(productOOSAll.length)}
          note="product codes with no pending quantity left"
          tone="orange"
          big
          info={"WHAT: how many PRODUCT CODES have nothing on order — every PO line for them has been fully received.\n\nHOW: product codes where all PO lines are received and no open line remains. It is a count of codes, not POs and not pieces.\n\nMIND: this is NOT a stock figure. A code can have plenty in the warehouse and still be here; it only says no replenishment is in the pipeline. For actual stock-outs use the OOS Dashboard or DOQ Calculation."}
        />
      </div>
      <div className="chart-grid">
        <ChartCard
          title="Arrival schedule — pieces by month"
          kicker="When goods land"
          info={"WHAT: when the open pieces are due to land, month by month.\n\nHOW: pending pieces on open lines grouped by the month of their expected delivery date. Lines already past their date are separated into their own bar; lines with no date at all are shown last.\n\nUSE: the 'past date' bar needs chasing, the months ahead need planning (warehouse space, cash). 'No date' lines cannot be scheduled until a date is set on the PO."}
          download={{
            filename: "arrival-schedule",
            headers: ["When", "Pieces", "PO lines"],
            rows: arrivalBuckets.map((b) => [b.label, b.qty, b.lines]),
          }}
        >
          {arrivalsTotal ? (
            <div className="arrival-schedule">
              {arrivalBuckets.map((b) => (
                <div className={`arrival-row tone-${b.tone}`} key={b.key}>
                  <span className="arrival-when">{b.label}</span>
                  <span className="arrival-bar">
                    <i style={{ width: `${Math.round((b.qty / maxBucketQty) * 100)}%` }} />
                  </span>
                  <span className="arrival-qty">
                    <b>{fmt.format(b.qty)}</b>
                    <small>
                      {fmt.format(b.lines)} line{b.lines === 1 ? "" : "s"}
                      {arrivalsTotal ? ` · ${Math.round((b.qty / arrivalsTotal) * 100)}%` : ""}
                    </small>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <Empty text="Nothing is on order" />
          )}
        </ChartCard>
        <ChartCard
          title="Nothing on order — product codes by fully-received PO lines"
          info={"WHAT: the twenty products with the most fully-received PO lines and nothing left on order.\n\nHOW: per product code, count of PO lines fully received; only codes with no open line remain. The bar is a count of lines, not pieces.\n\nUSE: candidates to check for replenishment — they have been bought before and nothing is coming. Check their stock on the OOS Dashboard before ordering."}
          download={{
            filename: "nothing-on-order",
            headers: ["Product code", "Fully-received PO lines", "Last vendor"],
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
            Arrivals — every open line
            <InfoDot text={"WHAT: every open line still to arrive — product, vendor, pieces, expected date, days late.\n\nHOW: one row per open PO line with pending quantity; delay = today − expected delivery date when past.\n\nUSE: sort or filter to work one month, one vendor, or just the late lines."} />
          </h3>
        </div>
        <FilterTable
          rows={arrivalsOpen}
          columns={[
            { key: "productCode", label: "Product" },
            { key: "vendor", label: "Vendor", accessor: (r) => r.vendorCode || r.vendorName, render: (r) => r.vendorCode || r.vendorName },
            { key: "poRef", label: "PO", kind: "mono" },
            { key: "pendingQty", label: "Qty", kind: "num" },
            { key: "edd", label: "EDD", accessor: (r) => r.edd ?? "", render: (r) => r.edd ?? "No EDD" },
            {
              key: "delayDays", label: "Delay days", kind: "num", source: "computed",
              accessor: (r) => r.delayDays ?? 0,
              render: (r) => (r.delayDays ? <span className="badge danger">{r.delayDays}d</span> : <span className="badge success">On time</span>),
            },
          ]}
          rowKey={(r, i) => `${r.poRef}-${r.productCode}-${i}`}
          defaultSource="easyecom"
          unit="lines"
          searchPlaceholder="Product, vendor, PO…"
          emptyText="Nothing is on order."
          download={{ filename: "arrivals-open-lines" }}
        />
      </section>
    </>
  );
}

function MatrixTab({ data }: { data: DashboardData }) {
  const today = istToday();
  // Item 4 — default MUST be product code (see MATRIX_DEFAULT_MODE + matrix-defaults.test.ts).
  const [mode, setMode] = useState<"variant" | "product">(MATRIX_DEFAULT_MODE);
  // Item 5 — collapse vendor columns that are all-zero in the current view; on by default.
  const [hideEmptyVendors, setHideEmptyVendors] = useState(true);
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
          ? `${row.productCode} · ${sku.product_variant ?? "(no variant)"}`
          : row.productCode;
      const k = `${r}${SEP}${row.vendorCode || row.vendorName}`;
      cells.set(k, (cells.get(k) ?? 0) + sku.pending_qty_actual);
    }),
  );
  const rowNames = unique([...cells.keys()].map((k) => k.split(SEP)[0]));
  // Item 5 — a vendor column is "empty" when every cell in the current filtered view
  // is zero. Hide those (default) so category-level views aren't padded with blank
  // columns; the toggle reveals them if you want to confirm a vendor has zero activity.
  const vendorTotal = (v: string) =>
    rowNames.reduce((s, r) => s + (cells.get(`${r}${SEP}${v}`) ?? 0), 0);
  const displayVendors = hideEmptyVendors
    ? vendors.filter((v) => vendorTotal(v) > 0)
    : vendors;
  const hiddenVendorCount = vendors.length - displayVendors.length;
  const matrixRows: CsvValue[][] = [
    ...rowNames.map((r) => [
      r,
      ...displayVendors.map((v) => cells.get(`${r}${SEP}${v}`) ?? 0),
      displayVendors.reduce((s, v) => s + (cells.get(`${r}${SEP}${v}`) ?? 0), 0),
    ]),
    [
      "Total",
      ...displayVendors.map((v) =>
        rowNames.reduce((s, r) => s + (cells.get(`${r}${SEP}${v}`) ?? 0), 0),
      ),
      displayVendors.reduce((s, v) => s + vendorTotal(v), 0),
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
        <label className="matrix-empty-toggle">
          <input
            type="checkbox"
            checked={hideEmptyVendors}
            onChange={(e) => setHideEmptyVendors(e.target.checked)}
          />
          Hide empty vendor columns
        </label>
      </div>
      <section className="panel table-panel">
        <div className="table-meta">
          <span>
            {fmt.format(rowNames.length)}{" "}
            {mode === "variant" ? "product · variant" : "product"} rows ×{" "}
            {displayVendors.length} vendors
            {hiddenVendorCount > 0 && (
              <span className="wf-subtle"> · {hiddenVendorCount} empty hidden</span>
            )}
          </span>
          <InfoDot
            text={"WHAT: for each product (or product · colour), which vendors are making it and how many pieces each still owes.\n\nHOW: pending pieces on open lines, split by vendor within each product.\n\nUSE: when one vendor is late, this shows whether another vendor already makes the same product and could take the balance. Toggle above to group by colour or by product code."}
            label="About the product matrix"
          />
          <DownloadButton
            filename={
              mode === "variant" ? "matrix-by-variant" : "matrix-by-product"
            }
            headers={[
              mode === "variant" ? "Product · variant" : "Product code",
              ...displayVendors,
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
                  {displayVendors.map((v) => (
                    <th key={v}>{v}</th>
                  ))}
                  <th>Total <HeaderInfo label="Total" /></th>
                </tr>
              </thead>
              <tbody>
                {pagedRowNames.pageRows.map((r) => (
                  <tr key={r}>
                    <td>{r}</td>
                    {displayVendors.map((v) => (
                      <td key={v}>
                        {fmt.format(cells.get(`${r}${SEP}${v}`) ?? 0)}
                      </td>
                    ))}
                    <td>
                      <strong>
                        {fmt.format(
                          displayVendors.reduce(
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
                  {displayVendors.map((v) => (
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
  // Every capacity figure on every tab reads the same Rules Master values.
  const capacityRules = capacityRulesFrom(analyticsRules);
  const [tab, setTab] = useState<TabId>("dashboard");
  const [dashGroup, setDashGroup] = useState<DashGroup>("objectives");
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
    <div className="app-shell ui-shopify">
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
            {role === 'admin' && <FeedbackBell />}
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
              <div className="ana-tabs dash-groups" role="tablist" aria-label="Dashboard views">
                {DASH_GROUPS.map(([id, label], index) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={dashGroup === id}
                    className={dashGroup === id ? "active" : ""}
                    onClick={() => setDashGroup(id)}
                  >
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    {label}
                  </button>
                ))}
              </div>
              {dashGroup === "objectives" || dashGroup === "orders" ? (
                <>
                  <DashboardTab
                    data={data}
                    capacityRules={capacityRules}
                    bucket={bucket}
                    setBucket={setBucket}
                    extras={analyticsExtras}
                    section={dashGroup}
                    onTab={setTab}
                    onHighRisk={setHighRisk}
                    onOverdue={setOverdue}
                    onVendorSelect={openVendorPos}
                    expectedVsActual={analyticsExtras?.expectedVsActual ?? null}
                  />
                  {/* Capital at Risk and Cost Variance render from AnalyticsCards, which owns
                      the tracker maths behind them — rendering them here keeps that one
                      implementation rather than copying it. */}
                  {dashGroup === "objectives" && (
                    <AnalyticsCards
                      data={data}
                      rules={analyticsRules}
                      extras={analyticsExtras}
                      onTab={setTab}
                      isAdmin={role === "admin"}
                      only="money"
                    />
                  )}
                </>
              ) : (
                <AnalyticsCards
                  data={data}
                  rules={analyticsRules}
                  extras={analyticsExtras}
                  onTab={setTab}
                  isAdmin={role === "admin"}
                  only={dashGroup}
                />
              )}
            </>
          )}{" "}
          {tab === "open-po" && <TrackerTab data={data} closures={closures} onView={setDetail} initialVendorCode={vendorFilter} />}{" "}
          {tab === "vendors" && <VendorTab data={data} capacityRules={capacityRules} />}{" "}
          {tab === "merchants" && <MerchantTab data={data} capacityRules={capacityRules} />}{" "}
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

          {/* Headings coined in this dashboard — the ones that exist nowhere in the base
              data, so nobody has heard them in a meeting. Trade terms (DOQ, EE, TNA, FOB and
              the rest) are what the team says every day and are deliberately left alone. */}
          <div className="glossary">
            <h3 className="glossary-head">Names used only in this dashboard</h3>
            <p className="glossary-intro">
              Everyday terms like DOQ, EE and TNA mean what they always mean. These are the
              headings this dashboard introduced, and what each one actually counts.
            </p>
            <dl className="glossary-list">
              {COINED_TERMS.map((t) => (
                <div className="glossary-item" key={t.term}>
                  <dt>
                    {t.term}
                    <span className="glossary-expansion">{t.where}</span>
                  </dt>
                  <dd>
                    {t.meaning}
                    {t.basedOn && <small> Built from {t.basedOn}.</small>}
                  </dd>
                </div>
              ))}
            </dl>
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
                  <th>SKU <HeaderInfo label="SKU" /></th>
                  <th>Variant <HeaderInfo label="Variant" /></th>
                  <th>Size <HeaderInfo label="Size" /></th>
                  <th>Original <HeaderInfo label="Original" /></th>
                  <th>Pending actual <HeaderInfo label="Pending actual" /></th>
                  <th>Price <HeaderInfo label="Price" /></th>
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
                      <th>PO <HeaderInfo label="PO" /></th>
                      <th>Vendor <HeaderInfo label="Vendor" /></th>
                      <th>SKU <HeaderInfo label="SKU" /></th>
                      <th>EDD <HeaderInfo label="EDD" /></th>
                      <th>Original <HeaderInfo label="Original" /></th>
                      <th>Pending <HeaderInfo label="Pending" /></th>
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
                      <th>PO <HeaderInfo label="PO" /></th>
                      <th>Vendor <HeaderInfo label="Vendor" /></th>
                      <th>SKU <HeaderInfo label="SKU" /></th>
                      <th>EDD <HeaderInfo label="EDD" /></th>
                      <th>Original <HeaderInfo label="Original" /></th>
                      <th>Pending <HeaderInfo label="Pending" /></th>
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
      <ReportButton />
    </div>
  );
}
