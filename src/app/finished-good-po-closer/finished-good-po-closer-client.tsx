'use client';

import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Download,
  Eye,
  FileCheck2,
  Filter,
  RefreshCw,
  Search,
  Upload,
  UserCheck,
  X,
  XCircle,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import {
  decideFgFounder,
  saveFgWorkflowSubmission,
} from '@/lib/forms/actions-modules/fg-closer';

type ClosureStatus =
  | 'Ready for closer'
  | 'Merchandise Review'
  | 'Accounts Review'
  | 'Founder Review'
  | 'Closed';

type Department = 'Merchandise' | 'Accounts';

type ClosureRequest = {
  id: number;
  po_id: number;
  po_ref_num: string | null;
  po_number: number | null;
  status: ClosureStatus;
  initiated_by: string | null;
  initiated_at: string | null;
  merchandise_review: Record<string, unknown> | string | null;
  merchandise_document_path: string | null;
  merchandise_document_name: string | null;
  merchandise_reviewed_by: string | null;
  merchandise_reviewed_at: string | null;
  accounts_review: Record<string, unknown> | string | null;
  accounts_document_path: string | null;
  accounts_document_name: string | null;
  accounts_reviewed_by: string | null;
  accounts_reviewed_at: string | null;
  founder_review: string | null;
  founder_approved_by: string | null;
  founder_approved_at: string | null;
  updated_at: string | null;
  merchandise_submitted?: boolean;
  accounts_submitted?: boolean;
};

type FgPoRow = {
  [key: string]: unknown;
  po_id: number | null;
  po_ref_num: string | null;
  po_number: number | null;
  po_date: string | null;
  expected_delivery_date: string | null;
  vendor_name: string | null;
  vendor_code: string | null;
  po_created_warehouse: string | null;
  po_status: string | null;
  po_qty: number | null;
  cutting_qty: number | null;
  po_to_cutting_variance: number | null;
  po_to_cutting_pct: number | null;
  grn_qty: number | null;
  pending_qty: number | null;
  cutting_to_grn_variance: number | null;
  cutting_to_grn_pct: number | null;
  last_grn_date: string | null;
  grn_count: number | null;
  avg_shipment_size: number | null;
  avg_grn_tat_days: number | null;
  vendor_delay_days: number | null;
  pp_delay_days: number | null;
  gpt_delay_days: number | null;
  inline_qc_delay_days: number | null;
  sku_count: number | null;
  rg_out_qty: number | null;
  rg_out_serial_count: number | null;
  rg_in_qty: number | null;
  rg_in_serial_count: number | null;
  rejection_rate: number | null;
  rg_matched_serial_count: number | null;
  avg_rg_tat_days: number | null;
  min_rg_tat_days: number | null;
  max_rg_tat_days: number | null;
  is_eligible: boolean | null;
  skus: string | null;
  sku: string | null;
  product_description: string | null;
  cp_id: string | null;
  po_detail_id: string | null;
  size: string | null;
  po_created_location_key: string | null;
  po_created_warehouse_c_id: string | null;
  po_created_date: string | null;
  item_price: number | null;
  product_descriptions: string | null;
  cp_ids: string | null;
  po_detail_ids: string | null;
  original_quantity: number | null;
  pending_quantity: number | null;
  sizes: string | null;
  source_po_statuses: string | null;
  po_created_location_keys: string | null;
  po_created_warehouse_c_ids: string | null;
  completed_at_timestamp: string | null;
};

type GrnSummaryRow = {
  grn: string | number | null;
  vdNum: string | null;
  grnDate: string | null;
  qty: number | null;
  poCloserDate: string | null;
  delayDays: number | null;
  delayChargeRate: number | null;
  delayAmount: number | null;
  ratePerPcs: number | null;
  amount: number | null;
  amountWithGst: number | null;
  vendorInvoiceNumber: string | null;
  invoiceAmount: number | null;
  rgOutPcs: number | null;
  rgOutBusyDate: string | null;
  rgOutBusyAmount: number | null;
  rgInPcs: number | null;
  rgInBusyDate: string | null;
  rgInBusyAmount: number | null;
  dgPcs: number | null;
  dgEntryDate: string | null;
  dgDnAmount: number | null;
  fabricDate: string | null;
  fabricAmount: number | null;
  trimsDate: string | null;
  trimsAmount: number | null;
};

type PenaltyGrnItem = {
  po_id: number | null;
  sku: string | null;
  grn_created_date: string | null;
  grn_receive_quantity: number | null;
};

type PenaltyRgOutItem = {
  sku: string | null;
  qc_fail_reason: string | null;
};

type FabricDetailRow = {
  rmSku: string;
  receivedPcs: number | null;
  rmIssued: number | null;
  rmReturn: number | null;
  netRmIssued: number | null;
  rmAmount: number | null;
  stdAvg: number | null;
  achAvg: number | null;
  stdRm: number | null;
  achAvgRm: number | null;
  rmUsedForPartChange: number | null;
  totalRmUsed: number | null;
  diffInRm: number | null;
  diffInPct: number | null;
  uwfFabric: number | null;
  uwfAmount: number | null;
  scrapRecd: number | null;
  scrapAmount: number | null;
  netFabUses: number | null;
  fabricLoss: number | null;
  fabricLossPct: number | null;
};


const supabase = createClient();
const PAGE_SIZE = 100;

const SUMMARY_SELECT_COLUMNS = '*';

const STATUS_FILTERS: ClosureStatus[] = [
  'Ready for closer',
  'Merchandise Review',
  'Accounts Review',
  'Founder Review',
  'Closed',
];

function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '—';
  }

  return new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: 2,
  }).format(Number(value));
}

function formatDate(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().slice(0, 10);
}

/** Render legacy review remarks safely when the database column contains JSONB. */
function formatReviewValue(value: unknown, fallback = ''): string {
  if (value == null || value === '') return fallback;
  if (typeof value === 'string') return value.trim() || fallback;
  if (Array.isArray(value)) {
    const lines = value.map((item) => formatReviewValue(item)).filter(Boolean);
    return lines.length ? lines.join('\n') : fallback;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const lines: string[] = [];
    Object.entries(record).forEach(([key, child]) => {
      if (child == null || child === '') return;
      if (typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean') {
        const label = key === 'additional_remarks' ? 'Additional remarks' : key.replace(/^penalty:/i, '').replace(/[:_]+/g, ' ').replace(/\s+/g, ' ').trim();
        lines.push(`${label}: ${String(child)}`);
      } else {
        const nested = formatReviewValue(child);
        if (nested) lines.push(`${key}: ${nested}`);
      }
    });
    return lines.join('\n') || JSON.stringify(value, null, 2) || fallback;
  }
  return String(value);
}

function isCompletedPO(po: FgPoRow) {
  return String(po.po_status ?? '').trim().toLowerCase() === 'completed';
}

function isDepartmentSubmitted(po: FgPoRow | null, department: Department) {
  if (!po) return false;
  const column = department === 'Merchandise'
    ? 'Merchandise Submission'
    : 'Accounts Submission';
  const value = po[column];
  return value === true || String(value).trim().toLowerCase() === 'true';
}

function StatusBadge({ status }: { status: ClosureStatus }) {
  const config = {
    'Ready for closer': {
      icon: Clock3,
      className: 'fg-status fg-status-ready',
    },
    'Merchandise Review': {
      icon: FileCheck2,
      className: 'fg-status fg-status-merchandise',
    },
    'Accounts Review': {
      icon: FileCheck2,
      className: 'fg-status fg-status-accounts',
    },
    'Founder Review': {
      icon: UserCheck,
      className: 'fg-status fg-status-founder',
    },
    Closed: {
      icon: CheckCircle2,
      className: 'fg-status fg-status-closed',
    },
  }[status];

  const Icon = config.icon;

  return (
    <span className={config.className}>
      <Icon size={14} />
      {status}
    </span>
  );
}

function NotEligibleBadge() {
  return (
    <span className="fg-status fg-status-not-eligible">
      <XCircle size={14} />
      Not Eligible
    </span>
  );
}

const SUMMARY_TABLE_COLUMNS = [
  'po_id', 'po_ref_num', 'po_number', 'po_date', 'expected_delivery_date',
  'vendor_name', 'vendor_code', 'po_created_warehouse', 'po_status', 'po_qty',
  'cutting_qty', 'grn_qty', 'pending_qty', 'po_to_cutting_variance',
  'po_to_cutting_pct', 'cutting_to_grn_variance', 'cutting_to_grn_pct',
  'last_grn_date', 'grn_count', 'avg_shipment_size', 'avg_grn_tat_days',
  'vendor_delay_days', 'pp_delay_days', 'gpt_delay_days', 'inline_qc_delay_days',
  'sku_count', 'is_eligible', 'rg_out_qty', 'rg_out_serial_count', 'rg_in_qty',
  'rg_in_serial_count', 'rejection_rate', 'rg_matched_serial_count',
  'avg_rg_tat_days', 'min_rg_tat_days', 'max_rg_tat_days',
] as const;

const SUMMARY_TABLE_LABELS: Record<(typeof SUMMARY_TABLE_COLUMNS)[number], string> = {
  po_id: 'po_id',
  po_ref_num: 'po_ref_num',
  po_number: 'po_number',
  po_date: 'po_date',
  expected_delivery_date: 'expected_delivery_date',
  vendor_name: 'vendor_name',
  vendor_code: 'vendor_code',
  po_created_warehouse: 'po_created_warehouse',
  po_status: 'po_status',
  po_qty: 'po_qty',
  cutting_qty: 'cutting_qty',
  grn_qty: 'grn_qty',
  pending_qty: 'pending_qty',
  po_to_cutting_variance: 'po_to_cutting_variance',
  po_to_cutting_pct: 'po_to_cutting_pct',
  cutting_to_grn_variance: 'cutting_to_grn_variance',
  cutting_to_grn_pct: 'cutting_to_grn_pct',
  last_grn_date: 'last_grn_date',
  grn_count: 'grn_count',
  avg_shipment_size: 'avg_shipment_size',
  avg_grn_tat_days: 'avg_grn_tat_days',
  vendor_delay_days: 'vendor_delay_days',
  pp_delay_days: 'pp_delay_days',
  gpt_delay_days: 'gpt_delay_days',
  inline_qc_delay_days: 'inline_qc_delay_days',
  sku_count: 'sku_count',
  is_eligible: 'is_eligible',
  rg_out_qty: 'rg_out_qty',
  rg_out_serial_count: 'rg_out_serial_count',
  rg_in_qty: 'rg_in_qty',
  rg_in_serial_count: 'rg_in_serial_count',
  rejection_rate: 'rejection_rate',
  rg_matched_serial_count: 'rg_matched_serial_count',
  avg_rg_tat_days: 'avg_rg_tat_days',
  min_rg_tat_days: 'min_rg_tat_days',
  max_rg_tat_days: 'max_rg_tat_days',
};

function getDisplayColumns(row: Record<string, unknown>) {
  return Object.keys(row).filter((column) => !['skus', 'cp_ids', 'po_detail_ids', 'product_descriptions'].includes(column));
}

function getTableColumns(row: Record<string, unknown>) {
  const columns = getDisplayColumns(row);
  const poRefIndex = columns.indexOf('po_ref_num');
  const withoutPoRef = poRefIndex === -1
    ? columns
    : columns.filter((column) => column !== 'po_ref_num');
  const completedIndex = withoutPoRef.indexOf('completed_at_timestamp');

  if (completedIndex === -1) {
    return [
      ...(poRefIndex === -1 ? [] : ['po_ref_num']),
      ...withoutPoRef,
      '__fg_action__',
    ];
  }

  return [
    ...(poRefIndex === -1 ? [] : ['po_ref_num']),
    ...withoutPoRef.slice(0, completedIndex + 1),
    '__fg_action__',
    ...withoutPoRef.slice(completedIndex + 1),
  ];
}

function formatSummaryTableValue(key: (typeof SUMMARY_TABLE_COLUMNS)[number], value: unknown) {
  if (value === null || value === undefined || value === '') return '—';
  if (key === 'po_date' || key === 'expected_delivery_date' || key === 'last_grn_date') {
    return formatDate(String(value));
  }
  if (key === 'is_eligible') return value ? 'true' : 'false';
  if (typeof value === 'number') return formatNumber(value);
  return String(value);
}

type FinishedGoodPoCloserClientProps = {
  userEmail: string;
};

export function FinishedGoodPoCloserClient({ userEmail }: FinishedGoodPoCloserClientProps) {
  const [pos, setPos] = useState<FgPoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [activeFilter, setActiveFilter] =
    useState<ClosureStatus>('Ready for closer');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState<number | null>(null);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [readyCount, setReadyCount] = useState<number | null>(null);
  const [selectedPO, setSelectedPO] = useState<FgPoRow | null>(null);
  const [skuRows, setSkuRows] = useState<FgPoRow[]>([]);
  const [skuLoading, setSkuLoading] = useState(false);
  const [fabricRows, setFabricRows] = useState<FabricDetailRow[]>([]);
  const [fabricLoading, setFabricLoading] = useState(false);
  const [grnRows, setGrnRows] = useState<GrnSummaryRow[]>([]);
  const [penaltyGrnItems, setPenaltyGrnItems] = useState<PenaltyGrnItem[]>([]);
  const [penaltyRgOutItems, setPenaltyRgOutItems] = useState<PenaltyRgOutItem[]>([]);
  const [grnLoading, setGrnLoading] = useState(false);
  const [selectedDepartment, setSelectedDepartment] = useState<Department | null>(null);
  // Founder Review must render even when no department is selected in state.
  const founderReviewDepartment: Department = selectedDepartment ?? 'Accounts';
  const [reviewMode, setReviewMode] = useState<'chooser' | 'review' | 'founder' | null>(null);
  const [reviewReadOnly, setReviewReadOnly] = useState(false);
  const [founderEditing, setFounderEditing] = useState(false);
  const [founderMerchandiseRemarks, setFounderMerchandiseRemarks] = useState<Record<string, string>>({});
  const [founderReviewRemarks, setFounderReviewRemarks] = useState<Record<string, string>>({});
  const [founderMerchandiseText, setFounderMerchandiseText] = useState('');
  const [selectedFounderMerchandiseDocument, setSelectedFounderMerchandiseDocument] = useState<File | null>(null);
  const [latestSubmissionByPoRef, setLatestSubmissionByPoRef] = useState<{
    Merchandise: Record<string, Record<string, unknown>>;
    Accounts: Record<string, Record<string, unknown>>;
  }>({ Merchandise: {}, Accounts: {} });
  const [workflowByPoRef, setWorkflowByPoRef] = useState<Record<string, ClosureRequest>>({});
  const [workflowCounts, setWorkflowCounts] = useState({
    merchandise: 0,
    accounts: 0,
    founder: 0,
    closed: 0,
  });
  const [reviewText, setReviewText] = useState('');
  const [reviewRemarks, setReviewRemarks] = useState<Record<string, string>>({});
  const [skuCellSelection, setSkuCellSelection] = useState<Set<string>>(new Set());
  const [skuSelectionAnchor, setSkuSelectionAnchor] = useState<{ row: number; col: number } | null>(null);
  const [skuSelecting, setSkuSelecting] = useState(false);
  const [selectedDocument, setSelectedDocument] = useState<File | null>(null);
  const [founderComment, setFounderComment] = useState('');
  const [savingReview, setSavingReview] = useState(false);
  const [approvingFounder, setApprovingFounder] = useState(false);
  const [workflowMessage, setWorkflowMessage] = useState('');
  const [workflowError, setWorkflowError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedVendors, setSelectedVendors] = useState<string[]>([]);
  const [vendorMenuOpen, setVendorMenuOpen] = useState(false);
  const [dateSortColumn, setDateSortColumn] = useState<string | null>('po_date');
  const [dateSortDirection, setDateSortDirection] = useState<'asc' | 'desc'>('desc');
  const [dateMenuColumn, setDateMenuColumn] = useState<string | null>(null);
  const [dateMenuPosition, setDateMenuPosition] = useState({ top: 0, left: 0 });

  /*
   * IMPORTANT:
   * The Supabase client is module-scoped above. Do not create a new client
   * inside this component. Creating a new client on every render makes the
   * useEffect dependency change after every state update and can repeatedly
   * fire the same expensive view query until Postgres returns:
   * "canceling statement due to statement timeout".
   */

  const pageQueryKey = `${page}|${search}|${activeFilter}|${selectedVendors.join(',')}|${dateSortColumn ?? ''}|${dateSortDirection}|${reloadKey}`;

  useEffect(() => {
    let cancelled = false;

    async function loadWorkflowState() {
      try {
        const [requestResult, merchandiseResult, accountsResult] = await Promise.all([
          supabase
            .schema('FG Closer')
            .from('fg_po_closure_requests')
            .select(`
              id,
              po_id,
              po_ref_num,
              po_number,
              status,
              initiated_by,
              initiated_at,
              merchandise_review,
              merchandise_document_path,
              merchandise_document_name,
              merchandise_reviewed_by,
              merchandise_reviewed_at,
              accounts_review,
              accounts_document_path,
              accounts_document_name,
              accounts_reviewed_by,
              accounts_reviewed_at,
              founder_review,
              founder_approved_by,
              founder_approved_at,
              updated_at
            `),
          supabase
            .schema('FG Closer')
            .from('fg_merchandise_submissions')
            .select('*'),
          supabase
            .schema('FG Closer')
            .from('fg_accounts_submissions')
            .select('*'),
        ]);

        if (cancelled) return;

        if (requestResult.error) throw requestResult.error;
        if (merchandiseResult.error) throw merchandiseResult.error;
        if (accountsResult.error) throw accountsResult.error;

        const requests = (requestResult.data ?? []) as ClosureRequest[];
        const merchandiseRows = (merchandiseResult.data ?? []) as Array<Record<string, unknown>>;
        const accountsRows = (accountsResult.data ?? []) as Array<Record<string, unknown>>;

        const latestByPoRef = (rows: Array<Record<string, unknown>>) => {
          const latest = new Map<string, Record<string, unknown>>();

          rows.forEach((row) => {
            const ref = String(row.po_ref_num ?? '').trim();
            if (!ref) return;

            const current = latest.get(ref);
            if (!current) {
              latest.set(ref, row);
              return;
            }

            const currentRevision = Number(current.revision_no ?? 0);
            const nextRevision = Number(row.revision_no ?? 0);
            const currentTime = new Date(String(current.submitted_at ?? '')).getTime() || 0;
            const nextTime = new Date(String(row.submitted_at ?? '')).getTime() || 0;

            if (nextRevision > currentRevision || (nextRevision === currentRevision && nextTime > currentTime)) {
              latest.set(ref, row);
            }
          });

          return latest;
        };

        const latestMerchandise = latestByPoRef(merchandiseRows);
        const latestAccounts = latestByPoRef(accountsRows);
        setLatestSubmissionByPoRef({
          Merchandise: Object.fromEntries(latestMerchandise),
          Accounts: Object.fromEntries(latestAccounts),
        });
        const map: Record<string, ClosureRequest> = {};
        const allRefs = new Set<string>([
          ...requests.map((row) => String(row.po_ref_num ?? '').trim()).filter(Boolean),
          ...Array.from(latestMerchandise.keys()),
          ...Array.from(latestAccounts.keys()),
        ]);

        allRefs.forEach((ref) => {
          const request = requests.find((row) => String(row.po_ref_num ?? '').trim() === ref);
          const merchandiseSubmission = latestMerchandise.get(ref);
          const accountsSubmission = latestAccounts.get(ref);

          const baseRow: ClosureRequest = request ?? {
            id: Number(merchandiseSubmission?.request_id ?? accountsSubmission?.request_id ?? 0),
            po_id: Number(merchandiseSubmission?.po_id ?? accountsSubmission?.po_id ?? 0),
            po_ref_num: ref,
            po_number: Number(merchandiseSubmission?.po_number ?? accountsSubmission?.po_number ?? 0) || null,
            status: 'Ready for closer',
            initiated_by: null,
            initiated_at: null,
            merchandise_review: null,
            merchandise_document_path: null,
            merchandise_document_name: null,
            merchandise_reviewed_by: null,
            merchandise_reviewed_at: null,
            accounts_review: null,
            accounts_document_path: null,
            accounts_document_name: null,
            accounts_reviewed_by: null,
            accounts_reviewed_at: null,
            founder_review: null,
            founder_approved_by: null,
            founder_approved_at: null,
            updated_at: null,
          };

          const hasMerchandise = Boolean(merchandiseSubmission);
          const hasAccounts = Boolean(accountsSubmission);
          const merchandiseRevision = Number(merchandiseSubmission?.revision_no ?? 0);
          const accountsRevision = Number(accountsSubmission?.revision_no ?? 0);
          const merchandiseTime = new Date(String(merchandiseSubmission?.submitted_at ?? '')).getTime() || 0;
          const accountsTime = new Date(String(accountsSubmission?.submitted_at ?? '')).getTime() || 0;
          const accountsIsCurrent = hasAccounts && (
            !hasMerchandise ||
            accountsRevision > merchandiseRevision ||
            (accountsRevision === merchandiseRevision && accountsTime >= merchandiseTime)
          );

          // The closure-request status is the authoritative routing state.
          // Submission tables are snapshots/history; they must never silently
          // advance the PO to the next department just because a snapshot exists.
          // This is what keeps:
          //   Merchandise selected -> Merchandise Review
          //   Accounts selected    -> Accounts Review
          // and lets the View action explicitly move the workflow when the
          // current department submits its review.
          let derivedStatus: ClosureStatus;
          if (request) {
            derivedStatus = request.status;
          } else if (accountsIsCurrent) {
            // Fallback only for legacy rows where a closure request is missing.
            derivedStatus = 'Accounts Review';
          } else if (hasMerchandise) {
            derivedStatus = 'Merchandise Review';
          } else {
            derivedStatus = 'Ready for closer';
          }

          map[ref] = {
            ...baseRow,
            status: derivedStatus,
            merchandise_submitted: hasMerchandise,
            accounts_submitted: hasAccounts,
          };
        });

        let closedCount = 0;

        Object.values(map).forEach((row) => {
          if (row.status === 'Closed') closedCount += 1;
        });

        setWorkflowByPoRef(map);
        // Founder eligibility is calculated from both submission flags in
        // v_fg_po_summary. Closed POs remain in Closed and are excluded.
        setWorkflowCounts((current) => ({
          ...current,
          closed: closedCount,
        }));
      } catch (workflowLoadError) {
        if (cancelled) return;
        console.error('Failed to load FG closure workflow:', workflowLoadError);
        setWorkflowError(
          workflowLoadError instanceof Error
            ? workflowLoadError.message
            : 'Failed to load closure workflow.'
        );
      }
    }

    loadWorkflowState();

    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  useEffect(() => {
    let cancelled = false;

    async function loadPage() {
      setLoading(true);
      setError('');
      setTotal(null);
      setHasNextPage(false);

      try {
        const from = (page - 1) * PAGE_SIZE;
        const to = from + PAGE_SIZE - 1;

        // Closed rows must come from the immutable approval snapshot table,
        // not from v_fg_po_summary (which can omit POs after their workflow
        // status changes). The PO snapshot preserves the original summary row.
        if (activeFilter === 'Closed') {
          const { data: closedRecords, error: closedQueryError } = await supabase
            .schema('FG Closer')
            .from('fg_closed_po')
            .select('id, request_id, po_ref_num, po_id, po_number, po_snapshot, merchandise_sku_snapshot, merchandise_operational_snapshot, merchandise_data, merchandise_review_remarks, merchandise_document_path, merchandise_document_name, grn_snapshot, commercial_snapshot, accounts_data, accounts_review_remarks, accounts_document_path, accounts_document_name, approved_by_name, approved_by_email, approved_at, approval_remarks')
            .order('approved_at', { ascending: false });

          if (cancelled) return;
          if (closedQueryError) throw closedQueryError;

          // Recover visibility for POs whose status was changed to Closed
          // before their snapshot insert succeeded. Prefer the immutable
          // closed_po snapshot when present; use the summary view only as a
          // fallback so these already-approved POs are not lost from the UI.
          const closedRefsFromWorkflow = (Object.values(workflowByPoRef) as ClosureRequest[])
            .filter((row) => row.status === 'Closed')
            .map((row) => String(row.po_ref_num ?? '').trim())
            .filter(Boolean);
          const savedClosedRefs = new Set(
            (closedRecords ?? []).map((record) => String(record.po_ref_num ?? '').trim()).filter(Boolean),
          );
          const missingSnapshotRefs = closedRefsFromWorkflow.filter((ref) => !savedClosedRefs.has(ref));
          let fallbackSummaryRows: FgPoRow[] = [];
          if (missingSnapshotRefs.length > 0) {
            const { data: fallbackRows, error: fallbackError } = await supabase
              .schema('FG Closer')
              .from('v_fg_po_summary')
              .select(SUMMARY_SELECT_COLUMNS)
              .in('po_ref_num', missingSnapshotRefs);
            if (cancelled) return;
            if (fallbackError) throw fallbackError;
            fallbackSummaryRows = (fallbackRows ?? []).map((row) => ({
              ...(row as FgPoRow),
              po_status: 'Closed',
            }));
          }

          const closedRows = (closedRecords ?? []).map((record) => {
            let snapshot: Record<string, unknown> = {};
            const rawSnapshot = record.po_snapshot;
            if (rawSnapshot && typeof rawSnapshot === 'object' && !Array.isArray(rawSnapshot)) {
              snapshot = rawSnapshot as Record<string, unknown>;
            } else if (typeof rawSnapshot === 'string') {
              try {
                const parsed = JSON.parse(rawSnapshot);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                  snapshot = parsed as Record<string, unknown>;
                }
              } catch {
                // Use the fallback row below when a legacy snapshot is malformed.
              }
            }

            return {
              ...snapshot,
              po_ref_num: String(record.po_ref_num ?? snapshot.po_ref_num ?? '').trim(),
              po_id: (record.po_id ?? snapshot.po_id ?? null) as number | null,
              po_number: (record.po_number ?? snapshot.po_number ?? null) as number | null,
              po_status: 'Closed',
              // Keep the full submitted snapshots attached to the row so the
              // Closed > View modal can render the same review cards as Founder Review.
              merchandise_sku_snapshot: record.merchandise_sku_snapshot ?? null,
              merchandise_operational_snapshot: record.merchandise_operational_snapshot ?? null,
              merchandise_data: record.merchandise_data ?? null,
              merchandise_review_remarks: record.merchandise_review_remarks ?? null,
              merchandise_document_path: record.merchandise_document_path ?? null,
              merchandise_document_name: record.merchandise_document_name ?? null,
              grn_snapshot: record.grn_snapshot ?? null,
              commercial_snapshot: record.commercial_snapshot ?? null,
              accounts_data: record.accounts_data ?? null,
              accounts_review_remarks: record.accounts_review_remarks ?? null,
              accounts_document_path: record.accounts_document_path ?? null,
              accounts_document_name: record.accounts_document_name ?? null,
              approved_by_name: record.approved_by_name ?? null,
              approved_by_email: record.approved_by_email ?? null,
              approval_remarks: record.approval_remarks ?? null,
              founder_approved_at: record.approved_at ?? snapshot.founder_approved_at ?? null,
            } as FgPoRow;
          }).concat(fallbackSummaryRows).filter((row) => {
            const poRef = String(row.po_ref_num ?? '').toLowerCase();
            const vendor = String(row.vendor_name ?? '').toLowerCase();
            const matchesSearch = !search.trim() || poRef.includes(search.trim().toLowerCase()) || vendor.includes(search.trim().toLowerCase());
            const matchesVendor = selectedVendors.length === 0 || selectedVendors.includes(String(row.vendor_name ?? ''));
            return Boolean(row.po_ref_num) && matchesSearch && matchesVendor;
          });

          const sortedClosedRows = [...closedRows].sort((a, b) => {
            const key = dateSortColumn || 'po_date';
            const aValue = String(a[key] ?? '');
            const bValue = String(b[key] ?? '');
            const comparison = aValue.localeCompare(bValue, undefined, { numeric: true });
            return dateSortDirection === 'asc' ? comparison : -comparison;
          });

          if (!cancelled) {
            setPos(sortedClosedRows.slice(from, to + 1));
            setTotal(sortedClosedRows.length);
            setHasNextPage(false);
            setLoading(false);
          }
          return;
        }

        // A PO stays in Ready for closer after the first department submits.
        // Remove it only after BOTH departments have submitted, or when it has
        // entered the later Founder/Closed stages (which remain unchanged).
        const readyExcludedRefs = (Object.values(workflowByPoRef) as ClosureRequest[])
          .filter((row) =>
            (row.merchandise_submitted === true && row.accounts_submitted === true) ||
            row.status === 'Founder Review' ||
            row.status === 'Closed'
          )
          .map((row) => String(row.po_ref_num ?? '').trim())
          .filter(Boolean);

        // The frontend is intentionally backed only by the PO summary view.
        // We select '*' so every column exposed by v_fg_po_summary is shown
        // without maintaining a second, hard-coded frontend column list.
        // Do not request count: 'exact'. The summary is an aggregated view and
        // exact PostgREST counts can force a full view evaluation and hit the
        // database statement timeout. Pagination uses page-size detection.
        let query = supabase
          .schema('FG Closer')
          .from('v_fg_po_summary')
          .select(SUMMARY_SELECT_COLUMNS);

        const searchQuery = search.trim();

        if (searchQuery) {
          const safeSearch = searchQuery
            .replace(/[(),]/g, ' ')
            .trim();

          if (safeSearch) {
            query = query.or(
              `po_ref_num.ilike.%${safeSearch}%,vendor_name.ilike.%${safeSearch}%`,
            );
          }
        }

        if (selectedVendors.length > 0) {
          query = query.in('vendor_name', selectedVendors);
        }

        if (activeFilter === 'Ready for closer') {
          query = query.eq('is_eligible', true);
          if (readyExcludedRefs.length > 0) {
            const escapedRefs = readyExcludedRefs.map((ref) => `\"${ref.replace(/\"/g, '\\"')}\"`);
            query = query.not('po_ref_num', 'in', `(${escapedRefs.join(',')})`);
          }
          // Do not filter out a PO after only one department submits.
          // readyExcludedRefs removes it only when BOTH flags are true.
        } else if (activeFilter === 'Merchandise Review') {
          query = query.eq('Merchandise Submission', true);
        } else if (activeFilter === 'Accounts Review') {
          query = query.eq('Accounts Submission', true);
        } else if (activeFilter === 'Founder Review') {
          // Automatic Founder Review eligibility: BOTH departments submitted.
          // Closed POs stay in Closed.
          query = query
            .eq('Merchandise Submission', true)
            .eq('Accounts Submission', true);

          const closedRefs = (Object.values(workflowByPoRef) as ClosureRequest[])
            .filter((row) => row.status === 'Closed')
            .map((row) => String(row.po_ref_num ?? '').trim())
            .filter(Boolean);

          if (closedRefs.length > 0) {
            const escapedClosedRefs = closedRefs.map((ref) => `\"${ref.replace(/\"/g, '\\\"')}\"`);
            query = query.not('po_ref_num', 'in', `(${escapedClosedRefs.join(',')})`);
          }
        } else {
          const statusRefs = (Object.values(workflowByPoRef) as ClosureRequest[])
            .filter((row) => row.status === 'Closed')
            .map((row) => String(row.po_ref_num ?? '').trim())
            .filter(Boolean);

          if (statusRefs.length === 0) {
            if (!cancelled) {
              setPos([]);
              setTotal(0);
              setHasNextPage(false);
              setLoading(false);
            }
            return;
          }

          query = query.in('po_ref_num', statusRefs);
        }

        const primarySortColumn = dateSortColumn || 'po_date';

        const { data, error: queryError } = await query
          .order(primarySortColumn, { ascending: dateSortDirection === 'asc' })
          .order('po_id', { ascending: false })
          .range(from, to);

        if (cancelled) return;

        if (queryError) {
          console.error('Failed to load FG purchase orders:', queryError);
          setError(
            queryError.message ||
              'Failed to load Finished Good purchase orders.'
          );
          setPos([]);
          return;
        }

        const rows = (data ?? []) as FgPoRow[];
        setPos(rows);

        // Exact total is intentionally not calculated for this expensive view.
        setTotal(null);
        setHasNextPage(rows.length === PAGE_SIZE);
      } catch (loadError) {
        if (cancelled) return;

        console.error('Unexpected FG PO loading error:', loadError);
        setError(
          loadError instanceof Error
            ? loadError.message
            : 'Failed to load Finished Good purchase orders.'
        );
        setPos([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadPage();

    return () => {
      cancelled = true;
    };
  }, [pageQueryKey, workflowByPoRef]);

  useEffect(() => {
    let cancelled = false;

    async function loadReadyCount() {
      try {
        const { data: readyRows, error: countError } = await supabase
          .schema('FG Closer')
          .from('v_fg_po_summary')
          .select('po_ref_num, \"Merchandise Submission\", \"Accounts Submission\"')
          .eq('is_eligible', true)
          .limit(10000);

        if (cancelled) return;

        if (countError) {
          console.error(
            'Failed to load Ready for closer count:',
            countError
          );
          setReadyCount(null);
          return;
        }

        const excludedReadyRefs = new Set(
          (Object.values(workflowByPoRef) as ClosureRequest[])
            .filter((row) =>
              (row.merchandise_submitted === true && row.accounts_submitted === true) ||
              row.status === 'Founder Review' ||
              row.status === 'Closed'
            )
            .map((row) => String(row.po_ref_num ?? '').trim())
            .filter(Boolean),
        );

        const readyRowsCount = (readyRows ?? []).filter((row) => {
          const record = row as Record<string, unknown>;
          const poRef = String(record.po_ref_num ?? '').trim();
          const merchandiseSubmitted =
            record['Merchandise Submission'] === true ||
            String(record['Merchandise Submission']).trim().toLowerCase() === 'true';
          const accountsSubmitted =
            record['Accounts Submission'] === true ||
            String(record['Accounts Submission']).trim().toLowerCase() === 'true';

          return !excludedReadyRefs.has(poRef) && !(merchandiseSubmitted && accountsSubmitted);
        }).length;

        setReadyCount(readyRowsCount);

        // The review KPIs must use the same submission flags as the review
        // tabs. Submission history tables may be cleared or contain revisions,
        // while v_fg_po_summary is the source that drives the visible rows.
        const merchandiseReviewCount = (readyRows ?? []).filter((row) => {
          const record = row as Record<string, unknown>;
          return (
            record['Merchandise Submission'] === true ||
            String(record['Merchandise Submission']).trim().toLowerCase() === 'true'
          );
        }).length;

        const accountsReviewCount = (readyRows ?? []).filter((row) => {
          const record = row as Record<string, unknown>;
          return (
            record['Accounts Submission'] === true ||
            String(record['Accounts Submission']).trim().toLowerCase() === 'true'
          );
        }).length;

        const closedRefsForFounderCount = new Set(
          (Object.values(workflowByPoRef) as ClosureRequest[])
            .filter((row) => row.status === 'Closed')
            .map((row) => String(row.po_ref_num ?? '').trim())
            .filter(Boolean),
        );

        const founderReviewCount = (readyRows ?? []).filter((row) => {
          const record = row as Record<string, unknown>;
          const poRef = String(record.po_ref_num ?? '').trim();
          const merchandiseSubmitted =
            record['Merchandise Submission'] === true ||
            String(record['Merchandise Submission']).trim().toLowerCase() === 'true';
          const accountsSubmitted =
            record['Accounts Submission'] === true ||
            String(record['Accounts Submission']).trim().toLowerCase() === 'true';

          return merchandiseSubmitted && accountsSubmitted && !closedRefsForFounderCount.has(poRef);
        }).length;

        setWorkflowCounts((current) => ({
          ...current,
          merchandise: merchandiseReviewCount,
          accounts: accountsReviewCount,
          founder: founderReviewCount,
        }));
      } catch (countError) {
        if (cancelled) return;
        console.error(
          'Unexpected Ready for closer count error:',
          countError
        );
        setReadyCount(null);
      }
    }

    loadReadyCount();

    return () => {
      cancelled = true;
    };
  }, [workflowByPoRef, reloadKey]);

  const filteredPos = useMemo(() => {
    const query = search.trim().toLowerCase();

    return pos.filter((po) => {
      const poRef = String(po.po_ref_num ?? '').toLowerCase();
      const vendor = String(po.vendor_name ?? '').toLowerCase();
      const matchesSearch =
        !query || poRef.includes(query) || vendor.includes(query);
      const matchesVendor =
        selectedVendors.length === 0 || selectedVendors.includes(String(po.vendor_name ?? ''));

      // Workflow is keyed by PO reference; po_id may be null in the summary view.
      // Always resolve by po_ref_num so approved POs correctly appear in Closed.
      const workflow = workflowByPoRef[String(po.po_ref_num ?? '').trim()];
      const status = activeFilter === 'Closed'
        ? 'Closed'
        : workflow?.status ?? (isCompletedPO(po) ? 'Ready for closer' : null);

      const matchesStatus =
        activeFilter === 'Merchandise Review'
          ? isDepartmentSubmitted(po, 'Merchandise')
          : activeFilter === 'Accounts Review'
            ? isDepartmentSubmitted(po, 'Accounts')
            : activeFilter === 'Ready for closer'
              ? status !== 'Founder Review' &&
                status !== 'Closed' &&
                !(isDepartmentSubmitted(po, 'Merchandise') &&
                  isDepartmentSubmitted(po, 'Accounts'))
              : activeFilter === 'Founder Review'
                ? isDepartmentSubmitted(po, 'Merchandise') &&
                  isDepartmentSubmitted(po, 'Accounts') &&
                  status !== 'Closed'
                : status === activeFilter;

      return matchesSearch && matchesVendor && matchesStatus;
    });
  }, [pos, search, activeFilter, workflowByPoRef, selectedVendors]);

  const totalPages = total ? Math.ceil(total / PAGE_SIZE) : hasNextPage ? page + 1 : page;
  const startRow = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const endRow = total ? Math.min(page * PAGE_SIZE, total) : (page - 1) * PAGE_SIZE + pos.length;

  const ready = readyCount ?? 0;
  const merchandise = workflowCounts.merchandise;
  const accounts = workflowCounts.accounts;
  const founder = workflowCounts.founder;
  const closed = workflowCounts.closed;

  const vendorOptions = useMemo(
    () =>
      Array.from(
        new Set(
          pos
            .map((po) => String(po.vendor_name ?? '').trim())
            .filter(Boolean),
        ),
      ).sort((a, b) => String(a).localeCompare(String(b))),
    [pos],
  );

  function isDateColumn(column: string) {
    return /date|timestamp/i.test(column);
  }

  function toggleVendor(vendor: string) {
    setSelectedVendors((current) =>
      current.includes(vendor)
        ? current.filter((value) => value !== vendor)
        : [...current, vendor],
    );
    setPage(1);
  }

  function clearVendorFilter() {
    setSelectedVendors([]);
    setPage(1);
  }

  function applyDateSort(column: string, direction: 'asc' | 'desc') {
    setDateSortColumn(column);
    setDateSortDirection(direction);
    setDateMenuColumn(null);
    setPage(1);
  }

  function clearDateSort() {
    setDateSortColumn(null);
    setDateSortDirection('desc');
    setDateMenuColumn(null);
    setPage(1);
  }

  function exportCurrentPageCsv() {
    const columns = getDisplayColumns(filteredPos[0] ?? {});
    if (!columns.length || !filteredPos.length) return;

    const escapeCsv = (value: unknown) => {
      const valueText = value === null || value === undefined ? '' : String(value);
      return `"${valueText.replace(/"/g, '""')}"`;
    };

    const csv = [
      columns.map((column) =>
        escapeCsv(column === 'po_ref_num' ? 'PO REF NO.' : column),
      ).join(','),
      ...filteredPos.map((po) =>
        columns.map((column) => escapeCsv(po[column])).join(','),
      ),
    ].join('\r\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `finished-good-po-closer-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function changePage(nextPage: number) {
    if (nextPage < 1) return;
    if (total && nextPage > totalPages) return;
    if (!total && nextPage > page && !hasNextPage) return;
    setPage(nextPage);
  }

  function handleSearchChange(value: string) {
    setSearch(value);
    setPage(1);
  }

  function handleFilterChange(filter: 'All' | ClosureStatus) {
    setActiveFilter(filter);
    setPage(1);
  }

  function getPOWorkflowStatus(po: FgPoRow): ClosureStatus | null {
    const workflow = workflowByPoRef[String(po.po_ref_num ?? '').trim()];
    if (workflow?.status) return workflow.status;
    if (String(po.po_status ?? '').toLowerCase() === 'closed') return 'Closed';
    if (activeFilter === 'Closed') return 'Closed';
    return isCompletedPO(po) ? 'Ready for closer' : null;
  }

  // Read a submitted Merchandise penalty remark for display in Founder Review.
  // This reads the saved submission/workflow snapshots and never edits them.
  function getFounderMerchandiseRemark(poRef: string, penaltyKey: string): string {
    const submission = latestSubmissionByPoRef.Merchandise[poRef];
    const workflow = workflowByPoRef[poRef];
    const selectedClosedSnapshot =
      selectedPO && String(selectedPO.po_ref_num ?? '').trim() === poRef &&
      String(selectedPO.po_status ?? '').toLowerCase() === 'closed'
        ? selectedPO
        : null;
    const sources: unknown[] = [
      selectedClosedSnapshot?.merchandise_data,
      selectedClosedSnapshot?.merchandise_review_remarks,
      submission?.merchandise_data,
      submission?.review_remarks,
      submission?.remarks,
      workflow?.merchandise_review,
    ];
    const normalize = (value: string) => value.trim().toLowerCase().replace(/[\s_-]+/g, '');
    const target = normalize(`penalty:Merchandise:PO_TOTAL:${penaltyKey}`);
    const parse = (value: unknown): unknown => {
      if (typeof value !== 'string') return value;
      try { return JSON.parse(value); } catch { return value; }
    };
    const find = (raw: unknown, depth = 0): string => {
      if (depth > 12 || raw == null) return '';
      const value = parse(raw);
      if (typeof value === 'string') {
        const lineMatch = value.split(/\r?\n/).find((line) => {
          const separator = line.indexOf(': ');
          return separator > 0 && normalize(line.slice(0, separator)) === target;
        });
        if (lineMatch) return lineMatch.slice(lineMatch.indexOf(': ') + 2).trim();
        return '';
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          const itemObject = item && typeof item === 'object' ? item as Record<string, unknown> : null;
          if (itemObject) {
            const itemKey = itemObject.key ?? itemObject.metric ?? itemObject.name ?? itemObject.field;
            const itemValue = itemObject.remark ?? itemObject.value ?? itemObject.comment ?? itemObject.text;
            if (typeof itemKey === 'string' && normalize(itemKey) === target && typeof itemValue === 'string') return itemValue;
          }
          const found = find(item, depth + 1);
          if (found) return found;
        }
        return '';
      }
      if (typeof value === 'object') {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          if (normalize(key) === target && typeof child === 'string' && child.trim()) return child.trim();
          const found = find(child, depth + 1);
          if (found) return found;
        }
      }
      return '';
    };
    for (const source of sources) {
      const result = find(source);
      if (result) return result;
    }
    return '';
  }

  function getSubmittedReviewDetails(department: Department, poRef: string, rowOverride?: FgPoRow) {
    const submission = latestSubmissionByPoRef[department][poRef];
    const workflow = workflowByPoRef[poRef];
    const parseObject = (value: unknown): Record<string, unknown> => {
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
      if (typeof value === 'string') {
        try {
          const parsed: unknown = JSON.parse(value);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
        } catch { /* legacy plain text */ }
      }
      return {};
    };
    const dataKey = department === 'Merchandise' ? 'merchandise_data' : 'accounts_data';
    const candidateRow = rowOverride ?? selectedPO;
    const closed = candidateRow && String(candidateRow.po_ref_num ?? '').trim() === poRef &&
      String(candidateRow.po_status ?? '').toLowerCase() === 'closed' ? candidateRow : null;
    const snapshot = parseObject(closed?.[dataKey] ?? submission?.[dataKey]);
    const remarks = parseObject(
      (department === 'Merchandise' ? closed?.merchandise_review_remarks : closed?.accounts_review_remarks) ??
      submission?.review_remarks
    );
    const workflowRemarks = parseObject(department === 'Merchandise' ? workflow?.merchandise_review : workflow?.accounts_review);
    const documentPath = department === 'Merchandise'
      ? closed?.merchandise_document_path ?? workflow?.merchandise_document_path ?? submission?.document_path ?? submission?.document_url ?? snapshot.document_path ?? snapshot.document_url
      : closed?.accounts_document_path ?? workflow?.accounts_document_path ?? submission?.document_path ?? submission?.document_url ?? snapshot.document_path ?? snapshot.document_url;
    const documentName = department === 'Merchandise'
      ? closed?.merchandise_document_name ?? workflow?.merchandise_document_name ?? submission?.document_name ?? submission?.supporting_document_name ?? snapshot.document_name ?? snapshot.supporting_document_name
      : closed?.accounts_document_name ?? workflow?.accounts_document_name ?? submission?.document_name ?? submission?.supporting_document_name ?? snapshot.document_name ?? snapshot.supporting_document_name;
    const additionalRemarks = remarks.additional_remarks ?? remarks.additionalRemarks ?? snapshot.review_text ?? snapshot.reviewText ?? snapshot.additional_remarks ?? snapshot.additionalRemarks ?? workflowRemarks.additional_remarks ?? workflowRemarks.additionalRemarks ?? submission?.additional_remarks ?? submission?.review_text ?? submission?.remarks;
    return {
      remarks,
      additionalRemarks: typeof additionalRemarks === 'string' ? additionalRemarks : additionalRemarks == null ? '' : formatReviewValue(additionalRemarks),
      documentPath: typeof documentPath === 'string' && documentPath.trim() ? documentPath.trim() : null,
      documentName: typeof documentName === 'string' && documentName.trim() ? documentName.trim() : (department === 'Accounts' ? 'Accounts Supporting Document' : 'Merchandise Supporting Document'),
    };
  }

  function getFounderReviewRemarks(poRef: string, rowOverride?: FgPoRow): Record<string, string> {
    const workflowValue = workflowByPoRef[poRef]?.founder_review;
    const candidateRow = rowOverride ?? selectedPO;
    const closedValue = candidateRow && String(candidateRow.po_ref_num ?? '').trim() === poRef
      ? candidateRow.approval_remarks
      : null;
    const parse = (value: unknown): Record<string, unknown> => {
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
      if (typeof value === 'string' && value.trim()) {
        try {
          const parsed: unknown = JSON.parse(value);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
        } catch { /* Legacy plain-text founder remarks. */ }
      }
      return {};
    };
    const sources = [parse(closedValue), parse(workflowValue)];
    for (const source of sources) {
      const nested = source.penalty_remarks ?? source.penaltyRemarks ?? source.founder_review_remarks;
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        return Object.fromEntries(Object.entries(nested as Record<string, unknown>)
          .filter(([, value]) => typeof value === 'string')
          .map(([key, value]) => [key, value as string]));
      }
      // Support an older snapshot where penalty keys were stored at the root.
      const rootEntries = Object.entries(source).filter(([key, value]) => /^penalty:/i.test(key) && typeof value === 'string');
      if (rootEntries.length) return Object.fromEntries(rootEntries.map(([key, value]) => [key, value as string]));
    }
    return {};
  }

  function getSubmittedPenaltyRemark(department: Department, poRef: string, penaltyKey: string): string {
    const details = getSubmittedReviewDetails(department, poRef);
    const candidates = [
      `penalty:${department}:PO_TOTAL:${penaltyKey}`,
      `penalty:${department.toLowerCase()}:po_total:${penaltyKey}`,
      `penalty:${department}:PO_TOTAL:${penaltyKey}`.toLowerCase().replace(/[\s_-]+/g, ''),
    ];
    for (const candidate of candidates) {
      const direct = details.remarks[candidate];
      if (typeof direct === 'string' && direct.trim()) return direct.trim();
    }
    const normalize = (key: string) => key.trim().toLowerCase().replace(/[\s_-]+/g, '');
    const target = normalize(`penalty:${department}:PO_TOTAL:${penaltyKey}`);
    const match = Object.entries(details.remarks).find(([key, value]) => normalize(key) === target && typeof value === 'string' && value.trim());
    return match && typeof match[1] === 'string' ? match[1].trim() : '';
  }

  function openInitiateModal(po: FgPoRow) {
    if (!isCompletedPO(po)) return;

    const poRef = String(po.po_ref_num ?? '').trim();
    const existing = poRef ? workflowByPoRef[poRef] : undefined;

    // The Ready for closer action always opens the department chooser while
    // at least one department is still pending. Its options are hidden using
    // the two submission flags on this PO row.
    if (
      existing &&
      (existing.status === 'Founder Review' || existing.status === 'Closed')
    ) {
      setSelectedPO(po);
      setFounderEditing(false);
      setFounderMerchandiseRemarks({});
      setFounderReviewRemarks(getFounderReviewRemarks(poRef));
      setFounderMerchandiseText(getSubmittedReviewDetails('Merchandise', poRef).additionalRemarks);
      setSelectedFounderMerchandiseDocument(null);
      setSelectedDocument(null);
      // Reuse the exact read-only Accounts Review loader so Founder Review
      // receives the same SKU, GRN, penalty, remarks, and document data.
      openDepartmentReview(po, 'Accounts');
      setReviewMode('founder');
      setFounderComment(formatReviewValue(existing.founder_review));
      setFounderReviewRemarks(getFounderReviewRemarks(poRef));
      setWorkflowMessage('');
      setWorkflowError('');
      return;
    }

    setSelectedPO(po);
    setSkuRows([]);
    setSkuLoading(false);
    setFabricRows([]);
    setFabricLoading(false);
    setGrnRows([]);
    setPenaltyGrnItems([]);
    setPenaltyRgOutItems([]);
    setGrnLoading(false);
    setSelectedDepartment(null);
    setReviewMode('chooser');
    setReviewReadOnly(false);
    setFounderEditing(false);
    setFounderMerchandiseRemarks({});
    setFounderReviewRemarks({});
    setFounderMerchandiseText('');
    setSelectedFounderMerchandiseDocument(null);
    setReviewText('');
    setReviewRemarks({});
    setSkuCellSelection(new Set());
    setSkuSelectionAnchor(null);
    setSkuSelecting(false);
    setSelectedDocument(null);
    setFounderComment('');
    setWorkflowMessage('');
    setWorkflowError('');
  }

  function closeInitiateModal() {
    setSelectedPO(null);
    setSkuRows([]);
    setSkuLoading(false);
    setFabricRows([]);
    setFabricLoading(false);
    setGrnRows([]);
    setPenaltyGrnItems([]);
    setPenaltyRgOutItems([]);
    setGrnLoading(false);
    setSelectedDepartment(null);
    setReviewMode(null);
    setReviewReadOnly(false);
    setFounderEditing(false);
    setFounderMerchandiseRemarks({});
    setFounderMerchandiseText('');
    setSelectedFounderMerchandiseDocument(null);
    setReviewText('');
    setReviewRemarks({});
    setSkuCellSelection(new Set());
    setSkuSelectionAnchor(null);
    setSkuSelecting(false);
    setSelectedDocument(null);
    setFounderComment('');
    setWorkflowMessage('');
    setWorkflowError('');
  }

  async function loadSkuRows(po: FgPoRow) {
    setPenaltyGrnItems([]);
    setPenaltyRgOutItems([]);
    if (!po.po_ref_num) {
      setSkuRows([]);
      setFabricRows([]);
      return;
    }

    setSkuLoading(true);
    if (getSkuCalculationType(po.po_ref_num) === 'JOB') {
      setFabricLoading(true);
    } else {
      setFabricRows([]);
      setFabricLoading(false);
    }

    try {
      const { data, error: skuError } = await supabase
        .schema('FG Closer')
        .from('v_fg_po_view')
        .select(`
          po_id,
          po_ref_num,
          po_number,
          po_date,
          expected_delivery_date,
          vendor_name,
          vendor_code,
          sku,
          product_description,
          po_qty,
          cutting_qty,
          po_to_cutting_variance,
          po_to_cutting_pct,
          grn_qty,
          pending_qty,
          cutting_to_grn_variance,
          cutting_to_grn_pct,
          last_grn_date,
          grn_count,
          avg_shipment_size,
          avg_grn_tat_days,
          vendor_delay_days,
          pp_delay_days,
          gpt_delay_days,
          inline_qc_delay_days,
          rejection_rate,
          rg_out_qty,
          rg_in_qty,
          item_price,
          completed_at_timestamp
        `)
        .eq('po_ref_num', po.po_ref_num)
        .order('sku', { ascending: true });

      if (skuError) throw skuError;

      const rows = ((data ?? []) as FgPoRow[]).filter(
        (row) => String(row.sku ?? '').trim() !== '',
      );

      setSkuRows(rows);

      // GRN SUMMARY is required for both JOB and FOB/EFOB POs.
      // The workbook uses the same GRN-level reconciliation structure for FOB/EFOB;
      // JOB additionally has DG columns, while FOB/EFOB has FABRIC columns.
      setGrnLoading(true);
      try {
        const { data: grnData, error: grnError } = await supabase
          .schema('FG Closer')
          .from('saadaa_po_grn_mapping')
          .select(`
            po_id,
            po_number,
            po_ref_num,
            grn_id,
            sku,
            grn_created_date,
            grn_invoice_number,
            grn_receive_quantity
          `)
          .eq('po_ref_num', po.po_ref_num);

        if (grnError) throw grnError;
        setPenaltyGrnItems(((grnData ?? []) as Array<Record<string, unknown>>).map((item) => ({
          po_id: item.po_id == null ? null : Number(item.po_id),
          sku: item.sku == null ? null : String(item.sku).trim(),
          grn_created_date: item.grn_created_date == null ? null : String(item.grn_created_date),
          grn_receive_quantity: item.grn_receive_quantity == null ? null : Number(item.grn_receive_quantity),
        })));

        const { data: rgOutData, error: rgOutError } = await supabase
          .schema('FG Closer')
          .from('rg_out')
          .select(`po_ref, grn_no, rg_out_date, sku, qc_fail_reason`)
          .eq('po_ref', po.po_ref_num);

        if (rgOutError) throw rgOutError;
        setPenaltyRgOutItems(((rgOutData ?? []) as Array<Record<string, unknown>>).map((item) => ({
          sku: item.sku == null ? null : String(item.sku).trim(),
          qc_fail_reason: item.qc_fail_reason == null ? null : String(item.qc_fail_reason),
        })));

        const { data: rgInData, error: rgInError } = await supabase
          .schema('FG Closer')
          .from('rg_in')
          .select(`po_ref, grn_no, rg_in_report_date`)
          .eq('po_ref', po.po_ref_num);

        if (rgInError) throw rgInError;

        const poRowsById = new Map<number, FgPoRow>();
        rows.forEach((row) => {
          if (row.po_id != null) poRowsById.set(Number(row.po_id), row);
        });

        const countByGrn = (
          items: Array<Record<string, unknown>>,
          grnKey: string,
          dateKey: string,
        ) => {
          const map = new Map<string, { qty: number; date: string | null }>();
          items.forEach((item) => {
            const grn = String(item[grnKey] ?? '').trim();
            if (!grn) return;
            const current = map.get(grn) ?? { qty: 0, date: null };
            current.qty += 1;
            current.date = current.date ?? (item[dateKey] as string | null) ?? null;
            map.set(grn, current);
          });
          return map;
        };

        const rgOutByGrn = countByGrn(
          (rgOutData ?? []) as Array<Record<string, unknown>>,
          'grn_no',
          'rg_out_date',
        );
        const rgInByGrn = countByGrn(
          (rgInData ?? []) as Array<Record<string, unknown>>,
          'grn_no',
          'rg_in_report_date',
        );

        type GrnAccumulator = {
          grn: string | number | null;
          poId: number | null;
          grnDate: string | null;
          qty: number;
          invoiceNumbers: Set<string>;
          rates: Set<number>;
        };

        const grouped = new Map<string, GrnAccumulator>();
        ((grnData ?? []) as Array<Record<string, unknown>>).forEach((item) => {
          const poId = item.po_id == null ? null : Number(item.po_id);
          const grnId = item.grn_id == null ? null : (item.grn_id as string | number);
          const grnKey = `${poId ?? ''}|${grnId ?? ''}|${item.grn_created_date ?? ''}`;
          const current = grouped.get(grnKey) ?? {
            grn: grnId,
            poId,
            grnDate: item.grn_created_date ? String(item.grn_created_date) : null,
            qty: 0,
            invoiceNumbers: new Set<string>(),
            rates: new Set<number>(),
          };

          current.qty += Number(item.grn_receive_quantity ?? 0);
          const invoice = String(item.grn_invoice_number ?? '').trim();
          if (invoice) current.invoiceNumbers.add(invoice);

          const poRow = poId == null ? undefined : poRowsById.get(poId);
          const rate = Number(poRow?.item_price ?? NaN);
          if (Number.isFinite(rate)) current.rates.add(rate);

          grouped.set(grnKey, current);
        });

        const nextGrnRows: GrnSummaryRow[] = Array.from(grouped.values())
          .sort((a, b) => String(b.grnDate ?? '').localeCompare(String(a.grnDate ?? '')))
          .map((item) => {
            const poRow = item.poId == null ? undefined : poRowsById.get(item.poId);
            const poCloserDate = poRow?.completed_at_timestamp ?? null;
            const grnDate = item.grnDate;
            const delayDays = grnDate && poCloserDate
              ? Math.round(
                  (new Date(grnDate).getTime() - new Date(poCloserDate).getTime()) /
                    86400000,
                )
              : null;

            // Workbook GRN SUMMARY:
            // <= 6 days = 0%, 7-15 days = 5%, >= 16 days = 10%.
            const delayChargeRate =
              delayDays == null ? null : delayDays <= 6 ? 0 : delayDays >= 16 ? 10 : 5;
            const rate = item.rates.size === 1 ? Array.from(item.rates)[0] : null;
            const amount = rate != null ? item.qty * rate : null;
            const delayAmount =
              delayChargeRate != null ? item.qty * delayChargeRate : null;
            const amountWithGst = amount != null ? amount * 1.05 : null;
            const invoice = Array.from(item.invoiceNumbers).join(', ') || null;
            const rgOut = item.grn == null ? undefined : rgOutByGrn.get(String(item.grn));
            const rgIn = item.grn == null ? undefined : rgInByGrn.get(String(item.grn));

            return {
              grn: item.grn,
              vdNum: null,
              grnDate,
              qty: item.qty,
              poCloserDate,
              delayDays,
              delayChargeRate,
              delayAmount,
              ratePerPcs: rate,
              amount,
              amountWithGst,
              vendorInvoiceNumber: invoice,
              invoiceAmount: null,
              rgOutPcs: rgOut?.qty ?? 0,
              rgOutBusyDate: null,
              rgOutBusyAmount: null,
              rgInPcs: rgIn?.qty ?? 0,
              rgInBusyDate: null,
              rgInBusyAmount: null,
              dgPcs: null,
              dgEntryDate: null,
              dgDnAmount: null,
              fabricDate: null,
              fabricAmount: null,
              trimsDate: null,
              trimsAmount: null,
            };
          });

        setGrnRows(nextGrnRows);
      } catch (grnLoadError) {
        console.error('Failed to load GRN Summary:', grnLoadError);
        setGrnRows([]);
        setWorkflowError(
          grnLoadError instanceof Error
            ? grnLoadError.message
            : 'Failed to load GRN Summary.',
        );
      } finally {
        setGrnLoading(false);
      }

      /*
       * JOB -> FABRIC DETAILS
       *
       * Workbook logic:
       *   RECEIVED PCS  = SUM of finished-good GRN qty mapped to the RM/Fabric SKU.
       *   ACH AVG       = total FABRIC CONSUMED / total CUTTING pieces
       *                    for that fabric SKU.
       *   STD AVG       = average of the JOB size standards:
       *                    XS 1.15, S 1.22, M 1.27, L 1.28,
       *                    XL 1.36, 2XL 1.39, 3XL 1.49, 4XL 1.57.
       *   STD RM        = RECEIVED PCS * STD AVG.
       *   ACH AVG RM    = RECEIVED PCS * ACH AVG.
       *
       * RM ISSUED, RM RETURN, PART CHANGE, UWF and SCRAP are separate
       * operational inputs in the workbook. They do not exist in the
       * current FG Closer backend, so they remain null instead of being
       * fabricated from cutting/fabric-consumption data.
       */
      if (getSkuCalculationType(po.po_ref_num) === 'JOB') {
        const { data: cuttingData, error: cuttingError } = await supabase
          .schema('FG Closer')
          .from('po_qty_cutting_register')
          .select(`
            po_number,
            fabric_sku_code,
            item_code,
            cutting_qty,
            avg_fabric_consumption_approved,
            fabric_consumed
          `)
          .eq('po_number', po.po_ref_num);

        if (cuttingError) throw cuttingError;

        const cuttingRows = (cuttingData ?? []) as Array<{
          po_number: string | null;
          fabric_sku_code: string | null;
          item_code: string | null;
          cutting_qty: number | null;
          avg_fabric_consumption_approved: number | null;
          fabric_consumed: number | null;
        }>;

        const sizeStd: Record<string, number> = {
          XS: 1.15,
          S: 1.22,
          M: 1.27,
          L: 1.28,
          XL: 1.36,
          '2XL': 1.39,
          '3XL': 1.49,
          '4XL': 1.57,
        };

        const stdValues = Object.values(sizeStd);
        const stdAvg = stdValues.reduce((sum, value) => sum + value, 0) / stdValues.length;

        const skuToFabric = new Map<string, Set<string>>();

        cuttingRows.forEach((cutting) => {
          const sku = String(cutting.item_code ?? '').trim().toUpperCase();
          const fabric = String(cutting.fabric_sku_code ?? '').trim();
          if (!sku || !fabric) return;

          const existing = skuToFabric.get(sku) ?? new Set<string>();
          existing.add(fabric);
          skuToFabric.set(sku, existing);
        });

        const fabricMap = new Map<string, {
          receivedPcs: number;
          cuttingQty: number;
          fabricConsumed: number;
        }>();

        rows.forEach((row) => {
          const sku = String(row.sku ?? '').trim().toUpperCase();
          const fabrics = skuToFabric.get(sku);
          if (!fabrics || fabrics.size === 0) return;

          /*
           * A product SKU should normally map to one RM SKU in the cutting
           * register. If bad source data maps it to multiple fabrics, do not
           * duplicate the GRN quantity across every fabric.
           */
          const fabricList = Array.from(fabrics);
          if (fabricList.length !== 1) return;

          const fabric = fabricList[0];
          const current = fabricMap.get(fabric) ?? {
            receivedPcs: 0,
            cuttingQty: 0,
            fabricConsumed: 0,
          };

          current.receivedPcs += Number(row.grn_qty ?? 0);
          fabricMap.set(fabric, current);
        });

        cuttingRows.forEach((cutting) => {
          const fabric = String(cutting.fabric_sku_code ?? '').trim();
          if (!fabric) return;

          const current = fabricMap.get(fabric) ?? {
            receivedPcs: 0,
            cuttingQty: 0,
            fabricConsumed: 0,
          };

          current.cuttingQty += Number(cutting.cutting_qty ?? 0);
          current.fabricConsumed += Number(cutting.fabric_consumed ?? 0);
          fabricMap.set(fabric, current);
        });

        const nextFabricRows: FabricDetailRow[] = Array.from(fabricMap.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([rmSku, values]) => {
            const achAvg =
              values.cuttingQty > 0
                ? values.fabricConsumed / values.cuttingQty
                : null;

            const stdRm =
              values.receivedPcs != null && stdAvg != null
                ? values.receivedPcs * stdAvg
                : null;

            const achAvgRm =
              values.receivedPcs != null && achAvg != null
                ? values.receivedPcs * achAvg
                : null;

            return {
              rmSku,
              receivedPcs: values.receivedPcs,
              rmIssued: null,
              rmReturn: null,
              netRmIssued: null,
              rmAmount: null,
              stdAvg,
              achAvg,
              stdRm,
              achAvgRm,
              rmUsedForPartChange: null,
              totalRmUsed: null,
              diffInRm: null,
              diffInPct: null,
              uwfFabric: null,
              uwfAmount: null,
              scrapRecd: null,
              scrapAmount: null,
              netFabUses: null,
              fabricLoss: null,
              fabricLossPct: null,
            };
          });

        setFabricRows(nextFabricRows);
      } else {
        setFabricRows([]);
      }
    } catch (error) {
      console.error('Failed to load SKU-wise FG PO calculation:', error);
      setSkuRows([]);
      setFabricRows([]);
      setWorkflowError(
        error instanceof Error
          ? error.message
          : 'Failed to load SKU-wise PO calculations.',
      );
    } finally {
      setSkuLoading(false);
      setFabricLoading(false);
    }
  }

  function openDepartmentReview(po: FgPoRow, department: Department) {
    const poRef = String(po.po_ref_num ?? '').trim();
    const submission = poRef ? latestSubmissionByPoRef[department][poRef] : undefined;
    const snapshotKey = department === 'Merchandise' ? 'merchandise_data' : 'accounts_data';

    // JSON/JSONB can arrive as objects, JSON strings, nested objects, or arrays.
    // Parse recursively so older and newer submission shapes render identically.
    const parseJson = (value: unknown): unknown => {
      if (typeof value !== 'string' || !value.trim()) return value;
      try { return JSON.parse(value); } catch { return value; }
    };
    const asObject = (value: unknown): Record<string, unknown> => {
      const parsed = parseJson(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    };
    const snapshot = asObject(submission?.[snapshotKey]);
    const savedWorkflow = poRef ? workflowByPoRef[poRef] : undefined;
    const workflowReviewValue = department === 'Merchandise'
      ? savedWorkflow?.merchandise_review
      : savedWorkflow?.accounts_review;
    const workflowReviewObject = asObject(workflowReviewValue);

    const canonicalRemarkKey = (key: string) => {
      const trimmed = key.trim();
      const match = trimmed.match(/^penalty:([^:]+):([^:]+):(.+)$/i);
      if (!match) return trimmed;
      const departmentName = /^merchandise$/i.test(match[1])
        ? 'Merchandise'
        : /^accounts$/i.test(match[1]) ? 'Accounts' : match[1];
      const scopeName = /^po_total$/i.test(match[2]) ? 'PO_TOTAL' : match[2];
      return `penalty:${departmentName}:${scopeName}:${match[3]}`;
    };
    const normalizedKey = (key: string) => key.trim().toLowerCase().replace(/[\s_-]+/g, '');
    const normalizedRemarks: Record<string, string> = {};
    const additionalRemarkValues: string[] = [];
    const seen = new Set<unknown>();

    const walkJson = (raw: unknown, depth = 0) => {
      if (depth > 12 || raw == null) return;
      const value = parseJson(raw);
      if (typeof value === 'string') return;
      if (typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);

      if (Array.isArray(value)) {
        value.forEach((item) => {
          const itemObject = asObject(item);
          const metric = itemObject.key ?? itemObject.metric ?? itemObject.name ?? itemObject.field;
          const remark = itemObject.remark ?? itemObject.value ?? itemObject.comment ?? itemObject.text;
          if (typeof metric === 'string' && typeof remark === 'string' && remark.trim()) {
            normalizedRemarks[canonicalRemarkKey(metric)] = remark.trim();
          }
          walkJson(item, depth + 1);
        });
        return;
      }

      const object = value as Record<string, unknown>;
      Object.entries(object).forEach(([key, child]) => {
        const compactKey = normalizedKey(key);
        if (typeof child === 'string' && child.trim()) {
          if (/^(additionalremarks|reviewtext|merchandiseremarks|accountsremarks)$/.test(compactKey)) {
            additionalRemarkValues.push(child.trim());
          }
          if (/^penalty:/i.test(key)) {
            normalizedRemarks[canonicalRemarkKey(key)] = child.trim();
          }
        }
        walkJson(child, depth + 1);
      });
    };

    // Include every relevant JSON-bearing field. This also supports rows where
    // the complete review snapshot is stored under a legacy column name.
    walkJson(submission);
    walkJson(snapshot);
    walkJson(workflowReviewValue);
    walkJson(workflowReviewObject);

    // Legacy workflow records sometimes store "metric: remark" lines as text.
    const parseLegacyLines = (value: unknown) => {
      if (typeof value !== 'string') return;
      value.split(/\r?\n/).forEach((line) => {
        const separator = line.indexOf(': ');
        if (separator <= 0) return;
        const key = line.slice(0, separator).trim();
        const remark = line.slice(separator + 2).trim();
        if (/^penalty:/i.test(key) && remark) normalizedRemarks[canonicalRemarkKey(key)] = remark;
      });
    };
    parseLegacyLines(submission?.review_remarks);
    parseLegacyLines(workflowReviewValue);

    // Add normalized aliases so casing, spaces, or underscores in older JSON
    // keys do not prevent the matching textarea from finding its saved value.
    Object.entries(normalizedRemarks).forEach(([key, value]) => {
      normalizedRemarks[normalizedKey(key)] ??= value;
    });

    setSelectedPO(po);
    setSelectedDepartment(department);
    setReviewMode('review');
    setReviewReadOnly(true);

    const explicitText = [
      snapshot.review_text,
      snapshot.additional_remarks,
      asObject(snapshot.review_remarks).additional_remarks,
      asObject(submission?.review_remarks).additional_remarks,
      workflowReviewObject.additional_remarks,
      submission?.additional_remarks,
      submission?.review_text,
      ...additionalRemarkValues,
    ].map((value) => typeof value === 'string' ? value.trim() : '').find(Boolean) ?? '';
    const legacyWorkflowText = typeof workflowReviewValue === 'string'
      ? workflowReviewValue.trim()
      : '';
    setReviewText(explicitText || legacyWorkflowText);
    setReviewRemarks(normalizedRemarks);
    setSkuCellSelection(new Set());
    setSkuSelectionAnchor(null);
    setSkuSelecting(false);
    setSelectedDocument(null);
    setWorkflowMessage('');
    setWorkflowError('');
    void loadSkuRows(po);
  }

  function chooseDepartment(department: Department) {
    if (!selectedPO) return;
    setSelectedDepartment(department);
    setReviewMode('review');
    setReviewReadOnly(false);
    setReviewText('');
    setReviewRemarks({});
    setSelectedDocument(null);
    setWorkflowMessage('');
    setWorkflowError('');
    void loadSkuRows(selectedPO);
  }

  async function saveDepartmentReview() {
    if (!selectedPO || !selectedDepartment) return;

    setSavingReview(true);
    setWorkflowMessage('');
    setWorkflowError('');

    try {
      const email = userEmail.trim();
      if (!email) {
        throw new Error('Unable to identify the logged-in user.');
      }

      // The page already authenticates the user server-side with currentUser().
      // Do not call supabase.auth.getUser() here: the browser client may not
      // have a Supabase Auth session even though the dashboard session is valid.
      const name = email.split('@')[0];

      let documentPath: string | null = null;
      let documentName: string | null = null;
      let documentUploadWarning = '';

      if (selectedDocument) {
        const safeName = selectedDocument.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const documentPathPrefix =
          `${selectedPO.po_id ?? selectedPO.po_ref_num ?? 'unknown'}/${selectedDepartment.toLowerCase()}`;
        documentPath = `${documentPathPrefix}/${Date.now()}-${safeName}`;
        documentName = selectedDocument.name;

        const attemptedDocumentPath = documentPath;
        const { error: uploadError } = await supabase.storage
          .from('fg-closure-documents')
          .upload(attemptedDocumentPath, selectedDocument, {
            cacheControl: '3600',
            upsert: false,
            contentType: selectedDocument.type || undefined,
          });

        // The dashboard session may not be a Supabase Auth session in the
        // browser. Do not block saving the review if Storage rejects the upload.
        // Never persist a document path when the file was not actually uploaded.
        if (uploadError) {
          console.error('FG closure document upload failed; continuing with review save:', uploadError);
          documentPath = null;
          documentName = null;
          documentUploadWarning = ` Review saved without the supporting document because upload failed: ${uploadError.message || 'Storage access was denied'}. Please upload it again after Storage access is fixed.`;
        }
      }

      const existing = selectedPO.po_id == null
        ? undefined
        : workflowByPoRef[String(selectedPO.po_ref_num ?? '')];

      // Keep row-wise remarks as structured JSON for the closure-request
      // JSONB column. Do not concatenate them into a single string or store
      // the literal characters "\\n" between remarks.
      const rowRemarks = Object.fromEntries(
        Object.entries(reviewRemarks)
          .filter(([, value]) => String(value ?? '').trim() !== '')
          .map(([metric, value]) => [metric, String(value).trim()]),
      );
      const additionalRemarks = reviewText.trim();
      const departmentReviewJson: Record<string, string> = {
        ...rowRemarks,
        ...(additionalRemarks ? { additional_remarks: additionalRemarks } : {}),
      };
      const metricReview = Object.entries(rowRemarks)
        .map(([metric, value]) => `${metric}: ${value}`)
        .join('\n');
      const departmentReview = metricReview || additionalRemarks;
      const submittedAt = new Date().toISOString();

      // Immutable snapshot of exactly what the reviewer saw/submitted.
      const reviewSnapshot = {
        captured_at: submittedAt,
        calculation_type: skuCalculationType,
        po: selectedPO,
        sku_rows: skuRows,
        grn_rows: grnRows,
        penalty_grn_items: penaltyGrnItems,
        penalty_rg_out_items: penaltyRgOutItems,
        fabric_rows: fabricRows,
        penalty_calculations: poPenaltyRows,
        total_po_value: penaltyTotalPOValue,
        review_remarks: reviewRemarks,
        review_text: reviewText.trim(),
        selected_sku_sum: selectedSkuSum,
      };

      // Routing rules for the two departments:
      // 1. Fresh PO + Merchandise selected -> Merchandise Review.
      // 2. Fresh PO + Accounts selected -> Accounts Review.
      // 3. Merchandise Review opened with View and submitted -> Accounts Review.
      // 4. Accounts Review remains in Accounts Review for now; Founder routing
      //    is intentionally left untouched for the next phase.
      const nextStatus: ClosureStatus =
        selectedDepartment === 'Merchandise'
          ? existing?.status === 'Merchandise Review'
            ? 'Accounts Review'
            : 'Merchandise Review'
          : 'Accounts Review';

      const payload: Record<string, unknown> = {
        po_id: selectedPO.po_id,
        po_ref_num: selectedPO.po_ref_num,
        po_number: selectedPO.po_number,
        status: nextStatus,
        initiated_by: existing?.initiated_by ?? email,
        initiated_at: existing?.initiated_at ?? submittedAt,
        updated_at: submittedAt,
      };

      if (selectedDepartment === 'Merchandise') {
        payload.merchandise_review = departmentReviewJson;
        payload.merchandise_reviewed_by = email;
        payload.merchandise_reviewed_at = submittedAt;
        if (documentPath) {
          payload.merchandise_document_path = documentPath;
          payload.merchandise_document_name = documentName;
        }
      } else {
        payload.accounts_review = departmentReviewJson;
        payload.accounts_reviewed_by = email;
        payload.accounts_reviewed_at = submittedAt;
        if (documentPath) {
          payload.accounts_document_path = documentPath;
          payload.accounts_document_name = documentName;
        }
      }

      // Writes go through the server action because this dashboard authenticates
      // through the server-side currentUser() session. The browser Supabase client
      // does not necessarily have a Supabase Auth session, so direct INSERT/UPSERT
      // calls from the browser can fail with an empty PostgREST error object.
      const result = await saveFgWorkflowSubmission({
        requestPayload: payload,
        tableName:
          selectedDepartment === 'Merchandise'
            ? 'fg_merchandise_submissions'
            : 'fg_accounts_submissions',
        submissionPayload:
          selectedDepartment === 'Merchandise'
            ? {
                po_ref_num: selectedPO.po_ref_num,
                po_id: selectedPO.po_id,
                po_number: selectedPO.po_number,
                submitted_by_name: name,
                submitted_by_email: email,
                submitted_at: submittedAt,
                // review_remarks is JSONB: persist the object, never the
                // newline-joined display string.
                review_remarks: departmentReviewJson,
                po_snapshot: selectedPO,
                sku_snapshot: skuRows,
                operational_snapshot: {
                  grn_rows: grnRows,
                  fabric_rows: fabricRows,
                  tna_delivery: {
                    vendor_delay_days: selectedPO.vendor_delay_days,
                    pp_delay_days: selectedPO.pp_delay_days,
                    gpt_delay_days: selectedPO.gpt_delay_days,
                    inline_qc_delay_days: selectedPO.inline_qc_delay_days,
                    planned_date: typeof selectedPO.planned_date === 'string' ? selectedPO.planned_date : null,
                    expected_delivery_date: selectedPO.expected_delivery_date,
                    last_grn_date: selectedPO.last_grn_date,
                    avg_grn_tat_days: selectedPO.avg_grn_tat_days,
                  },
                },
                merchandise_data: reviewSnapshot,
                document_path: documentPath,
                document_name: documentName,
              }
            : {
                po_ref_num: selectedPO.po_ref_num,
                po_id: selectedPO.po_id,
                po_number: selectedPO.po_number,
                submitted_by_name: name,
                submitted_by_email: email,
                submitted_at: submittedAt,
                // review_remarks is JSONB: persist the object, never the
                // newline-joined display string.
                review_remarks: departmentReviewJson,
                po_snapshot: selectedPO,
                grn_snapshot: grnRows,
                commercial_snapshot: {
                  sku_rows: skuRows,
                  fabric_rows: fabricRows,
                  rg_out_qty: selectedPO.rg_out_qty,
                  rg_in_qty: selectedPO.rg_in_qty,
                  rejection_rate: selectedPO.rejection_rate,
                  rg_matched_serial_count: selectedPO.rg_matched_serial_count,
                  avg_rg_tat_days: selectedPO.avg_rg_tat_days,
                  min_rg_tat_days: selectedPO.min_rg_tat_days,
                  max_rg_tat_days: selectedPO.max_rg_tat_days,
                },
                accounts_data: reviewSnapshot,
                document_path: documentPath,
                document_name: documentName,
              },
      });

      if (!result.ok) throw new Error(result.error);

      const nextMessage = `${result.message}${documentUploadWarning}`;

      setWorkflowMessage(nextMessage);
      setReloadKey((value) => value + 1);
      setTimeout(() => closeInitiateModal(), 700);
    } catch (saveError) {
      console.error('Failed to save FG closure review:', saveError);
      setWorkflowError(
        saveError instanceof Error
          ? saveError.message
          : 'Failed to save the review.'
      );
    } finally {
      setSavingReview(false);
    }
  }

  async function openDocument(documentPath: string | null) {
    if (!documentPath) return;

    try {
      const { data, error: signedUrlError } = await supabase.storage
        .from('fg-closure-documents')
        .createSignedUrl(documentPath, 60 * 10);

      if (signedUrlError) throw signedUrlError;
      if (data?.signedUrl) window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
    } catch (documentError) {
      console.error('Failed to open closure document:', documentError);
      setWorkflowError(
        documentError instanceof Error
          ? documentError.message
          : 'Unable to open the uploaded document.'
      );
    }
  }

  async function saveFounderEdits() {
    if (!selectedPO) return;
    setSavingReview(true);
    setWorkflowMessage('');
    setWorkflowError('');
    try {
      const email = userEmail.trim();
      if (!email) throw new Error('Unable to identify the logged-in user.');
      const poRef = String(selectedPO.po_ref_num ?? '').trim();
      const existing = workflowByPoRef[poRef];
      const accountsSubmission = latestSubmissionByPoRef.Accounts[poRef];
      const merchandiseSubmission = latestSubmissionByPoRef.Merchandise[poRef];
      const requestId = Number(existing?.id || accountsSubmission?.request_id || merchandiseSubmission?.request_id || 0);
      if (!requestId || !accountsSubmission || !merchandiseSubmission) {
        throw new Error('Both Accounts and Merchandise submissions are required to edit the Founder Review.');
      }

      const uploadReplacement = async (file: File | null, department: Department) => {
        if (!file) return null;
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const path = `${selectedPO.po_id ?? poRef}/${department.toLowerCase()}/${Date.now()}-${safeName}`;
        const { error } = await supabase.storage.from('fg-closure-documents').upload(path, file, {
          cacheControl: '3600', upsert: false, contentType: file.type || undefined,
        });
        if (error) throw new Error(`Failed to upload ${department} document: ${error.message}`);
        return { path, name: file.name };
      };
      const accountsDocument = await uploadReplacement(selectedDocument, 'Accounts');
      const merchandiseDocument = await uploadReplacement(selectedFounderMerchandiseDocument, 'Merchandise');
      const submittedAt = new Date().toISOString();
      const accountsRemarks = Object.fromEntries(Object.entries(reviewRemarks)
        .filter(([key, value]) => key.startsWith('penalty:Accounts:PO_TOTAL:') && String(value ?? '').trim())
        .map(([key, value]) => [key, String(value).trim()]));
      const merchandiseRemarks = Object.fromEntries(Object.entries(founderMerchandiseRemarks)
        .filter(([, value]) => String(value ?? '').trim())
        .map(([key, value]) => [key, String(value).trim()]));
      const accountsReviewJson = { ...accountsRemarks, ...(reviewText.trim() ? { additional_remarks: reviewText.trim() } : {}) };
      const merchandiseReviewJson = { ...merchandiseRemarks, ...(founderMerchandiseText.trim() ? { additional_remarks: founderMerchandiseText.trim() } : {}) };
      const parseObject = (value: unknown): Record<string, unknown> => {
        if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
        if (typeof value === 'string') { try { const parsed: unknown = JSON.parse(value); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>; } catch { /* legacy text */ } }
        return {};
      };
      const previousAccountsData = parseObject(accountsSubmission.accounts_data);
      const previousMerchandiseData = parseObject(merchandiseSubmission.merchandise_data);
      const { id: _oldAccountsSubmissionId, ...accountsSubmissionBase } = accountsSubmission;
      const { id: _oldMerchandiseSubmissionId, ...merchandiseSubmissionBase } = merchandiseSubmission;
      const accountsPath = accountsDocument?.path ?? existing?.accounts_document_path ?? accountsSubmission.document_path ?? accountsSubmission.document_url ?? null;
      const accountsName = accountsDocument?.name ?? existing?.accounts_document_name ?? accountsSubmission.document_name ?? accountsSubmission.supporting_document_name ?? null;
      const merchandisePath = merchandiseDocument?.path ?? existing?.merchandise_document_path ?? merchandiseSubmission.document_path ?? merchandiseSubmission.document_url ?? null;
      const merchandiseName = merchandiseDocument?.name ?? existing?.merchandise_document_name ?? merchandiseSubmission.document_name ?? merchandiseSubmission.supporting_document_name ?? null;
      const commonSnapshot = {
        captured_at: submittedAt,
        calculation_type: skuCalculationType,
        po: selectedPO,
        sku_rows: skuRows,
        grn_rows: grnRows,
        penalty_grn_items: penaltyGrnItems,
        penalty_rg_out_items: penaltyRgOutItems,
        fabric_rows: fabricRows,
        penalty_calculations: poPenaltyRows,
        total_po_value: penaltyTotalPOValue,
      };
      const founderReviewJson = JSON.stringify({
        penalty_remarks: Object.fromEntries(Object.entries(founderReviewRemarks).filter(([, value]) => String(value ?? '').trim())),
        final_comment: founderComment.trim(),
      });
      const requestPayload: Record<string, unknown> = {
        po_id: selectedPO.po_id, po_ref_num: selectedPO.po_ref_num, po_number: selectedPO.po_number,
        status: 'Founder Review', updated_at: submittedAt, founder_review: founderReviewJson,
        accounts_review: accountsReviewJson, merchandise_review: merchandiseReviewJson,
        accounts_document_path: accountsPath, accounts_document_name: accountsName,
        merchandise_document_path: merchandisePath, merchandise_document_name: merchandiseName,
      };
      const accountsResult = await saveFgWorkflowSubmission({
        requestPayload,
        tableName: 'fg_accounts_submissions',
        submissionPayload: {
          ...accountsSubmissionBase, request_id: requestId, po_ref_num: selectedPO.po_ref_num, po_id: selectedPO.po_id,
          po_number: selectedPO.po_number, submitted_by_name: email.split('@')[0], submitted_by_email: email,
          submitted_at: submittedAt, revision_no: Number(accountsSubmission.revision_no ?? 0) + 1,
          review_remarks: accountsReviewJson, po_snapshot: selectedPO,
          grn_snapshot: grnRows,
          commercial_snapshot: { ...parseObject(accountsSubmission.commercial_snapshot), sku_rows: skuRows, fabric_rows: fabricRows },
          accounts_data: { ...previousAccountsData, ...commonSnapshot, review_remarks: accountsReviewJson, review_text: reviewText.trim(), document_path: accountsPath, document_name: accountsName },
          document_path: accountsPath, document_name: accountsName,
        },
      });
      if (!accountsResult.ok) throw new Error(accountsResult.error);

      const merchandiseResult = await saveFgWorkflowSubmission({
        requestPayload,
        tableName: 'fg_merchandise_submissions',
        submissionPayload: {
          ...merchandiseSubmissionBase, request_id: requestId, po_ref_num: selectedPO.po_ref_num, po_id: selectedPO.po_id,
          po_number: selectedPO.po_number, submitted_by_name: email.split('@')[0], submitted_by_email: email,
          submitted_at: submittedAt, revision_no: Number(merchandiseSubmission.revision_no ?? 0) + 1,
          review_remarks: merchandiseReviewJson, po_snapshot: selectedPO, sku_snapshot: skuRows,
          operational_snapshot: { ...parseObject(merchandiseSubmission.operational_snapshot), grn_rows: grnRows, fabric_rows: fabricRows },
          merchandise_data: { ...previousMerchandiseData, ...commonSnapshot, review_remarks: merchandiseReviewJson, review_text: founderMerchandiseText.trim(), document_path: merchandisePath, document_name: merchandiseName },
          document_path: merchandisePath, document_name: merchandiseName,
        },
      });
      if (!merchandiseResult.ok) throw new Error(merchandiseResult.error);

      setFounderEditing(false);
      setSelectedDocument(null);
      setSelectedFounderMerchandiseDocument(null);
      setWorkflowMessage('Founder edits saved successfully.');
      setReloadKey((value) => value + 1);
    } catch (saveError) {
      console.error('Failed to save Founder Review edits:', saveError);
      setWorkflowError(saveError instanceof Error ? saveError.message : 'Failed to save Founder Review edits.');
    } finally {
      setSavingReview(false);
    }
  }

  async function approveFounderReview() {
    if (!selectedPO) return;

    setApprovingFounder(true);
    setWorkflowMessage('');
    setWorkflowError('');

    try {
      const email = userEmail.trim();
      if (!email) {
        throw new Error('Unable to identify the logged-in user.');
      }

      const poRef = String(selectedPO.po_ref_num ?? '').trim();
      const existing = workflowByPoRef[poRef];
      const merchandiseSubmission = latestSubmissionByPoRef.Merchandise[poRef];
      const accountsSubmission = latestSubmissionByPoRef.Accounts[poRef];
      const requestId = Number(
        existing?.id || merchandiseSubmission?.request_id || accountsSubmission?.request_id || 0
      );

      // Some legacy/submission-backed rows do not carry po_id on the summary
      // row, so do not use po_id as a condition for finding the closure request.
      if (!requestId) {
        throw new Error(
          `Founder review request was not found for PO reference ${poRef || '(blank)'}. Check fg_po_closure_requests and the submission request_id values.`
        );
      }

      // Preserve the latest submitted snapshot from each department when the
      // founder approves the PO. These are the original JSON/JSONB-compatible
      // submission rows loaded from fg_merchandise_submissions and
      // fg_accounts_submissions; the server action can map their fields into
      // the dedicated fg_closed_po columns without flattening the snapshots.
      if (!merchandiseSubmission || !accountsSubmission) {
        throw new Error(
          'Cannot close this PO because the latest Merchandise or Accounts submission snapshot is missing.'
        );
      }

      const founderReviewSnapshot = JSON.stringify({
        penalty_remarks: Object.fromEntries(Object.entries(founderReviewRemarks).filter(([, value]) => String(value ?? '').trim())),
        final_comment: founderComment.trim(),
      });
      const result = await decideFgFounder({
        requestId,
        poRefNum: selectedPO.po_ref_num,
        poId: selectedPO.po_id,
        poNumber: selectedPO.po_number,
        decision: 'Approved',
        decisionRemarks: founderReviewSnapshot,
        merchandiseSnapshot: merchandiseSubmission,
        accountsSnapshot: accountsSubmission,
        poSnapshot: selectedPO,
        status: 'Closed',
      });

      if (!result.ok) throw new Error(result.error);

      // Persist an immutable closed-PO snapshot for the dedicated Closed section.
      // Upsert makes retries safe if the status update succeeded but the UI refreshed late.
      const { error: closedPoError } = await supabase
        .schema('FG Closer')
        .from('fg_closed_po')
        .upsert({
          request_id: requestId,
          po_ref_num: selectedPO.po_ref_num,
          po_id: selectedPO.po_id,
          po_number: selectedPO.po_number,
          merchandise_submission_id: Number(merchandiseSubmission.id ?? 0) || null,
          merchandise_revision_no: Number(merchandiseSubmission.revision_no ?? 0) || null,
          accounts_submission_id: Number(accountsSubmission.id ?? 0) || null,
          accounts_revision_no: Number(accountsSubmission.revision_no ?? 0) || null,
          po_snapshot: selectedPO,
          merchandise_sku_snapshot: merchandiseSubmission.sku_snapshot ?? null,
          merchandise_operational_snapshot: merchandiseSubmission.operational_snapshot ?? null,
          merchandise_data: merchandiseSubmission.merchandise_data ?? null,
          merchandise_review_remarks: merchandiseSubmission.review_remarks ?? null,
          merchandise_document_path: merchandiseSubmission.document_path ?? null,
          merchandise_document_name: merchandiseSubmission.document_name ?? null,
          grn_snapshot: accountsSubmission.grn_snapshot ?? null,
          commercial_snapshot: accountsSubmission.commercial_snapshot ?? null,
          accounts_data: accountsSubmission.accounts_data ?? null,
          accounts_review_remarks: accountsSubmission.review_remarks ?? null,
          accounts_document_path: accountsSubmission.document_path ?? null,
          accounts_document_name: accountsSubmission.document_name ?? null,
          approved_by_name: null,
          approved_by_email: email,
          approved_at: new Date().toISOString(),
          approval_remarks: founderReviewSnapshot,
        }, { onConflict: 'request_id' });

      if (closedPoError) {
        throw new Error(`PO status was updated, but saving the closed-PO snapshot failed: ${closedPoError.message}`);
      }

      setWorkflowMessage(result.message);
      setReloadKey((value) => value + 1);
      setTimeout(() => closeInitiateModal(), 700);
    } catch (approvalError) {
      console.error('Failed to approve FG closure:', approvalError);
      setWorkflowError(
        approvalError instanceof Error
          ? approvalError.message
          : 'Failed to complete final approval.'
      );
    } finally {
      setApprovingFounder(false);
    }
  }

  useEffect(() => {
    const stopSkuSelection = () => setSkuSelecting(false);
    window.addEventListener('mouseup', stopSkuSelection);
    return () => window.removeEventListener('mouseup', stopSkuSelection);
  }, []);

  type SkuCalculationType = 'JOB' | 'FOB_EFOB';

  function getSkuCalculationType(poRefNum: string | null | undefined): SkuCalculationType {
    const ref = String(poRefNum ?? '').trim().toUpperCase();
    return ref.includes('/JOB/') ? 'JOB' : 'FOB_EFOB';
  }

  const skuCalculationType = getSkuCalculationType(selectedPO?.po_ref_num);

  /*
   * SKU calculation routing:
   *
   * /JOB/  -> JOB workbook logic
   * /FOB/ or /EFOB/ (and the existing non-JOB FG references) -> FOB/EFOB logic
   *
   * The current FG view exposes the common PO / cutting / GRN / RG quantities.
   * JOB-only workbook fields such as STD AVG, COSTING PER PCS, RM SKU and DG
   * are intentionally not fabricated here because those source columns are not
   * present in v_fg_po_view yet. Once those fields are exposed by the backend,
   * they can be added to the JOB adapter without changing the routing.
   */
  const commonSkuMetrics = [
    {
      key: 'ORDER QTY',
      getValue: (row: FgPoRow) => Number(row.po_qty ?? 0),
    },
    {
      key: 'Cutting Details',
      getValue: (row: FgPoRow) => Number(row.cutting_qty ?? 0),
    },
    {
      key: 'GRN QTY',
      getValue: (row: FgPoRow) => Number(row.grn_qty ?? 0),
    },
    {
      key: 'Diff in Order and GRN',
      getValue: (row: FgPoRow) => Number(row.po_qty ?? 0) - Number(row.grn_qty ?? 0),
    },
    {
      key: 'Diff in Order and Cutting',
      getValue: (row: FgPoRow) => Number(row.po_qty ?? 0) - Number(row.cutting_qty ?? 0),
    },
    {
      key: 'Diff in Cutting and GRN',
      getValue: (row: FgPoRow) => Number(row.cutting_qty ?? 0) - Number(row.grn_qty ?? 0),
    },
    {
      key: 'RM SKU',
      getValue: (_row: FgPoRow) => null,
    },
    {
      key: 'RG OUT',
      getValue: (row: FgPoRow) => Number(row.rg_out_qty ?? 0),
    },
    {
      key: 'RG IN',
      getValue: (row: FgPoRow) => Number(row.rg_in_qty ?? 0),
    },
    {
      key: 'RG DIFF',
      getValue: (row: FgPoRow) =>
        Number(row.rg_out_qty ?? 0) - Number(row.rg_in_qty ?? 0),
    },
  ];

  const fobEfoBSkuMetrics = [
    ...commonSkuMetrics,
    {
      key: 'DG',
      // DG is not exposed by the current FG Closer backend.
      getValue: (_row: FgPoRow) => 0,
    },
    {
      key: 'NET QTY',
      getValue: (row: FgPoRow) =>
        Number(row.grn_qty ?? 0) +
        Number(row.rg_in_qty ?? 0) -
        Number(row.rg_out_qty ?? 0),
    },
  ];

  const jobSkuMetrics = [
    ...commonSkuMetrics,
    {
      key: 'DG',
      // JOB workbook formula requires DG. Current backend does not expose it,
      // so keep it explicitly zero until a DG source is connected.
      getValue: (_row: FgPoRow) => 0,
    },
    {
      key: 'NET QTY',
      // JOB workbook: GRN + RG IN - RG OUT - DG.
      getValue: (row: FgPoRow) =>
        Number(row.grn_qty ?? 0) +
        Number(row.rg_in_qty ?? 0) -
        Number(row.rg_out_qty ?? 0) - 0,
    },
  ];

  const skuMetrics = skuCalculationType === 'JOB'
    ? jobSkuMetrics
    : fobEfoBSkuMetrics;

  const skuTotalForMetric = (metric: (typeof skuMetrics)[number]) =>
    skuRows.reduce((sum, row) => {
      const value = metric.getValue(row);
      return typeof value === 'number' && Number.isFinite(value) ? sum + value : sum;
    }, 0);

  function getSkuCellKey(rowIndex: number, colIndex: number) {
    return `${rowIndex}:${colIndex}`;
  }

  function buildSkuRectSelection(
    anchor: { row: number; col: number },
    current: { row: number; col: number },
  ) {
    const minRow = Math.min(anchor.row, current.row);
    const maxRow = Math.max(anchor.row, current.row);
    const minCol = Math.min(anchor.col, current.col);
    const maxCol = Math.max(anchor.col, current.col);

    const next = new Set<string>();

    for (let row = minRow; row <= maxRow; row += 1) {
      for (let col = minCol; col <= maxCol; col += 1) {
        next.add(getSkuCellKey(row, col));
      }
    }

    return next;
  }

  function selectSkuCell(
    rowIndex: number,
    colIndex: number,
    event: MouseEvent<HTMLTableCellElement>,
  ) {
    event.preventDefault();

    const current = { row: rowIndex, col: colIndex };

    if (event.shiftKey && skuSelectionAnchor) {
      setSkuCellSelection(buildSkuRectSelection(skuSelectionAnchor, current));
      setSkuSelecting(false);
      return;
    }

    const key = getSkuCellKey(rowIndex, colIndex);

    if (event.ctrlKey || event.metaKey) {
      setSkuCellSelection((currentSelection) => {
        const next = new Set(currentSelection);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      setSkuSelectionAnchor(current);
      setSkuSelecting(false);
      return;
    }

    setSkuSelectionAnchor(current);
    setSkuSelecting(true);
    setSkuCellSelection(new Set([key]));
  }

  function extendSkuSelection(rowIndex: number, colIndex: number) {
    if (!skuSelecting || !skuSelectionAnchor) return;

    setSkuCellSelection(
      buildSkuRectSelection(skuSelectionAnchor, {
        row: rowIndex,
        col: colIndex,
      }),
    );
  }

  function clearSkuSelection() {
    setSkuCellSelection(new Set());
    setSkuSelectionAnchor(null);
    setSkuSelecting(false);
  }

  const penaltyTotalPOValue = skuRows.reduce((sum, row) => {
    const rate = Number(row.item_price ?? 0);
    const quantity = Number(row.po_qty ?? 0);
    return sum + (Number.isFinite(rate) && Number.isFinite(quantity) ? rate * quantity : 0);
  }, 0);
  const penaltyPoQty = skuRows.reduce((sum, row) => sum + Math.max(0, Number(row.po_qty ?? 0)), 0);
  const penaltyJobWork = skuCalculationType === 'JOB';
  const penaltyCurrency = (value: number | null) =>
    value == null ? 'Needs input' : `₹${formatNumber(value)}`;
  const penaltyToday = new Date();
  penaltyToday.setHours(0, 0, 0, 0);
  const dayDifference = (later: string | null | undefined, earlier: string | null | undefined) => {
    if (!later || !earlier) return 0;
    const laterDate = new Date(later);
    const earlierDate = new Date(earlier);
    if (Number.isNaN(laterDate.getTime()) || Number.isNaN(earlierDate.getTime())) return 0;
    return Math.max(0, Math.floor((Date.UTC(laterDate.getFullYear(), laterDate.getMonth(), laterDate.getDate()) - Date.UTC(earlierDate.getFullYear(), earlierDate.getMonth(), earlierDate.getDate())) / 86400000));
  };
  const penaltyRows = skuRows.flatMap((skuRow) => {
    const sku = String(skuRow.sku ?? '').trim();
    const skuKey = `${skuRow.po_id ?? ''}|${sku}`;
    const poQty = Math.max(0, Number(skuRow.po_qty ?? 0));
    const cuttingQty = Math.max(0, Number(skuRow.cutting_qty ?? 0));
    const grnQty = Math.max(0, Number(skuRow.grn_qty ?? 0));
    const pendingQty = Math.max(0, Number(skuRow.pending_qty ?? 0));
    const unitRate = Math.max(0, Number(skuRow.item_price ?? 0));
    const skuValue = poQty * unitRate;
    const expectedDate = skuRow.expected_delivery_date ? String(skuRow.expected_delivery_date) : null;
    const lateGrnItems = penaltyGrnItems.filter((item) =>
      Number(item.po_id ?? -1) === Number(skuRow.po_id ?? -2) &&
      String(item.sku ?? '').trim().toUpperCase() === sku.toUpperCase() &&
      dayDifference(item.grn_created_date, expectedDate) > 0
    );
    const lateReceivedQty = lateGrnItems.reduce((sum, item) => sum + Math.max(0, Number(item.grn_receive_quantity ?? 0)), 0);
    const overduePendingDays = expectedDate && new Date(expectedDate).getTime() < penaltyToday.getTime()
      ? dayDifference(penaltyToday.toISOString(), expectedDate)
      : 0;
    const overduePendingQty = overduePendingDays > 0 ? pendingQty : 0;
    const delayedQty = lateReceivedQty + overduePendingQty;
    const delayedDays = Math.max(
      overduePendingDays,
      ...lateGrnItems.map((item) => dayDifference(item.grn_created_date, expectedDate)),
      0,
    );
    const lateDeliveryRate = penaltyJobWork ? 5 : 10;
    const lateDeliveryPercent = penaltyJobWork ? 0.01 : 0.015;
    const lateDeliveryCap = unitRate * delayedQty * 0.15;
    const lateDeliveryAmount = delayedQty > 0 && delayedDays > 0
      ? Math.min(lateDeliveryCap, Math.max(delayedQty * lateDeliveryRate, skuValue * lateDeliveryPercent * delayedDays))
      : 0;
    const dgQty = penaltyRgOutItems.filter((item) =>
      String(item.sku ?? '').trim().toUpperCase() === sku.toUpperCase() &&
      /\bDG\b|DEFECTIVE GOODS|DEFECTIVE GARMENT|DAMAGE GOODS/i.test(String(item.qc_fail_reason ?? ''))
    ).length;
    const dgRate = unitRate;
    const dgPct = poQty > 0 ? dgQty / poQty : 0;
    const rgOutQty = Math.max(0, Number(skuRow.rg_out_qty ?? 0));
    const rejectionThresholdQty = poQty * 0.03;
    const excessRejectedQty = Math.max(0, rgOutQty - rejectionThresholdQty);
    const jobShortageTolerance = Math.max(cuttingQty * 0.01, 5);
    const jobShortage = Math.max(0, cuttingQty - grnQty - jobShortageTolerance);
    const fobShortage = poQty > 0 && grnQty / poQty < 0.98 ? Math.max(0, poQty - grnQty) : 0;
    const shortage = penaltyJobWork ? jobShortage : fobShortage;
    const actualOutputQty = penaltyJobWork ? cuttingQty : grnQty;
    const overproductionQty = Math.max(0, actualOutputQty - poQty);
    const overproductionThreshold = Math.max(poQty * 0.10, 5);
    const overproductionBreached = overproductionQty > overproductionThreshold;
    const shortShipmentRate = penaltyJobWork ? 10 : 20;
    const shortShipmentPercent = penaltyJobWork ? 0.01 : 0.015;
    const ppDelay = Math.max(0, Number(skuRow.pp_delay_days ?? 0));
    const gptDelay = Math.max(0, Number(skuRow.gpt_delay_days ?? 0));
    const dgUptoTwoAmount = dgQty > 0 && dgPct <= 0.02 ? dgQty * dgRate : (dgQty === 0 ? 0 : null);
    const dgOverTwoAmount = dgQty > 0 && dgPct > 0.02 ? dgQty * (dgRate + 5) : (dgQty === 0 ? 0 : null);
    const skuPenaltyRows = [
      {
        key: 'late_delivery', category: 'Late Delivery', type: 'Time Penalty',
        details: 'Delivery timeline missed, creating lost-sales / OOS risk.',
        threshold: 'Qty received or last GRN after expected/TNA closing date; no waiver days.',
        basis: `SKU PO value ₹${formatNumber(skuValue)}; delayed received qty ${formatNumber(lateReceivedQty)} pcs + overdue pending qty ${formatNumber(overduePendingQty)} pcs; delay ${formatNumber(delayedDays)} day(s).`,
        amount: lateDeliveryAmount,
        formula: penaltyJobWork
          ? 'Min(15% of delayed product value, higher of ₹5 × delayed pcs or 1% of SKU PO value × late days)'
          : 'Min(15% of delayed product value, higher of ₹10 × delayed pcs or 1.5% of SKU PO value × late days)',
      },
      {
        key: 'dg_upto_2', category: 'Quality Rejection — DG Goods (≤2%)', type: 'Defect Penalty',
        details: 'Goods in unusable condition within the 2% DG threshold.',
        threshold: 'DG quantity up to 2% of this SKU PO quantity.',
        basis: `DG pcs ${formatNumber(dgQty)} / SKU PO qty ${formatNumber(poQty)}; unit rate ₹${formatNumber(unitRate)}.`,
        amount: dgQty === 0 ? 0 : dgUptoTwoAmount,
        formula: 'DG pcs × full SKU unit rate; applies only when DG quantity is ≤2%.',
      },
      {
        key: 'dg_over_2', category: 'Quality Rejection — DG Goods (>2%)', type: 'Defect Penalty',
        details: 'DG goods exceed the 2% threshold.',
        threshold: 'More than 2% DG goods for this SKU.',
        basis: `DG pcs ${formatNumber(dgQty)} / SKU PO qty ${formatNumber(poQty)}; unit rate ₹${formatNumber(unitRate)}.`,
        amount: dgQty === 0 ? 0 : dgOverTwoAmount,
        formula: penaltyJobWork
          ? 'DG pcs × (full SKU unit rate + ₹5/pc)'
          : 'DG pcs × (full SKU unit rate + ₹5/pc; goods returned without trims)',
      },
      {
        key: 'quality_rejection_over_3', category: 'Quality Rejection (>3%)', type: 'Compliance Penalty',
        details: 'Re-QC and freight cost for rejection above the permitted threshold.',
        threshold: 'Only rejected pcs above 3% of this SKU PO quantity are charged.',
        basis: `RG Out ${formatNumber(rgOutQty)} pcs; threshold ${formatNumber(rejectionThresholdQty)} pcs; excess ${formatNumber(excessRejectedQty)} pcs.`,
        amount: excessRejectedQty * (penaltyJobWork ? 3 : 5),
        formula: `₹${penaltyJobWork ? 3 : 5} × rejected pcs above 3% threshold`,
      },
      {
        key: 'short_shipment', category: 'Short Shipment', type: 'Quantity Penalty',
        details: 'Quantity not fulfilled, causing lost-sales / OOS risk.',
        threshold: penaltyJobWork
          ? 'JOB: cutting vs GRN tolerance is 1% of cutting qty or 5 pcs, whichever is higher.'
          : 'FOB/EFOB: at least 98% fulfilment required at SKU level.',
        basis: penaltyJobWork
          ? `Cutting ${formatNumber(cuttingQty)}; GRN ${formatNumber(grnQty)}; chargeable shortage ${formatNumber(shortage)} pcs.`
          : `PO qty ${formatNumber(poQty)}; GRN ${formatNumber(grnQty)}; chargeable shortage ${formatNumber(shortage)} pcs.`,
        amount: shortage > 0 ? Math.max(shortage * shortShipmentRate, skuValue * shortShipmentPercent) : 0,
        formula: penaltyJobWork
          ? 'If tolerance breached: higher of ₹10 × SKU shortage or 1% of SKU PO value'
          : 'If fulfilment <98%: higher of ₹20 × SKU shortage or 1.5% of SKU PO value',
      },
      {
        key: 'overproduction', category: 'Over-Production without Approval', type: 'Inventory Penalty',
        details: 'Size mismatch / over-production without approval.',
        threshold: 'Over-production above 10% of SKU qty or 5 pcs, whichever is higher.',
        basis: `${penaltyJobWork ? 'Cutting qty' : 'GRN received qty'} ${formatNumber(actualOutputQty)} pcs vs PO qty ${formatNumber(poQty)} pcs; excess ${formatNumber(overproductionQty)} pcs (threshold ${formatNumber(overproductionThreshold)} pcs).`,
        amount: penaltyJobWork
          ? (overproductionBreached ? skuValue * 0.01 : 0)
          : 0,
        formula: penaltyJobWork
          ? '1% of this SKU PO value if excess quantity breaches the threshold'
          : 'Non-monetary action: reject and pick up in a separate PO if the threshold is breached',
      },
      {
        key: 'fabric_wastage', category: 'Fabric Wastage (JOB only)', type: 'Yield Penalty',
        details: 'Fabric wasted beyond approved cutting-register / PO average consumption.',
        threshold: penaltyJobWork ? 'Compare actual fabric consumed with approved consumption.' : 'Not applicable to EFOB / FOB.',
        basis: penaltyJobWork ? 'Fabric usage can be compared, but the applicable fabric value/rate is not present on this SKU row.' : 'NA',
        amount: penaltyJobWork ? null as number | null : 0,
        formula: penaltyJobWork ? 'Value of excess fabric wasted' : 'NA',
      },
      {
        key: 'reinspection', category: 'Re-Inspection Cost', type: 'Quality',
        details: 'Inline / GPT audit repeated after failure; vendor audit.',
        threshold: 'Charge after the policy free re-inspection allowance is exhausted.',
        basis: 'Number of paid re-inspections / vendor audits is not available in the PO/SKU source.',
        amount: null as number | null,
        formula: penaltyJobWork ? '₹3,000 per applicable inspection; vendor audit NA' : '₹5,000 per inspection/audit; vendor audit ₹10,000',
      },
      {
        key: 'late_sample', category: 'Late Sample Approval', type: 'Time',
        details: 'PP and GPT sample final dates missed.',
        threshold: 'Both PP and GPT dates missed; pending GPT on approval date counts as late.',
        basis: `SKU value ₹${formatNumber(skuValue)}; PP delay ${formatNumber(ppDelay)} day(s); GPT delay ${formatNumber(gptDelay)} day(s).`,
        amount: ppDelay > 0 && gptDelay > 0 ? skuValue * 0.005 : 0,
        formula: '0.5% of this SKU PO value if both PP and GPT dates are missed',
      },
      {
        key: 'late_cutting_data', category: 'Late Cutting Data Submission', type: 'Time',
        details: 'Cutting data unavailable / incorrect at first GRN or PDI.',
        threshold: 'No or incorrect cutting data at the time of first GRN.',
        basis: 'The current SKU calculation does not expose a validated first-GRN cutting-data compliance flag.',
        amount: null as number | null,
        formula: '0.5% of this SKU PO value when the condition is confirmed',
      },
    ];
    return skuPenaltyRows.map((penalty) => ({
      ...penalty,
      skuKey,
      sku,
      productDescription: String(skuRow.product_description ?? ''),
      poId: skuRow.po_id,
      poQty,
      unitRate,
      skuValue,
      delayedQty,
      delayedDays,
      dgQty,
      rgOutQty,
      excessRejectedQty,
      shortage,
      overproductionBreached,
      ppDelay,
      gptDelay,
      cuttingQty,
      grnQty,
    }));
  });

  // Commercial penalties are assessed at the whole-PO level. SKU data is
  // rolled up first; percentage penalties use total PO value, not each SKU value.
  const penaltyGroups = new Map<string, typeof penaltyRows>();
  penaltyRows.forEach((row) => {
    const group = penaltyGroups.get(row.key) ?? [];
    group.push(row);
    penaltyGroups.set(row.key, group);
  });

  const poPenaltyRows = Array.from(penaltyGroups.entries()).map(([key, rows]) => {
    const first = rows[0];
    const totalDelayedQty = rows.reduce((sum, row) => sum + Number(row.delayedQty ?? 0), 0);
    const maxDelayedDays = Math.max(0, ...rows.map((row) => Number(row.delayedDays ?? 0)));
    const delayedValue = rows.reduce((sum, row) => sum + Number(row.delayedQty ?? 0) * Number(row.unitRate ?? 0), 0);
    const totalDgQty = rows.reduce((sum, row) => sum + Number(row.dgQty ?? 0), 0);
    const totalRejectedQty = rows.reduce((sum, row) => sum + Number(row.rgOutQty ?? 0), 0);
    const excessRejectedQty = Math.max(0, totalRejectedQty - penaltyPoQty * 0.03);
    const totalCuttingQty = rows.reduce((sum, row) => sum + Number(row.cuttingQty ?? 0), 0);
    const totalGrnQty = rows.reduce((sum, row) => sum + Number(row.grnQty ?? 0), 0);
    const totalJobShortage = Math.max(0, totalCuttingQty - totalGrnQty - Math.max(totalCuttingQty * 0.01, 5));
    const totalFobShortage = rows.reduce((sum, row) => sum + Number(row.shortage ?? 0), 0);
    const hasOverproductionBreach = rows.some((row) => Boolean(row.overproductionBreached));
    const maxPPDelay = Math.max(0, ...rows.map((row) => Number(row.ppDelay ?? 0)));
    const maxGPTDelay = Math.max(0, ...rows.map((row) => Number(row.gptDelay ?? 0)));
    let amount: number | null = rows.some((row) => row.amount == null) ? null : rows.reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
    let basis = `Whole PO: ${formatNumber(penaltyPoQty)} pcs; total PO value ${penaltyCurrency(penaltyTotalPOValue)}.`;
    let formula = first.formula;

    if (key === 'late_delivery') {
      const flatRate = penaltyJobWork ? 5 : 10;
      const percentRate = penaltyJobWork ? 0.01 : 0.015;
      amount = totalDelayedQty > 0 && maxDelayedDays > 0
        ? Math.min(penaltyTotalPOValue * 0.15, Math.max(totalDelayedQty * flatRate, penaltyTotalPOValue * percentRate * maxDelayedDays))
        : 0;
      basis = `Whole PO delayed quantity ${formatNumber(totalDelayedQty)} pcs; maximum delay ${formatNumber(maxDelayedDays)} days; 15% total-PO-value cap ${penaltyCurrency(penaltyTotalPOValue * 0.15)}.`;
      formula = `Capped at 15% of total PO value; otherwise higher of ₹${flatRate} × delayed pcs and ${percentRate * 100}% of total PO value × delay days`;
    } else if (key === 'dg_upto_2') {
      amount = totalDgQty === 0 ? 0 : (penaltyPoQty > 0 && totalDgQty / penaltyPoQty <= 0.02
        ? rows.reduce((sum, row) => sum + Number(row.dgQty ?? 0) * Number(row.unitRate ?? 0), 0)
        : 0);
      basis = `Total DG quantity ${formatNumber(totalDgQty)} / total PO quantity ${formatNumber(penaltyPoQty)}.`;
      formula = 'If total DG quantity is ≤2% of PO quantity: DG pcs × applicable SKU unit rate';
    } else if (key === 'dg_over_2') {
      amount = totalDgQty === 0 ? 0 : (penaltyPoQty > 0 && totalDgQty / penaltyPoQty > 0.02
        ? rows.reduce((sum, row) => sum + Number(row.dgQty ?? 0) * (Number(row.unitRate ?? 0) + 5), 0)
        : 0);
      basis = `Total DG quantity ${formatNumber(totalDgQty)} / total PO quantity ${formatNumber(penaltyPoQty)}.`;
      formula = 'If total DG quantity is >2% of PO quantity: DG pcs × (applicable SKU unit rate + ₹5/pc)';
    } else if (key === 'quality_rejection_over_3') {
      amount = excessRejectedQty * (penaltyJobWork ? 3 : 5);
      basis = `Total rejected quantity ${formatNumber(totalRejectedQty)} pcs; 3% PO threshold ${formatNumber(penaltyPoQty * 0.03)} pcs; chargeable excess ${formatNumber(excessRejectedQty)} pcs.`;
      formula = `₹${penaltyJobWork ? 3 : 5} × rejected pcs above 3% of total PO quantity`;
    } else if (key === 'short_shipment') {
      const chargeableShortage = penaltyJobWork ? totalJobShortage : totalFobShortage;
      amount = chargeableShortage > 0
        ? Math.max(chargeableShortage * (penaltyJobWork ? 10 : 20), penaltyTotalPOValue * (penaltyJobWork ? 0.01 : 0.015))
        : 0;
      basis = penaltyJobWork
        ? `Whole PO cutting ${formatNumber(totalCuttingQty)} pcs; GRN ${formatNumber(totalGrnQty)} pcs; shortage after 1% or 5-pc tolerance ${formatNumber(chargeableShortage)} pcs.`
        : `Total chargeable shortage across SKUs failing the 98% fulfilment threshold: ${formatNumber(chargeableShortage)} pcs.`;
      formula = penaltyJobWork
        ? 'If PO-level tolerance is breached: higher of ₹10 × shortage pcs or 1% of total PO value'
        : 'For SKUs below 98% fulfilment: higher of ₹20 × chargeable shortage pcs or 1.5% of total PO value';
    } else if (key === 'overproduction') {
      amount = penaltyJobWork ? (hasOverproductionBreach ? penaltyTotalPOValue * 0.01 : 0) : 0;
      basis = hasOverproductionBreach ? 'At least one SKU exceeds the approved over-production threshold.' : 'No SKU exceeds the over-production threshold.';
      formula = penaltyJobWork ? '1% of total PO value if any SKU breaches its threshold' : 'Non-monetary action: reject and pick up in a separate PO if threshold is breached';
    } else if (key === 'late_sample') {
      amount = maxPPDelay > 0 && maxGPTDelay > 0 ? penaltyTotalPOValue * 0.005 : 0;
      basis = `Maximum PP delay ${formatNumber(maxPPDelay)} days; maximum GPT delay ${formatNumber(maxGPTDelay)} days.`;
      formula = '0.5% of total PO value if both PP and GPT dates are missed';
    } else if (key === 'fabric_wastage') {
      amount = penaltyJobWork ? null : 0;
      basis = penaltyJobWork ? 'Fabric loss and applicable fabric value/rate must be validated from Fabric Details.' : 'Not applicable to EFOB / FOB.';
    } else if (key === 'reinspection' || key === 'late_cutting_data') {
      amount = null;
    }

    return {
      ...first,
      skuKey: 'PO_TOTAL',
      sku: 'PO TOTAL',
      productDescription: 'All SKUs combined',
      poQty: penaltyPoQty,
      unitRate: null,
      skuValue: penaltyTotalPOValue,
      amount,
      basis,
      formula,
    };
  });

  const selectedSkuSum = Array.from(skuCellSelection).reduce((sum, key) => {
    const [metricIndexText, skuIndexText] = key.split(':');
    const metricIndex = Number(metricIndexText);
    const skuIndex = Number(skuIndexText);
    const metric = skuMetrics[metricIndex];
    const row = skuRows[skuIndex];

    if (!metric || !row) return sum;

    const value = metric.getValue(row);
    if (typeof value !== 'number' || !Number.isFinite(value)) return sum;

    // Negative SKU values are treated as zero, matching the table display.
    return sum + (value < 0 ? 0 : value);
  }, 0);

  return (
    <div className="fg-closer">
      <div className="fg-kpi-grid">
        <div className="fg-kpi-card">
          <div className="fg-kpi-top">
            <span className="fg-kpi-label">READY FOR CLOSER</span>
            <div className="fg-kpi-icon fg-icon-ready"><Clock3 size={17} /></div>
          </div>
          <div className="fg-kpi-value">{loading && readyCount === null ? '—' : ready}</div>
          <div className="fg-kpi-meta">Eligible completed purchase orders</div>
        </div>

        <div className="fg-kpi-card">
          <div className="fg-kpi-top">
            <span className="fg-kpi-label">MERCHANDISE REVIEW</span>
            <div className="fg-kpi-icon fg-icon-review"><FileCheck2 size={17} /></div>
          </div>
          <div className="fg-kpi-value">{loading ? '—' : merchandise}</div>
          <div className="fg-kpi-meta">Pending merchandise action</div>
        </div>

        <div className="fg-kpi-card">
          <div className="fg-kpi-top">
            <span className="fg-kpi-label">ACCOUNTS REVIEW</span>
            <div className="fg-kpi-icon fg-icon-accounts"><FileCheck2 size={17} /></div>
          </div>
          <div className="fg-kpi-value">{loading ? '—' : accounts}</div>
          <div className="fg-kpi-meta">Pending accounts action</div>
        </div>

        <div className="fg-kpi-card">
          <div className="fg-kpi-top">
            <span className="fg-kpi-label">FOUNDER REVIEW</span>
            <div className="fg-kpi-icon fg-icon-founder"><UserCheck size={17} /></div>
          </div>
          <div className="fg-kpi-value">{loading ? '—' : founder}</div>
          <div className="fg-kpi-meta">Pending final approval</div>
        </div>

        <div className="fg-kpi-card">
          <div className="fg-kpi-top">
            <span className="fg-kpi-label">CLOSED</span>
            <div className="fg-kpi-icon fg-icon-closed"><CheckCircle2 size={17} /></div>
          </div>
          <div className="fg-kpi-value">{loading ? '—' : closed}</div>
          <div className="fg-kpi-meta">Completed closures</div>
        </div>
      </div>

      {error && (
        <div className="fg-error">
          <div className="fg-error-icon"><XCircle size={18} /></div>
          <div>
            <strong>Unable to load Finished Good purchase orders</strong>
            <span>{error}</span>
          </div>
        </div>
      )}

      <div className="fg-toolbar">
        <div className="fg-search">
          <Search size={18} />
          <input
            value={search}
            onChange={(event) => handleSearchChange(event.target.value)}
            placeholder="Search by PO Ref No. or vendor..."
          />
          {search && (
            <button
              type="button"
              className="fg-search-clear"
              onClick={() => handleSearchChange('')}
              aria-label="Clear search"
            >
              <XCircle size={17} />
            </button>
          )}
        </div>

        <div className="fg-toolbar-actions">
          <div className="fg-vendor-filter-wrap">
            <button
              type="button"
              className={selectedVendors.length ? 'fg-toolbar-button active' : 'fg-toolbar-button'}
              onClick={() => setVendorMenuOpen((open) => !open)}
            >
              <Filter size={16} />
              Vendor
              {selectedVendors.length > 0 && (
                <span className="fg-filter-count">{selectedVendors.length}</span>
              )}
              <ChevronDown size={14} />
            </button>

            {vendorMenuOpen && (
              <div className="fg-vendor-menu">
                <div className="fg-vendor-menu-head">
                  <strong>Vendor</strong>
                  {selectedVendors.length > 0 && (
                    <button type="button" onClick={clearVendorFilter}>Clear</button>
                  )}
                </div>
                <div className="fg-vendor-options">
                  {vendorOptions.length ? (
                    vendorOptions.map((vendor) => (
                      <label key={vendor} className="fg-vendor-option">
                        <input
                          type="checkbox"
                          checked={selectedVendors.includes(vendor)}
                          onChange={() => toggleVendor(vendor)}
                        />
                        <span>{vendor}</span>
                      </label>
                    ))
                  ) : (
                    <span className="fg-vendor-empty">No vendors on this page</span>
                  )}
                </div>
              </div>
            )}
          </div>

          <button
            type="button"
            className="fg-toolbar-button"
            onClick={() => setReloadKey((value) => value + 1)}
            title="Refresh"
          >
            <RefreshCw size={16} />
            Refresh
          </button>

          <button
            type="button"
            className="fg-toolbar-button"
            onClick={exportCurrentPageCsv}
            disabled={!filteredPos.length}
            title="Export current page to CSV"
          >
            <Download size={16} />
            CSV
          </button>
        </div>
      </div>

      <div className="fg-filter-bar">
        {STATUS_FILTERS.map((filter) => (
          <button
            key={filter}
            type="button"
            className={activeFilter === filter ? 'fg-filter active' : 'fg-filter'}
            onClick={() => handleFilterChange(filter)}
          >
            {filter}
          </button>
        ))}
      </div>

      <div className="fg-table-card">
        <div className="fg-table-header">
          <div>
            <h2>Finished Good Purchase Orders</h2>
            <p>
              {loading
                ? 'Loading purchase orders...'
                : total
                  ? `Showing ${startRow}–${endRow} of ${total} purchase orders`
                  : `${pos.length} purchase orders shown on this page`}
            </p>
          </div>
        </div>

        <div className="fg-table-scroll">
          <table className="fg-table">
            <thead>
              <tr>
                {getTableColumns(pos[0] ?? {}).map((column) => (
                  <th
                    key={column}
                    className={
                      column === 'po_ref_num'
                        ? 'fg-sticky-col fg-sticky-head'
                        : column === '__fg_action__'
                          ? 'fg-row-action-head'
                          : undefined
                    }
                  >
                    {column === '__fg_action__' ? (
                      'Action'
                    ) : isDateColumn(column) ? (
                      <div className="fg-date-header">
                        <button
                          type="button"
                          className="fg-date-header-button"
                          onClick={(event) => {
                            const rect = event.currentTarget.getBoundingClientRect();
                            setDateMenuPosition({
                              top: rect.bottom + 7,
                              left: rect.left,
                            });
                            setDateMenuColumn((current) =>
                              current === column ? null : column,
                            );
                          }}
                        >
                          {column === 'po_ref_num' ? 'PO REF NO.' : column}
                          <ChevronDown size={12} />
                        </button>

                        {dateMenuColumn === column && (
                          <div
                            className="fg-date-menu"
                            style={{
                              top: dateMenuPosition.top,
                              left: dateMenuPosition.left,
                            }}
                          >
                            <button
                              type="button"
                              className={dateSortColumn === column && dateSortDirection === 'asc' ? 'active' : ''}
                              onClick={() => applyDateSort(column, 'asc')}
                            >
                              Oldest to newest
                            </button>
                            <button
                              type="button"
                              className={dateSortColumn === column && dateSortDirection === 'desc' ? 'active' : ''}
                              onClick={() => applyDateSort(column, 'desc')}
                            >
                              Newest to oldest
                            </button>
                            <button
                              type="button"
                              className="fg-date-clear"
                              onClick={clearDateSort}
                            >
                              Clear
                            </button>
                          </div>
                        )}
                      </div>
                    ) : column === 'po_ref_num' ? (
                      'PO REF NO.'
                    ) : (
                      column
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={Math.max(getTableColumns(pos[0] ?? {}).length, 1)}>
                    <div className="fg-empty">
                      <Clock3 size={24} />
                      <strong>Loading purchase orders...</strong>
                      <span>Fetching Finished Good PO summary data.</span>
                    </div>
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={Math.max(getTableColumns(pos[0] ?? {}).length, 1)}>
                    <div className="fg-empty">
                      <XCircle size={24} />
                      <strong>Unable to load purchase orders</strong>
                      <span>{error}</span>
                    </div>
                  </td>
                </tr>
              ) : filteredPos.length > 0 ? (
                filteredPos.map((po, rowIndex) => {
                  const columns = getTableColumns(po);
                  const workflow = workflowByPoRef[String(po.po_ref_num ?? '').trim()];
                  const rowStatus = getPOWorkflowStatus(po);
                  const completed = isCompletedPO(po);

                  return (
                    <tr key={String(po.po_ref_num ?? po.po_id ?? rowIndex)}>
                      {columns.map((column) => {
                        if (column === '__fg_action__') {
                          return (
                            <td key={column} className="fg-row-action-cell">
                              {activeFilter === 'Ready for closer' ? (
                                <button
                                  type="button"
                                  className="fg-initiate-button"
                                  disabled={!completed}
                                  onClick={() => openInitiateModal(po)}
                                  title={
                                    completed
                                      ? 'Initiate PO closure'
                                      : 'PO is not eligible for initiation'
                                  }
                                >
                                  Initiate <ArrowRight size={15} />
                                </button>
                              ) : activeFilter === 'Founder Review' ? (
                                <button
                                  type="button"
                                  className="fg-view-button"
                                  onClick={() => {
                                    // Load the read-only PO details, then preserve Founder mode
                                    // so the Merchandise Review column is rendered in this modal.
                                    openDepartmentReview(po, 'Accounts');
                                    setReviewMode('founder');
                                    setFounderComment(formatReviewValue(workflow?.founder_review ?? po.approval_remarks));
                                  }}
                                  title="View the same full PO closure details as Accounts Review"
                                >
                                  <Eye size={14} /> View
                                </button>
                              ) : activeFilter === 'Merchandise Review' || activeFilter === 'Accounts Review' || rowStatus === 'Merchandise Review' || rowStatus === 'Accounts Review' ? (
                                <button
                                  type="button"
                                  className="fg-view-button"
                                  onClick={() => openDepartmentReview(po, activeFilter === 'Accounts Review' ? 'Accounts' : 'Merchandise')}
                                  title={activeFilter === 'Accounts Review' ? 'Open Accounts review' : 'Open Merchandise review'}
                                >
                                  <Eye size={14} /> Review
                                </button>
                              ) : rowStatus === 'Founder Review' ? (
                                <button
                                  type="button"
                                  className="fg-view-button"
                                  onClick={() => {
                                    setSelectedPO(po);
                                    setSelectedDepartment(null);
                                    setReviewMode('founder');
                                    setReviewText('');
                                    setReviewRemarks({});
                                    setSelectedDocument(null);
                                    setFounderComment(formatReviewValue(workflow?.founder_review ?? po.approval_remarks));
                                    setWorkflowMessage('');
                                    setWorkflowError('');
                                  }}
                                  title="View Founder Review"
                                >
                                  <Eye size={14} /> View
                                </button>
                              ) : rowStatus === 'Closed' ? (
                                <button
                                  type="button"
                                  className="fg-view-button"
                                  onClick={() => {
                                    // Closed > View uses the same full Founder Final Approval layout,
                                    // but is strictly read-only and has no approval/edit actions.
                                    setSelectedPO(po);
                                    setSelectedDepartment(null);
                                    setReviewMode('founder');
                                    setReviewReadOnly(true);
                                    setFounderEditing(false);
                                    setReviewText(getSubmittedReviewDetails('Accounts', String(po.po_ref_num ?? '').trim(), po).additionalRemarks);
                                    setFounderMerchandiseText(getSubmittedReviewDetails('Merchandise', String(po.po_ref_num ?? '').trim(), po).additionalRemarks);
                                    setSelectedDocument(null);
                                    setSelectedFounderMerchandiseDocument(null);
                                    setFounderComment(formatReviewValue(workflow?.founder_review ?? po.approval_remarks));
                                    setWorkflowMessage('');
                                    setWorkflowError('');
                                    // Closed > View must hydrate the Accounts Review column
                                    // from the immutable approved snapshot, not reset it to empty.
                                    const parseClosedReviewObject = (value: unknown): Record<string, unknown> => {
                                      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
                                      if (typeof value === 'string' && value.trim()) {
                                        try {
                                          const parsed: unknown = JSON.parse(value);
                                          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
                                        } catch { /* legacy non-JSON review text */ }
                                      }
                                      return {};
                                    };
                                    const closedAccountsReview = parseClosedReviewObject(po.accounts_review_remarks);
                                    const closedAccountsData = parseClosedReviewObject(po.accounts_data);
                                    const closedAccountsNestedReview = parseClosedReviewObject(
                                      closedAccountsData.review_remarks ?? closedAccountsData.reviewRemarks,
                                    );
                                    const closedAccountsReviewValues: Record<string, string> = {};
                                    [closedAccountsData, closedAccountsNestedReview, closedAccountsReview].forEach((source) => {
                                      Object.entries(source).forEach(([key, value]) => {
                                        if (/^penalty:/i.test(key) && typeof value === 'string') {
                                          closedAccountsReviewValues[key] = value;
                                          closedAccountsReviewValues[key.toLowerCase().replace(/[\s_-]+/g, '')] = value;
                                        }
                                      });
                                    });
                                    setReviewRemarks(closedAccountsReviewValues);
                                    setFounderReviewRemarks(getFounderReviewRemarks(String(po.po_ref_num ?? '').trim(), po));
                                    setFounderMerchandiseRemarks({});
                                    setSkuCellSelection(new Set());
                                    setSkuSelectionAnchor(null);
                                    setSkuSelecting(false);
                                    void loadSkuRows(po);
                                  }}
                                >
                                  <Eye size={14} /> View
                                </button>
                              ) : (
                                <span className="fg-action-placeholder">—</span>
                              )}
                            </td>
                          );
                        }

                        const value = po[column];
                        return (
                          <td
                            key={column}
                            className={column === 'po_ref_num' ? 'fg-sticky-col fg-sticky-cell' : undefined}
                          >
                            {value === null || value === undefined || value === ''
                              ? '—'
                              : typeof value === 'object'
                                ? JSON.stringify(value)
                                : String(value)}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={Math.max(getTableColumns(pos[0] ?? {}).length, 1)}>
                    <div className="fg-empty">
                      <Search size={24} />
                      <strong>No purchase orders found</strong>
                      <span>Try another PO reference or vendor.</span>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="fg-pagination">
          <span>
            Page {page}{totalPages > 0 ? ` of ${totalPages}` : ''}
          </span>
          <div className="fg-pagination-actions">
            <button
              type="button"
              disabled={page === 1 || loading}
              onClick={() => changePage(page - 1)}
            >
              Previous
            </button>
            <span className="fg-page-current">{page}</span>
            <button
              type="button"
              disabled={loading || (!hasNextPage && !!total && page >= totalPages) || (!total && !hasNextPage)}
              onClick={() => changePage(page + 1)}
            >
              Next
            </button>
          </div>
        </div>
      </div>

      {selectedPO && reviewMode === 'chooser' && (
        <div className="fg-modal-backdrop" onMouseDown={closeInitiateModal}>
          <div
            className="fg-modal fg-department-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="fg-initiate-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="fg-modal-header">
              <div>
                <div className="fg-modal-eyebrow">FINISHED GOOD PO CLOSURE</div>
                <h2 id="fg-initiate-title">Select Review Department</h2>
                <p>{selectedPO.po_ref_num ?? 'PO reference unavailable'}</p>
              </div>
              <button
                type="button"
                className="fg-modal-close"
                onClick={closeInitiateModal}
                aria-label="Close"
              >
                <X size={19} />
              </button>
            </div>

            <div className="fg-department-body">
              <p className="fg-department-prompt">Who will review this PO?</p>
              <div className="fg-department-grid">
                {!isDepartmentSubmitted(selectedPO, 'Merchandise') && (
                  <button
                    type="button"
                    className="fg-department-card fg-department-merchandise"
                    onClick={() => chooseDepartment('Merchandise')}
                  >
                    <FileCheck2 size={23} />
                    <strong>Merchandise</strong>
                    <span>Review PO performance, remarks and supporting document.</span>
                    <ArrowRight size={16} />
                  </button>
                )}

                {!isDepartmentSubmitted(selectedPO, 'Accounts') && (
                  <button
                    type="button"
                    className="fg-department-card fg-department-accounts"
                    onClick={() => chooseDepartment('Accounts')}
                  >
                    <FileCheck2 size={23} />
                    <strong>Accounts</strong>
                    <span>Review commercial/accounting information and supporting document.</span>
                    <ArrowRight size={16} />
                  </button>
                )}
              </div>
              {isDepartmentSubmitted(selectedPO, 'Merchandise') &&
                isDepartmentSubmitted(selectedPO, 'Accounts') && (
                  <p className="fg-department-prompt">
                    Both departments have already submitted this PO.
                  </p>
                )}
            </div>

            <div className="fg-modal-footer">
              <button type="button" className="fg-modal-secondary" onClick={closeInitiateModal}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedPO && reviewMode === 'review' && selectedDepartment && (
        <div className="fg-modal-backdrop" onMouseDown={closeInitiateModal}>
          <div
            className="fg-modal fg-review-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="fg-review-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="fg-modal-header">
              <div>
                <div className="fg-modal-eyebrow">PO CLOSURE REQUEST</div>
                <h2 id="fg-review-title">Finished Good PO Closure Request</h2>
                <p>PO Reference: {selectedPO.po_ref_num ?? 'PO reference unavailable'}</p>
              </div>
              <button
                type="button"
                className="fg-modal-close"
                onClick={closeInitiateModal}
                aria-label="Close"
              >
                <X size={19} />
              </button>
            </div>

            <div className="fg-modal-body fg-reference-review-body">
              <div className="fg-reference-po-details">
                <div><span>PO Reference</span><strong>{selectedPO.po_ref_num ?? '—'}</strong></div>
                <div><span>PO Number</span><strong>{selectedPO.po_number ?? '—'}</strong></div>
                <div><span>PO Date</span><strong>{formatDate(selectedPO.po_date)}</strong></div>
                <div><span>Expected Delivery</span><strong>{formatDate(selectedPO.expected_delivery_date)}</strong></div>
                <div><span>Vendor</span><strong>{selectedPO.vendor_name ?? '—'}</strong></div>
                <div><span>Vendor Code</span><strong>{selectedPO.vendor_code ?? '—'}</strong></div>
                <div><span>PO Quantity</span><strong>{formatNumber(selectedPO.po_qty)}</strong></div>
                <div><span>Total PO Value</span><strong>{penaltyCurrency(penaltyTotalPOValue)}</strong></div>
                <div><span>GRN Received Qty</span><strong>{formatNumber(selectedPO.grn_qty)}</strong></div>
                <div><span>Pending Quantity</span><strong>{formatNumber(selectedPO.pending_qty)}</strong></div>
                <div><span>Cutting Quantity</span><strong>{formatNumber(selectedPO.cutting_qty)}</strong></div>
                <div><span>Last GRN</span><strong>{formatDate(selectedPO.last_grn_date)}</strong></div>
                <div><span>Avg GRN TAT</span><strong>{selectedPO.avg_grn_tat_days == null ? '—' : `${formatNumber(selectedPO.avg_grn_tat_days)} days`}</strong></div>
              </div>

              <div className="fg-reference-review-section">
                <div className="fg-reference-review-heading">
                  <div>
                    <h3>TNA & Delivery</h3>
                    <p>Track the PO-level vendor and TNA delay metrics before reviewing the closure.</p>
                  </div>
                </div>

                <div style={{ width: '100%', overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                    <thead>
                      <tr>
                        <th
                          style={{
                            width: '38%',
                            padding: '8px 10px',
                            textAlign: 'left',
                            fontSize: '11px',
                            fontWeight: 600,
                            color: '#64748b',
                            background: '#f8fafc',
                            borderBottom: '1px solid #e2e8f0',
                          }}
                        >
                          Metric
                        </th>
                        <th
                          style={{
                            padding: '8px 10px',
                            textAlign: 'left',
                            fontSize: '11px',
                            fontWeight: 600,
                            color: '#64748b',
                            background: '#f8fafc',
                            borderBottom: '1px solid #e2e8f0',
                          }}
                        >
                          Value
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        ['Vendor Delay', selectedPO.vendor_delay_days == null ? '—' : `${formatNumber(selectedPO.vendor_delay_days)} days`],
                        ['PP Sample Delay', selectedPO.pp_delay_days == null ? '—' : `${formatNumber(selectedPO.pp_delay_days)} days`],
                        ['GPT Delay', selectedPO.gpt_delay_days == null ? '—' : `${formatNumber(selectedPO.gpt_delay_days)} days`],
                        ['Inline QC Delay', selectedPO.inline_qc_delay_days == null ? '—' : `${formatNumber(selectedPO.inline_qc_delay_days)} days`],
                        ['Planned Date', formatDate(typeof selectedPO.planned_date === 'string' ? selectedPO.planned_date : null)],
                        ['Expected Delivery', formatDate(selectedPO.expected_delivery_date)],
                        ['Last GRN', formatDate(selectedPO.last_grn_date)],
                        ['Avg GRN TAT', selectedPO.avg_grn_tat_days == null ? '—' : `${formatNumber(selectedPO.avg_grn_tat_days)} days`],
                      ].map(([label, value]) => (
                        <tr key={label}>
                          <th
                            scope="row"
                            style={{
                              padding: '8px 10px',
                              textAlign: 'left',
                              fontSize: '12px',
                              fontWeight: 600,
                              color: '#64748b',
                              background: '#f8fafc',
                              borderBottom: '1px solid #e2e8f0',
                            }}
                          >
                            {label}
                          </th>
                          <td
                            style={{
                              padding: '8px 10px',
                              fontSize: '12px',
                              fontWeight: 600,
                              color: '#0f172a',
                              borderBottom: '1px solid #e2e8f0',
                            }}
                          >
                            {value}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="fg-reference-review-section">
                <div className="fg-reference-review-heading">
                  <div>
                    <h3>SKU Wise Details</h3>
                    <p>{skuCalculationType === 'JOB' ? 'JOB PO: calculations follow the JOB workbook logic.' : 'FOB / EFOB PO: calculations follow the FOB / EFOB logic.'}</p>
                  </div>
                </div>

                <div className="fg-reference-review-table-wrap">
                <div className="fg-sku-table-toolbar">
                  <span>
                    {skuCalculationType === 'JOB' ? 'JOB calculation' : 'FOB / EFOB calculation'} · {skuCellSelection.size > 0
                      ? `${skuCellSelection.size} cell${skuCellSelection.size === 1 ? '' : 's'} selected`
                      : 'Select cells to calculate a sum'}
                  </span>

                  <div className="fg-sku-selection-summary">
                    <strong>SUM</strong>
                    <strong>{formatNumber(selectedSkuSum)}</strong>
                    {skuCellSelection.size > 0 && (
                      <button type="button" onClick={clearSkuSelection}>
                        Clear
                      </button>
                    )}
                  </div>
                </div>

                <div className="fg-sku-table-scroll">
                  <table className="fg-reference-review-table fg-sku-review-table">
                    <thead>
                      <tr>
                        <th>SKU</th>
                        {skuMetrics.map((metric) => (
                          <th key={metric.key}>{metric.key}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {skuRows.length > 0 ? (
                        <>
                          {skuRows.map((row, skuIndex) => (
                            <tr key={`${row.po_id ?? 'po'}-${row.sku}-${skuIndex}`}>
                              <td className="fg-sku-label-cell">
                                <strong>{row.sku || '—'}</strong>
                              </td>
                              {skuMetrics.map((metric, metricIndex) => {
                                const cellKey = getSkuCellKey(metricIndex, skuIndex);
                                const value = metric.getValue(row);
                                const selected = skuCellSelection.has(cellKey);
                                return (
                                  <td
                                    key={`${row.sku}-${metric.key}-${skuIndex}`}
                                    className={`fg-sku-value-cell${selected ? ' fg-sku-cell-selected' : ''}`}
                                    onMouseDown={(event) =>
                                      selectSkuCell(metricIndex, skuIndex, event)
                                    }
                                    onMouseEnter={() =>
                                      extendSkuSelection(metricIndex, skuIndex)
                                    }
                                    title={
                                      typeof value === 'number'
                                        ? `Value: ${formatNumber(value)}`
                                        : 'Not numeric'
                                    }
                                  >
                                    <strong>
                                      {value === null || value === undefined
                                        ? '—'
                                        : formatNumber(
                                            typeof value === 'number' && value < 0 ? 0 : value,
                                          )}
                                    </strong>
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                          <tr>
                            <td className="fg-po-total-cell"><strong>PO TOTAL</strong></td>
                            {skuMetrics.map((metric) => {
                              const metricTotal = skuTotalForMetric(metric);
                              return (
                                <td className="fg-po-total-cell" key={`total-${metric.key}`}>
                                  <strong>
                                    {metric.key === 'RM SKU'
                                      ? '—'
                                      : formatNumber(metricTotal < 0 ? 0 : metricTotal)}
                                  </strong>
                                </td>
                              );
                            })}
                          </tr>
                        </>
                      ) : (
                        <tr>
                          <td colSpan={skuMetrics.length + 1} className="fg-fabric-empty">
                            No SKU details available.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                </div>
              </div>

              <div className="fg-reference-review-section">
                <div className="fg-reference-review-heading">
                  <div>
                    <h3>GRN Summary</h3>
                    <p>
                      {skuCalculationType === 'JOB'
                        ? 'JOB PO GRN-level reconciliation from the FG Closer GRN mapping.'
                        : 'FOB / EFOB PO GRN-level reconciliation matching the closure workbook.'}
                      {' '}Quantity is aggregated once per GRN, delay days follow the workbook
                      formula <strong>GRN Date − PO Closer Date</strong>, and Amount With GST
                      uses the workbook&apos;s 5% GST calculation where a single PO rate is available.
                      Fields without a connected source remain blank.
                    </p>
                  </div>
                </div>

                <div className="fg-grn-table-wrap">
                  <div className="fg-grn-table-scroll">
                    <table className="fg-reference-review-table fg-grn-review-table">
                      <thead>
                        <tr>
                          <th>GRN</th>
                          <th>GRN DATE</th>
                          <th>VD NUM.</th>
                          <th>QTY</th>
                          <th>PO CLOSER DATE</th>
                          <th>DELAY DAYS</th>
                          <th>DELAY CHARGE RATE</th>
                          <th>DELAY AMOUNT</th>
                          <th>RATE PER PCS</th>
                          <th>AMOUNT</th>
                          <th>AMOUNT WITH GST</th>
                          <th>VENDOR INVOICE NUMBER</th>
                          <th>INVOICE AMOUNT</th>
                          <th>RG OUT PCS</th>
                          <th>BUSY ENT DT.</th>
                          <th>BUSY ENT AMT</th>
                          <th>RG IN PCS</th>
                          <th>BUSY ENT DT.</th>
                          <th>BUSY ENT AMT</th>

                          {skuCalculationType === 'JOB' ? (
                            <>
                              <th>DG PCS</th>
                              <th>DG ENT DT.</th>
                              <th>DG DN AMT</th>
                            </>
                          ) : (
                            <>
                              <th>FABRIC ISSUE/RECD DATE</th>
                              <th>FABRIC AMOUNT</th>
                            </>
                          )}

                          <th>TRIMS ISSUE/RECD DATE</th>
                          <th>TRIMS AMOUNT</th>
                        </tr>
                      </thead>
                      <tbody>
                        {grnLoading ? (
                          <tr>
                            <td colSpan={skuCalculationType === 'JOB' ? 24 : 23} className="fg-fabric-empty">
                              Loading GRN Summary...
                            </td>
                          </tr>
                        ) : grnRows.length > 0 ? (
                          grnRows.map((grn, index) => (
                            <tr key={`${grn.grn ?? 'grn'}-${grn.grnDate ?? 'date'}-${index}`}>
                              <td><strong>{grn.grn ?? '—'}</strong></td>
                              <td>{formatDate(grn.grnDate)}</td>
                              <td>{grn.vdNum ?? '—'}</td>
                              <td>{formatNumber(grn.qty)}</td>
                              <td>{formatDate(grn.poCloserDate)}</td>
                              <td>{formatNumber(grn.delayDays)}</td>
                              <td>{formatNumber(grn.delayChargeRate)}</td>
                              <td>{formatNumber(grn.delayAmount)}</td>
                              <td>{formatNumber(grn.ratePerPcs)}</td>
                              <td>{formatNumber(grn.amount)}</td>
                              <td>{formatNumber(grn.amountWithGst)}</td>
                              <td>{grn.vendorInvoiceNumber ?? '—'}</td>
                              <td>{formatNumber(grn.invoiceAmount)}</td>
                              <td>{formatNumber(grn.rgOutPcs)}</td>
                              <td>{formatDate(grn.rgOutBusyDate)}</td>
                              <td>{formatNumber(grn.rgOutBusyAmount)}</td>
                              <td>{formatNumber(grn.rgInPcs)}</td>
                              <td>{formatDate(grn.rgInBusyDate)}</td>
                              <td>{formatNumber(grn.rgInBusyAmount)}</td>

                              {skuCalculationType === 'JOB' ? (
                                <>
                                  <td>{formatNumber(grn.dgPcs)}</td>
                                  <td>{formatDate(grn.dgEntryDate)}</td>
                                  <td>{formatNumber(grn.dgDnAmount)}</td>
                                </>
                              ) : (
                                <>
                                  <td>{formatDate(grn.fabricDate)}</td>
                                  <td>{formatNumber(grn.fabricAmount)}</td>
                                </>
                              )}

                              <td>{formatDate(grn.trimsDate)}</td>
                              <td>{formatNumber(grn.trimsAmount)}</td>
                            </tr>
                          ))
                        ) : (
                          <tr>
                            <td colSpan={skuCalculationType === 'JOB' ? 24 : 23} className="fg-fabric-empty">
                              No GRN Summary found for this PO.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              {skuCalculationType === 'JOB' && (
                <div className="fg-reference-review-section">
                  <div className="fg-reference-review-heading">
                    <div>
                      <h3>Fabric Details</h3>
                      <p>
                        JOB-only fabric reconciliation based on the closure workbook.
                        Received PCS, STD/ACH averages and calculated RM usage are shown
                        only where the current FG backend provides the required source data.
                      </p>
                    </div>
                  </div>

                  <div className="fg-fabric-table-wrap">
                    <div className="fg-fabric-table-scroll">
                      <table className="fg-reference-review-table fg-fabric-review-table">
                        <thead>
                          <tr>
                            <th>RM SKU</th>
                            <th>RECEIVED PCS</th>
                            <th>RM ISSUED</th>
                            <th>RM RETURN</th>
                            <th>NET RM ISSUED</th>
                            <th>RM AMOUNT</th>
                            <th>STD AVG</th>
                            <th>ACH AVG</th>
                            <th>STD RM</th>
                            <th>ACH AVG RM</th>
                            <th>RM USED FOR PART CHANGE</th>
                            <th>TOTAL RM USED</th>
                            <th>DIFF IN RM</th>
                            <th>DIFF IN %</th>
                            <th>UWF FABRIC</th>
                            <th>UWF AMOUNT</th>
                            <th>SCRAP RECD</th>
                            <th>SCRAP AMOUNT</th>
                            <th>NET FAB USES</th>
                            <th>FABRIC LOSS</th>
                            <th>FABRIC LOSS %</th>
                          </tr>
                        </thead>
                        <tbody>
                          {fabricLoading ? (
                            <tr>
                              <td colSpan={21} className="fg-fabric-empty">
                                Loading Fabric Details...
                              </td>
                            </tr>
                          ) : fabricRows.length > 0 ? (
                            fabricRows.map((fabric) => (
                              <tr key={fabric.rmSku}>
                                <td><strong>{fabric.rmSku}</strong></td>
                                <td>{formatNumber(fabric.receivedPcs)}</td>
                                <td>{formatNumber(fabric.rmIssued)}</td>
                                <td>{formatNumber(fabric.rmReturn)}</td>
                                <td>{formatNumber(fabric.netRmIssued)}</td>
                                <td>{formatNumber(fabric.rmAmount)}</td>
                                <td>{formatNumber(fabric.stdAvg)}</td>
                                <td>{formatNumber(fabric.achAvg)}</td>
                                <td>{formatNumber(fabric.stdRm)}</td>
                                <td>{formatNumber(fabric.achAvgRm)}</td>
                                <td>{formatNumber(fabric.rmUsedForPartChange)}</td>
                                <td>{formatNumber(fabric.totalRmUsed)}</td>
                                <td>{formatNumber(fabric.diffInRm)}</td>
                                <td>
                                  {fabric.diffInPct == null
                                    ? '—'
                                    : `${formatNumber(fabric.diffInPct * 100)}%`}
                                </td>
                                <td>{formatNumber(fabric.uwfFabric)}</td>
                                <td>{formatNumber(fabric.uwfAmount)}</td>
                                <td>{formatNumber(fabric.scrapRecd)}</td>
                                <td>{formatNumber(fabric.scrapAmount)}</td>
                                <td>{formatNumber(fabric.netFabUses)}</td>
                                <td>{formatNumber(fabric.fabricLoss)}</td>
                                <td>
                                  {fabric.fabricLossPct == null
                                    ? '—'
                                    : `${formatNumber(fabric.fabricLossPct * 100)}%`}
                                </td>
                              </tr>
                            ))
                          ) : (
                            <tr>
                              <td colSpan={21} className="fg-fabric-empty">
                                No Fabric Details found for this JOB PO.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

              <div className="fg-reference-review-section">
                <div className="fg-reference-review-heading">
                  <div>
                    <h3>PO-level Penalty Calculation</h3>
                    <p>
                      Total PO value: <strong>{penaltyCurrency(penaltyTotalPOValue)}</strong> ·
                      {' '}PO quantity: <strong>{formatNumber(penaltyPoQty)}</strong> pcs.
                      Penalties are assessed against the whole PO value; the chargeable amount is shown in the PO TOTAL column.
                    </p>
                  </div>
                </div>
                <div className="fg-fabric-table-wrap">
                  <div className="fg-fabric-table-scroll">
                    <table className="fg-reference-review-table">
                      <thead>
                        <tr>
                          <th>Penalty Category</th>
                          <th>PO TOTAL</th>
                          {selectedDepartment === 'Accounts' ? (
                            <th style={{ width: 320, minWidth: 320 }}>Accounts Review</th>
                          ) : (
                            <th style={{ width: 320, minWidth: 320 }}>Merchandise Review</th>
                          )}
                          <th style={{ width: 320, minWidth: 320 }}>{selectedDepartment === 'Accounts' ? 'Merchandise Review (Read Only)' : 'Accounts Review (Read Only)'}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {poPenaltyRows.map((penalty) => (
                          <tr key={`PO_TOTAL:${penalty.key}`}>
                            <td><strong>{penalty.category}</strong></td>
                            <td><strong>{penalty.amount == null ? 'Needs input' : penaltyCurrency(penalty.amount)}</strong></td>
                            {selectedDepartment === 'Merchandise' && (
                              <td>
                                <textarea
                                  rows={2}
                                  readOnly={reviewReadOnly}
                                  className={reviewReadOnly ? 'fg-review-input fg-review-input-readonly' : 'fg-review-input'}
                                  value={reviewRemarks[`penalty:Merchandise:PO_TOTAL:${penalty.key}`] ?? reviewRemarks[`penalty:merchandise:po_total:${penalty.key}`] ?? reviewRemarks[`penalty:Merchandise:PO_TOTAL:${penalty.key}`.toLowerCase().replace(/[\s_-]+/g, '')] ?? ''}
                                  onChange={(event) => setReviewRemarks((current) => ({
                                    ...current,
                                    [`penalty:Merchandise:PO_TOTAL:${penalty.key}`]: event.target.value,
                                  }))}
                                  placeholder="Merchandise review..."
                                  aria-label={`Merchandise review for ${penalty.category}`}
                                />
                              </td>
                            )}
                            {selectedDepartment === 'Accounts' && (
                              <td style={{ width: 320, minWidth: 320 }}>
                                <textarea
                                  rows={2}
                                  readOnly={reviewReadOnly}
                                  style={{ width: '100%', minWidth: 0, boxSizing: 'border-box' }}
                                  className={reviewReadOnly ? 'fg-review-input fg-review-input-readonly' : 'fg-review-input'}
                                  value={reviewRemarks[`penalty:Accounts:PO_TOTAL:${penalty.key}`] ?? reviewRemarks[`penalty:accounts:po_total:${penalty.key}`] ?? reviewRemarks[`penalty:Accounts:PO_TOTAL:${penalty.key}`.toLowerCase().replace(/[\s_-]+/g, '')] ?? ''}
                                  onChange={(event) => setReviewRemarks((current) => ({
                                    ...current,
                                    [`penalty:Accounts:PO_TOTAL:${penalty.key}`]: event.target.value,
                                  }))}
                                  placeholder="Accounts review..."
                                  aria-label={`Accounts review for ${penalty.category}`}
                                />
                              </td>
                            )}
                            {(
                              <td style={{ width: 320, minWidth: 320 }}>
                                <textarea
                                  rows={2}
                                  readOnly
                                  style={{ width: '100%', minWidth: 0, boxSizing: 'border-box' }}
                                  className="fg-review-input fg-review-input-readonly"
                                  value={getSubmittedPenaltyRemark(selectedDepartment === 'Merchandise' ? 'Accounts' : 'Merchandise', String(selectedPO.po_ref_num ?? '').trim(), penalty.key)}
                                  placeholder={`No ${selectedDepartment === 'Merchandise' ? 'Accounts' : 'Merchandise'} remark submitted.`}
                                  aria-label={`Submitted ${selectedDepartment === 'Merchandise' ? 'Accounts' : 'Merchandise'} review for ${penalty.category}`}
                                />
                              </td>
                            )}
                          </tr>
                        ))}
                        {poPenaltyRows.length === 0 && (
                          <tr><td colSpan={selectedDepartment ? 4 : 2} className="fg-fabric-empty">No PO data is available to calculate penalties.</td></tr>
                        )}
                      </tbody>
                      <tfoot>
                        <tr>
                          <th colSpan={1}>Total calculated penalty for the whole PO</th>
                          <th>
                            {penaltyCurrency(
                              poPenaltyRows.reduce((sum, row) => sum + (row.amount == null ? 0 : row.amount), 0),
                            )}
                          </th>
                          {selectedDepartment && <><td>Review the whole-PO penalty and confirm eligibility before submission.</td><td /></>}
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              </div>

              <div className="fg-reference-note-section">
                <label className="fg-review-label">
                  Additional {selectedDepartment} Remarks
                  <textarea
                    value={reviewText}
                    onChange={(event) => setReviewText(event.target.value)}
                    placeholder={`Add additional ${selectedDepartment.toLowerCase()} remarks...`}
                    rows={3}
                    readOnly={reviewReadOnly && !founderEditing}
                    className={reviewReadOnly && !founderEditing ? 'fg-review-input fg-review-input-readonly' : 'fg-review-input'}
                  />
                </label>
              </div>

              {isDepartmentSubmitted(selectedPO, selectedDepartment === 'Merchandise' ? 'Accounts' : 'Merchandise') && (
                <>
                  <div className="fg-reference-note-section">
                    <label className="fg-review-label">
                      Additional {selectedDepartment === 'Merchandise' ? 'Accounts' : 'Merchandise'} Remarks (Read Only)
                      <textarea
                        value={getSubmittedReviewDetails(selectedDepartment === 'Merchandise' ? 'Accounts' : 'Merchandise', String(selectedPO.po_ref_num ?? '').trim()).additionalRemarks}
                        rows={3}
                        readOnly
                        className="fg-review-input fg-review-input-readonly"
                        placeholder={`No additional ${selectedDepartment === 'Merchandise' ? 'Accounts' : 'Merchandise'} remarks submitted.`}
                      />
                    </label>
                  </div>
                  <div className="fg-reference-document">
                    <FileCheck2 size={18} />
                    <span>
                      <strong>{getSubmittedReviewDetails(selectedDepartment === 'Merchandise' ? 'Accounts' : 'Merchandise', String(selectedPO.po_ref_num ?? '').trim()).documentName}</strong>
                      <small>{selectedDepartment === 'Merchandise' ? 'Accounts' : 'Merchandise'} supporting document (read-only)</small>
                    </span>
                    {getSubmittedReviewDetails(selectedDepartment === 'Merchandise' ? 'Accounts' : 'Merchandise', String(selectedPO.po_ref_num ?? '').trim()).documentPath ? (
                      <button type="button" className="fg-document-button" onClick={() => void openDocument(getSubmittedReviewDetails(selectedDepartment === 'Merchandise' ? 'Accounts' : 'Merchandise', String(selectedPO.po_ref_num ?? '').trim()).documentPath)}>
                        <Eye size={14} /> View document
                      </button>
                    ) : <small>No uploaded document is linked to this submission.</small>}
                  </div>
                </>
              )}

              {reviewReadOnly && !founderEditing ? (
                <div className="fg-reference-document">
                  <FileCheck2 size={18} />
                  <span>
                    <strong>
                      {(() => {
                        const ref = String(selectedPO.po_ref_num ?? '').trim();
                        const workflow = workflowByPoRef[ref];
                        const submission = latestSubmissionByPoRef[selectedDepartment][ref];
                        const workflowName = selectedDepartment === 'Merchandise' ? workflow?.merchandise_document_name : workflow?.accounts_document_name;
                        const dataKey = selectedDepartment === 'Merchandise' ? 'merchandise_data' : 'accounts_data';
                        let snapshot: Record<string, unknown> = {};
                        const rawSnapshot = submission?.[dataKey];
                        if (rawSnapshot && typeof rawSnapshot === 'object' && !Array.isArray(rawSnapshot)) snapshot = rawSnapshot as Record<string, unknown>;
                        else if (typeof rawSnapshot === 'string') { try { const parsed: unknown = JSON.parse(rawSnapshot); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) snapshot = parsed as Record<string, unknown>; } catch { /* ignore legacy non-JSON value */ } }
                        return String(workflowName ?? submission?.document_name ?? submission?.supporting_document_name ?? snapshot.document_name ?? snapshot.supporting_document_name ?? 'Supporting Document');
                      })()}
                    </strong>
                    <small>Submitted document (read-only)</small>
                  </span>
                  {(() => {
                    const ref = String(selectedPO.po_ref_num ?? '').trim();
                    const workflow = workflowByPoRef[ref];
                    const submission = latestSubmissionByPoRef[selectedDepartment][ref];
                    const dataKey = selectedDepartment === 'Merchandise' ? 'merchandise_data' : 'accounts_data';
                    const parseObject = (value: unknown): Record<string, unknown> => {
                      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
                      if (typeof value === 'string') {
                        try {
                          const parsed: unknown = JSON.parse(value);
                          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
                        } catch { /* legacy plain text */ }
                      }
                      return {};
                    };
                    const snapshot = parseObject(submission?.[dataKey]);
                    const workflowPath = selectedDepartment === 'Merchandise'
                      ? workflow?.merchandise_document_path
                      : workflow?.accounts_document_path;
                    const snapshotPath = snapshot.document_path ?? snapshot.document_url ?? snapshot.supporting_document_path;
                    const rawPath = workflowPath ?? submission?.document_path ?? submission?.document_url ?? submission?.supporting_document_path ?? snapshotPath;
                    const path = typeof rawPath === 'string' && rawPath.trim() ? rawPath.trim() : null;
                    return path ? (
                      <button type="button" className="fg-document-button" onClick={() => void openDocument(path)}>
                        <Eye size={14} /> {selectedDepartment === 'Accounts' ? 'VIEW ACCOUNT DOCUMENT' : 'View document'}
                      </button>
                    ) : <small>No uploaded document is linked to this submission. If the earlier upload failed, please upload the file again and submit.</small>;
                  })()}
                </div>
              ) : (
                <label className="fg-reference-document">
                  <Upload size={18} />
                  <span>
                    <strong>{selectedDocument ? selectedDocument.name : 'Accounts Supporting Document'}</strong>
                    <small>{selectedDocument ? 'Replacement document selected' : 'Upload a replacement Accounts supporting document.'}</small>
                  </span>
                  <input
                    type="file"
                    onChange={(event) => setSelectedDocument(event.target.files?.[0] ?? null)}
                  />
                </label>
              )}

              {workflowMessage && (
                <div className="fg-send-message">
                  <CheckCircle2 size={17} />
                  <span>{workflowMessage}</span>
                </div>
              )}
              {workflowError && (
                <div className="fg-error fg-modal-error">
                  <XCircle size={17} />
                  <span>{workflowError}</span>
                </div>
              )}
            </div>

            <div className="fg-modal-footer">
              <button type="button" className="fg-modal-secondary" onClick={closeInitiateModal}>
                {reviewReadOnly ? 'Close' : 'Cancel'}
              </button>
              {!reviewReadOnly && (
                <button
                  type="button"
                  className="fg-modal-primary"
                  disabled={savingReview}
                  onClick={saveDepartmentReview}
                >
                  {savingReview ? 'Saving...' : 'Save & Send'} <ArrowRight size={16} />
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {selectedPO && reviewMode === 'founder' && (
        <div className="fg-modal-backdrop" onMouseDown={closeInitiateModal}>
          <div
            className="fg-modal fg-review-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="fg-founder-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="fg-modal-header">
              <div>
                <div className="fg-modal-eyebrow">FOUNDER FINAL REVIEW</div>
                <h2 id="fg-founder-title">Final Approval</h2>
                <p>{selectedPO.po_ref_num ?? 'PO reference unavailable'}</p>
              </div>
              <button
                type="button"
                className="fg-modal-close"
                onClick={closeInitiateModal}
                aria-label="Close"
              >
                <X size={19} />
              </button>
            </div>

            <div className="fg-modal-body fg-reference-review-body">
              <div className="fg-reference-po-details">
                <div><span>PO Reference</span><strong>{selectedPO.po_ref_num ?? '—'}</strong></div>
                <div><span>PO Number</span><strong>{selectedPO.po_number ?? '—'}</strong></div>
                <div><span>PO Date</span><strong>{formatDate(selectedPO.po_date)}</strong></div>
                <div><span>Expected Delivery</span><strong>{formatDate(selectedPO.expected_delivery_date)}</strong></div>
                <div><span>Vendor</span><strong>{selectedPO.vendor_name ?? '—'}</strong></div>
                <div><span>Vendor Code</span><strong>{selectedPO.vendor_code ?? '—'}</strong></div>
                <div><span>PO Quantity</span><strong>{formatNumber(selectedPO.po_qty)}</strong></div>
                <div><span>Total PO Value</span><strong>{penaltyCurrency(penaltyTotalPOValue)}</strong></div>
                <div><span>GRN Received Qty</span><strong>{formatNumber(selectedPO.grn_qty)}</strong></div>
                <div><span>Pending Quantity</span><strong>{formatNumber(selectedPO.pending_qty)}</strong></div>
                <div><span>Cutting Quantity</span><strong>{formatNumber(selectedPO.cutting_qty)}</strong></div>
                <div><span>Last GRN</span><strong>{formatDate(selectedPO.last_grn_date)}</strong></div>
                <div><span>Avg GRN TAT</span><strong>{selectedPO.avg_grn_tat_days == null ? '—' : `${formatNumber(selectedPO.avg_grn_tat_days)} days`}</strong></div>
              </div>

              <div className="fg-reference-review-section">
                <div className="fg-reference-review-heading">
                  <div>
                    <h3>TNA & Delivery</h3>
                    <p>Track the PO-level vendor and TNA delay metrics before reviewing the closure.</p>
                  </div>
                </div>

                <div style={{ width: '100%', overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                    <thead>
                      <tr>
                        <th
                          style={{
                            width: '38%',
                            padding: '8px 10px',
                            textAlign: 'left',
                            fontSize: '11px',
                            fontWeight: 600,
                            color: '#64748b',
                            background: '#f8fafc',
                            borderBottom: '1px solid #e2e8f0',
                          }}
                        >
                          Metric
                        </th>
                        <th
                          style={{
                            padding: '8px 10px',
                            textAlign: 'left',
                            fontSize: '11px',
                            fontWeight: 600,
                            color: '#64748b',
                            background: '#f8fafc',
                            borderBottom: '1px solid #e2e8f0',
                          }}
                        >
                          Value
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        ['Vendor Delay', selectedPO.vendor_delay_days == null ? '—' : `${formatNumber(selectedPO.vendor_delay_days)} days`],
                        ['PP Sample Delay', selectedPO.pp_delay_days == null ? '—' : `${formatNumber(selectedPO.pp_delay_days)} days`],
                        ['GPT Delay', selectedPO.gpt_delay_days == null ? '—' : `${formatNumber(selectedPO.gpt_delay_days)} days`],
                        ['Inline QC Delay', selectedPO.inline_qc_delay_days == null ? '—' : `${formatNumber(selectedPO.inline_qc_delay_days)} days`],
                        ['Planned Date', formatDate(typeof selectedPO.planned_date === 'string' ? selectedPO.planned_date : null)],
                        ['Expected Delivery', formatDate(selectedPO.expected_delivery_date)],
                        ['Last GRN', formatDate(selectedPO.last_grn_date)],
                        ['Avg GRN TAT', selectedPO.avg_grn_tat_days == null ? '—' : `${formatNumber(selectedPO.avg_grn_tat_days)} days`],
                      ].map(([label, value]) => (
                        <tr key={label}>
                          <th
                            scope="row"
                            style={{
                              padding: '8px 10px',
                              textAlign: 'left',
                              fontSize: '12px',
                              fontWeight: 600,
                              color: '#64748b',
                              background: '#f8fafc',
                              borderBottom: '1px solid #e2e8f0',
                            }}
                          >
                            {label}
                          </th>
                          <td
                            style={{
                              padding: '8px 10px',
                              fontSize: '12px',
                              fontWeight: 600,
                              color: '#0f172a',
                              borderBottom: '1px solid #e2e8f0',
                            }}
                          >
                            {value}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="fg-reference-review-section">
                <div className="fg-reference-review-heading">
                  <div>
                    <h3>SKU Wise Details</h3>
                    <p>{skuCalculationType === 'JOB' ? 'JOB PO: calculations follow the JOB workbook logic.' : 'FOB / EFOB PO: calculations follow the FOB / EFOB logic.'}</p>
                  </div>
                </div>

                <div className="fg-reference-review-table-wrap">
                <div className="fg-sku-table-toolbar">
                  <span>
                    {skuCalculationType === 'JOB' ? 'JOB calculation' : 'FOB / EFOB calculation'} · {skuCellSelection.size > 0
                      ? `${skuCellSelection.size} cell${skuCellSelection.size === 1 ? '' : 's'} selected`
                      : 'Select cells to calculate a sum'}
                  </span>

                  <div className="fg-sku-selection-summary">
                    <strong>SUM</strong>
                    <strong>{formatNumber(selectedSkuSum)}</strong>
                    {skuCellSelection.size > 0 && (
                      <button type="button" onClick={clearSkuSelection}>
                        Clear
                      </button>
                    )}
                  </div>
                </div>

                <div className="fg-sku-table-scroll">
                  <table className="fg-reference-review-table fg-sku-review-table">
                    <thead>
                      <tr>
                        <th>SKU</th>
                        {skuMetrics.map((metric) => (
                          <th key={metric.key}>{metric.key}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {skuRows.length > 0 ? (
                        <>
                          {skuRows.map((row, skuIndex) => (
                            <tr key={`${row.po_id ?? 'po'}-${row.sku}-${skuIndex}`}>
                              <td className="fg-sku-label-cell">
                                <strong>{row.sku || '—'}</strong>
                              </td>
                              {skuMetrics.map((metric, metricIndex) => {
                                const cellKey = getSkuCellKey(metricIndex, skuIndex);
                                const value = metric.getValue(row);
                                const selected = skuCellSelection.has(cellKey);
                                return (
                                  <td
                                    key={`${row.sku}-${metric.key}-${skuIndex}`}
                                    className={`fg-sku-value-cell${selected ? ' fg-sku-cell-selected' : ''}`}
                                    onMouseDown={(event) =>
                                      selectSkuCell(metricIndex, skuIndex, event)
                                    }
                                    onMouseEnter={() =>
                                      extendSkuSelection(metricIndex, skuIndex)
                                    }
                                    title={
                                      typeof value === 'number'
                                        ? `Value: ${formatNumber(value)}`
                                        : 'Not numeric'
                                    }
                                  >
                                    <strong>
                                      {value === null || value === undefined
                                        ? '—'
                                        : formatNumber(
                                            typeof value === 'number' && value < 0 ? 0 : value,
                                          )}
                                    </strong>
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                          <tr>
                            <td className="fg-po-total-cell"><strong>PO TOTAL</strong></td>
                            {skuMetrics.map((metric) => {
                              const metricTotal = skuTotalForMetric(metric);
                              return (
                                <td className="fg-po-total-cell" key={`total-${metric.key}`}>
                                  <strong>
                                    {metric.key === 'RM SKU'
                                      ? '—'
                                      : formatNumber(metricTotal < 0 ? 0 : metricTotal)}
                                  </strong>
                                </td>
                              );
                            })}
                          </tr>
                        </>
                      ) : (
                        <tr>
                          <td colSpan={skuMetrics.length + 1} className="fg-fabric-empty">
                            No SKU details available.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                </div>
              </div>

              <div className="fg-reference-review-section">
                <div className="fg-reference-review-heading">
                  <div>
                    <h3>GRN Summary</h3>
                    <p>
                      {skuCalculationType === 'JOB'
                        ? 'JOB PO GRN-level reconciliation from the FG Closer GRN mapping.'
                        : 'FOB / EFOB PO GRN-level reconciliation matching the closure workbook.'}
                      {' '}Quantity is aggregated once per GRN, delay days follow the workbook
                      formula <strong>GRN Date − PO Closer Date</strong>, and Amount With GST
                      uses the workbook&apos;s 5% GST calculation where a single PO rate is available.
                      Fields without a connected source remain blank.
                    </p>
                  </div>
                </div>

                <div className="fg-grn-table-wrap">
                  <div className="fg-grn-table-scroll">
                    <table className="fg-reference-review-table fg-grn-review-table">
                      <thead>
                        <tr>
                          <th>GRN</th>
                          <th>GRN DATE</th>
                          <th>VD NUM.</th>
                          <th>QTY</th>
                          <th>PO CLOSER DATE</th>
                          <th>DELAY DAYS</th>
                          <th>DELAY CHARGE RATE</th>
                          <th>DELAY AMOUNT</th>
                          <th>RATE PER PCS</th>
                          <th>AMOUNT</th>
                          <th>AMOUNT WITH GST</th>
                          <th>VENDOR INVOICE NUMBER</th>
                          <th>INVOICE AMOUNT</th>
                          <th>RG OUT PCS</th>
                          <th>BUSY ENT DT.</th>
                          <th>BUSY ENT AMT</th>
                          <th>RG IN PCS</th>
                          <th>BUSY ENT DT.</th>
                          <th>BUSY ENT AMT</th>

                          {skuCalculationType === 'JOB' ? (
                            <>
                              <th>DG PCS</th>
                              <th>DG ENT DT.</th>
                              <th>DG DN AMT</th>
                            </>
                          ) : (
                            <>
                              <th>FABRIC ISSUE/RECD DATE</th>
                              <th>FABRIC AMOUNT</th>
                            </>
                          )}

                          <th>TRIMS ISSUE/RECD DATE</th>
                          <th>TRIMS AMOUNT</th>
                        </tr>
                      </thead>
                      <tbody>
                        {grnLoading ? (
                          <tr>
                            <td colSpan={skuCalculationType === 'JOB' ? 24 : 23} className="fg-fabric-empty">
                              Loading GRN Summary...
                            </td>
                          </tr>
                        ) : grnRows.length > 0 ? (
                          grnRows.map((grn, index) => (
                            <tr key={`${grn.grn ?? 'grn'}-${grn.grnDate ?? 'date'}-${index}`}>
                              <td><strong>{grn.grn ?? '—'}</strong></td>
                              <td>{formatDate(grn.grnDate)}</td>
                              <td>{grn.vdNum ?? '—'}</td>
                              <td>{formatNumber(grn.qty)}</td>
                              <td>{formatDate(grn.poCloserDate)}</td>
                              <td>{formatNumber(grn.delayDays)}</td>
                              <td>{formatNumber(grn.delayChargeRate)}</td>
                              <td>{formatNumber(grn.delayAmount)}</td>
                              <td>{formatNumber(grn.ratePerPcs)}</td>
                              <td>{formatNumber(grn.amount)}</td>
                              <td>{formatNumber(grn.amountWithGst)}</td>
                              <td>{grn.vendorInvoiceNumber ?? '—'}</td>
                              <td>{formatNumber(grn.invoiceAmount)}</td>
                              <td>{formatNumber(grn.rgOutPcs)}</td>
                              <td>{formatDate(grn.rgOutBusyDate)}</td>
                              <td>{formatNumber(grn.rgOutBusyAmount)}</td>
                              <td>{formatNumber(grn.rgInPcs)}</td>
                              <td>{formatDate(grn.rgInBusyDate)}</td>
                              <td>{formatNumber(grn.rgInBusyAmount)}</td>

                              {skuCalculationType === 'JOB' ? (
                                <>
                                  <td>{formatNumber(grn.dgPcs)}</td>
                                  <td>{formatDate(grn.dgEntryDate)}</td>
                                  <td>{formatNumber(grn.dgDnAmount)}</td>
                                </>
                              ) : (
                                <>
                                  <td>{formatDate(grn.fabricDate)}</td>
                                  <td>{formatNumber(grn.fabricAmount)}</td>
                                </>
                              )}

                              <td>{formatDate(grn.trimsDate)}</td>
                              <td>{formatNumber(grn.trimsAmount)}</td>
                            </tr>
                          ))
                        ) : (
                          <tr>
                            <td colSpan={skuCalculationType === 'JOB' ? 24 : 23} className="fg-fabric-empty">
                              No GRN Summary found for this PO.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              {skuCalculationType === 'JOB' && (
                <div className="fg-reference-review-section">
                  <div className="fg-reference-review-heading">
                    <div>
                      <h3>Fabric Details</h3>
                      <p>
                        JOB-only fabric reconciliation based on the closure workbook.
                        Received PCS, STD/ACH averages and calculated RM usage are shown
                        only where the current FG backend provides the required source data.
                      </p>
                    </div>
                  </div>

                  <div className="fg-fabric-table-wrap">
                    <div className="fg-fabric-table-scroll">
                      <table className="fg-reference-review-table fg-fabric-review-table">
                        <thead>
                          <tr>
                            <th>RM SKU</th>
                            <th>RECEIVED PCS</th>
                            <th>RM ISSUED</th>
                            <th>RM RETURN</th>
                            <th>NET RM ISSUED</th>
                            <th>RM AMOUNT</th>
                            <th>STD AVG</th>
                            <th>ACH AVG</th>
                            <th>STD RM</th>
                            <th>ACH AVG RM</th>
                            <th>RM USED FOR PART CHANGE</th>
                            <th>TOTAL RM USED</th>
                            <th>DIFF IN RM</th>
                            <th>DIFF IN %</th>
                            <th>UWF FABRIC</th>
                            <th>UWF AMOUNT</th>
                            <th>SCRAP RECD</th>
                            <th>SCRAP AMOUNT</th>
                            <th>NET FAB USES</th>
                            <th>FABRIC LOSS</th>
                            <th>FABRIC LOSS %</th>
                          </tr>
                        </thead>
                        <tbody>
                          {fabricLoading ? (
                            <tr>
                              <td colSpan={21} className="fg-fabric-empty">
                                Loading Fabric Details...
                              </td>
                            </tr>
                          ) : fabricRows.length > 0 ? (
                            fabricRows.map((fabric) => (
                              <tr key={fabric.rmSku}>
                                <td><strong>{fabric.rmSku}</strong></td>
                                <td>{formatNumber(fabric.receivedPcs)}</td>
                                <td>{formatNumber(fabric.rmIssued)}</td>
                                <td>{formatNumber(fabric.rmReturn)}</td>
                                <td>{formatNumber(fabric.netRmIssued)}</td>
                                <td>{formatNumber(fabric.rmAmount)}</td>
                                <td>{formatNumber(fabric.stdAvg)}</td>
                                <td>{formatNumber(fabric.achAvg)}</td>
                                <td>{formatNumber(fabric.stdRm)}</td>
                                <td>{formatNumber(fabric.achAvgRm)}</td>
                                <td>{formatNumber(fabric.rmUsedForPartChange)}</td>
                                <td>{formatNumber(fabric.totalRmUsed)}</td>
                                <td>{formatNumber(fabric.diffInRm)}</td>
                                <td>
                                  {fabric.diffInPct == null
                                    ? '—'
                                    : `${formatNumber(fabric.diffInPct * 100)}%`}
                                </td>
                                <td>{formatNumber(fabric.uwfFabric)}</td>
                                <td>{formatNumber(fabric.uwfAmount)}</td>
                                <td>{formatNumber(fabric.scrapRecd)}</td>
                                <td>{formatNumber(fabric.scrapAmount)}</td>
                                <td>{formatNumber(fabric.netFabUses)}</td>
                                <td>{formatNumber(fabric.fabricLoss)}</td>
                                <td>
                                  {fabric.fabricLossPct == null
                                    ? '—'
                                    : `${formatNumber(fabric.fabricLossPct * 100)}%`}
                                </td>
                              </tr>
                            ))
                          ) : (
                            <tr>
                              <td colSpan={21} className="fg-fabric-empty">
                                No Fabric Details found for this JOB PO.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

              <div className="fg-reference-review-section">
                <div className="fg-reference-review-heading">
                  <div>
                    <h3>PO-level Penalty Calculation</h3>
                    <p>
                      Total PO value: <strong>{penaltyCurrency(penaltyTotalPOValue)}</strong> ·
                      {' '}PO quantity: <strong>{formatNumber(penaltyPoQty)}</strong> pcs.
                      Penalties are assessed against the whole PO value; the chargeable amount is shown in the PO TOTAL column.
                    </p>
                  </div>
                </div>
                <div className="fg-fabric-table-wrap">
                  <div className="fg-fabric-table-scroll">
                    <table className="fg-reference-review-table">
                      <thead>
                        <tr>
                          <th>Penalty Category</th>
                          <th>PO TOTAL</th>
                          <th style={{ width: 320, minWidth: 320 }}>Accounts Review</th>
                          {reviewMode === 'founder' && (
                            <>
                              <th style={{ width: 320, minWidth: 320 }}>Merchandise Review</th>
                              <th style={{ width: 320, minWidth: 320 }}>Founder Review</th>
                            </>
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {poPenaltyRows.map((penalty) => (
                          <tr key={`PO_TOTAL:${penalty.key}`}>
                            <td><strong>{penalty.category}</strong></td>
                            <td><strong>{penalty.amount == null ? 'Needs input' : penaltyCurrency(penalty.amount)}</strong></td>
                            <td style={{ width: 320, minWidth: 320 }}>
                              <textarea
                                rows={2}
                                readOnly={reviewMode === 'founder' || (reviewReadOnly && !founderEditing)}
                                onChange={(event) => setReviewRemarks((current) => ({ ...current, [`penalty:Accounts:PO_TOTAL:${penalty.key}`]: event.target.value }))}
                                style={{ width: '100%', minWidth: 0, boxSizing: 'border-box' }}
                                className={reviewMode === 'founder' || (reviewReadOnly && !founderEditing) ? 'fg-review-input fg-review-input-readonly' : 'fg-review-input'}
                                value={reviewRemarks[`penalty:Accounts:PO_TOTAL:${penalty.key}`] ?? reviewRemarks[`penalty:accounts:po_total:${penalty.key}`] ?? reviewRemarks[`penalty:Accounts:PO_TOTAL:${penalty.key}`.toLowerCase().replace(/[\s_-]+/g, '')] ?? ''}
                                placeholder="Accounts review..."
                                aria-label={`Accounts review for ${penalty.category}`}
                              />
                            </td>
                            {reviewMode === 'founder' && (
                            <td style={{ width: 320, minWidth: 320 }}>
                              <textarea
                                rows={2}
                                readOnly
                                onChange={(event) => setFounderMerchandiseRemarks((current) => ({ ...current, [`penalty:Merchandise:PO_TOTAL:${penalty.key}`]: event.target.value }))}
                                style={{ width: '100%', minWidth: 0, boxSizing: 'border-box' }}
                                className="fg-review-input fg-review-input-readonly"
                                value={founderEditing ? (founderMerchandiseRemarks[`penalty:Merchandise:PO_TOTAL:${penalty.key}`] ?? '') : getFounderMerchandiseRemark(String(selectedPO.po_ref_num ?? '').trim(), penalty.key)}
                                placeholder="Merchandise review..."
                                aria-label={`Merchandise review for ${penalty.category}`}
                              />
                            </td>
                            )}
                            {reviewMode === 'founder' && (
                              <td style={{ width: 320, minWidth: 320 }}>
                                <textarea
                                  rows={2}
                                  readOnly={reviewMode !== 'founder' || !founderEditing || workflowByPoRef[String(selectedPO.po_ref_num ?? '').trim()]?.status === 'Closed' || String(selectedPO.po_status ?? '').toLowerCase() === 'closed'}
                                  onChange={(event) => setFounderReviewRemarks((current) => ({ ...current, [`penalty:Founder:PO_TOTAL:${penalty.key}`]: event.target.value }))}
                                  style={{ width: '100%', minWidth: 0, boxSizing: 'border-box' }}
                                  className={reviewMode !== 'founder' || !founderEditing || workflowByPoRef[String(selectedPO.po_ref_num ?? '').trim()]?.status === 'Closed' || String(selectedPO.po_status ?? '').toLowerCase() === 'closed' ? 'fg-review-input fg-review-input-readonly' : 'fg-review-input'}
                                  value={founderReviewRemarks[`penalty:Founder:PO_TOTAL:${penalty.key}`] ?? getFounderReviewRemarks(String(selectedPO.po_ref_num ?? '').trim())[`penalty:Founder:PO_TOTAL:${penalty.key}`] ?? ''}
                                  placeholder="Founder review..."
                                  aria-label={`Founder review for ${penalty.category}`}
                                />
                              </td>
                            )}
                          </tr>
                        ))}
                        {poPenaltyRows.length === 0 && (
                          <tr><td colSpan={reviewMode === 'founder' ? 5 : 3} className="fg-fabric-empty">No PO data is available to calculate penalties.</td></tr>
                        )}
                      </tbody>
                      <tfoot>
                        <tr>
                          <th colSpan={1}>Total calculated penalty for the whole PO</th>
                          <th>
                            {penaltyCurrency(
                              poPenaltyRows.reduce((sum, row) => sum + (row.amount == null ? 0 : row.amount), 0),
                            )}
                          </th>
                          <td colSpan={reviewMode === 'founder' ? 3 : 1}>Review the whole-PO penalty and confirm eligibility before submission.</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              </div>

              <div className="fg-reference-note-section">
                <label className="fg-review-label">
                  Additional {founderReviewDepartment} Remarks
                  <textarea
                    value={reviewText}
                    onChange={(event) => setReviewText(event.target.value)}
                    placeholder={`Add additional ${founderReviewDepartment.toLowerCase()} remarks...`}
                    rows={3}
                    readOnly={reviewReadOnly && !founderEditing}
                    className={reviewReadOnly && !founderEditing ? 'fg-review-input fg-review-input-readonly' : 'fg-review-input'}
                  />
                </label>
              </div>

              {reviewMode === 'founder' && (reviewReadOnly || founderEditing) && (
                <div className="fg-reference-note-section">
                  <label className="fg-review-label">
                    Additional Merchandise Remarks
                    <textarea
                      value={founderEditing ? founderMerchandiseText : getSubmittedReviewDetails('Merchandise', String(selectedPO.po_ref_num ?? '').trim()).additionalRemarks}
                      rows={3}
                      onChange={(event) => setFounderMerchandiseText(event.target.value)}
                      readOnly={!founderEditing}
                      className={!founderEditing ? 'fg-review-input fg-review-input-readonly' : 'fg-review-input'}
                      placeholder="No additional merchandise remarks submitted."
                      aria-label="Additional Merchandise Remarks"
                    />
                  </label>
                </div>
              )}

              {reviewReadOnly && !founderEditing ? (
                <div className="fg-reference-document">
                  <FileCheck2 size={18} />
                  <span>
                    <strong>
                      {(() => {
                        const ref = String(selectedPO.po_ref_num ?? '').trim();
                        return getSubmittedReviewDetails(founderReviewDepartment, ref).documentName;
                      })()}
                    </strong>
                    <small>Submitted document (read-only)</small>
                  </span>
                  {(() => {
                    const ref = String(selectedPO.po_ref_num ?? '').trim();
                    const path = getSubmittedReviewDetails(founderReviewDepartment, ref).documentPath;
                    return path ? (
                      <button type="button" className="fg-document-button" onClick={() => void openDocument(path)}>
                        <Eye size={14} /> {founderReviewDepartment === 'Accounts' ? 'VIEW ACCOUNT DOCUMENT' : 'View document'}
                      </button>
                    ) : <small>No uploaded document is linked to this submission. If the earlier upload failed, please upload the file again and submit.</small>;
                  })()}
                </div>
              ) : (
                <label className="fg-reference-document">
                  <Upload size={18} />
                  <span>
                    <strong>{selectedDocument ? selectedDocument.name : 'Accounts Supporting Document'}</strong>
                    <small>{selectedDocument ? 'Replacement document selected' : 'Upload a replacement Accounts supporting document.'}</small>
                  </span>
                  <input
                    type="file"
                    onChange={(event) => setSelectedDocument(event.target.files?.[0] ?? null)}
                  />
                </label>
              )}

              {reviewMode === 'founder' && (reviewReadOnly || founderEditing) && (
                founderEditing ? (
                  <label className="fg-reference-document">
                    <Upload size={18} />
                    <span>
                      <strong>{selectedFounderMerchandiseDocument ? selectedFounderMerchandiseDocument.name : 'Merchandise Supporting Document'}</strong>
                      <small>{selectedFounderMerchandiseDocument ? 'Replacement document selected' : 'Upload a replacement Merchandise supporting document.'}</small>
                    </span>
                    <input type="file" onChange={(event) => setSelectedFounderMerchandiseDocument(event.target.files?.[0] ?? null)} />
                  </label>
                ) : (
                <div className="fg-reference-document">
                  <FileCheck2 size={18} />
                  <span>
                    <strong>
                      {(() => {
                        const ref = String(selectedPO.po_ref_num ?? '').trim();
                        return getSubmittedReviewDetails('Merchandise', ref).documentName;
                      })()}
                    </strong>
                    <small>Merchandise submitted document (read-only)</small>
                  </span>
                  {(() => {
                    const ref = String(selectedPO.po_ref_num ?? '').trim();
                    const path = getSubmittedReviewDetails('Merchandise', ref).documentPath;
                    return path ? (
                      <button type="button" className="fg-document-button" onClick={() => void openDocument(path)}>
                        <Eye size={14} /> VIEW MERCHANDISE DOCUMENT
                      </button>
                    ) : <small>No merchandise document is linked to this submission.</small>;
                  })()}
                </div>
                )
              )}

              {workflowMessage && (
                <div className="fg-send-message">
                  <CheckCircle2 size={17} />
                  <span>{workflowMessage}</span>
                </div>
              )}
              {workflowError && (
                <div className="fg-error fg-modal-error">
                  <XCircle size={17} />
                  <span>{workflowError}</span>
                </div>
              )}
            </div>

            <div className="fg-modal-footer">
              {workflowByPoRef[String(selectedPO.po_ref_num ?? '')]?.status !== 'Closed' && String(selectedPO.po_status ?? '').toLowerCase() !== 'closed' && (
                <>
                  {founderEditing ? (
                    <>
                      <button type="button" className="fg-modal-secondary" disabled={savingReview} onClick={() => { setFounderEditing(false); setSelectedDocument(null); setSelectedFounderMerchandiseDocument(null); setWorkflowError(''); }}>
                        Cancel Edit
                      </button>
                      <button type="button" className="fg-modal-primary" disabled={savingReview || approvingFounder} onClick={() => void saveFounderEdits()}>
                        {savingReview ? 'Saving...' : 'Save Changes'} <CheckCircle2 size={16} />
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="fg-modal-secondary"
                      disabled={approvingFounder}
                      onClick={() => {
                        const ref = String(selectedPO.po_ref_num ?? '').trim();
                        const merchandiseDetails = getSubmittedReviewDetails('Merchandise', ref);
                        const merchandiseValues: Record<string, string> = {};
                        poPenaltyRows.forEach((penalty) => {
                          merchandiseValues[`penalty:Merchandise:PO_TOTAL:${penalty.key}`] = getFounderMerchandiseRemark(ref, penalty.key);
                        });
                        setFounderMerchandiseRemarks(merchandiseValues);
                        setFounderReviewRemarks(getFounderReviewRemarks(ref));
                        setFounderMerchandiseText(merchandiseDetails.additionalRemarks);
                        setSelectedDocument(null);
                        setSelectedFounderMerchandiseDocument(null);
                        setFounderEditing(true);
                        setWorkflowError('');
                      }}
                    >
                      Edit <Upload size={16} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="fg-founder-approve-button"
                    disabled={approvingFounder || savingReview || founderEditing}
                    onClick={approveFounderReview}
                  >
                    {approvingFounder ? 'Approving...' : 'Approve'} <CheckCircle2 size={16} />
                  </button>
                </>
              )}
              <button type="button" className="fg-modal-secondary" onClick={closeInitiateModal}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      <style jsx>{`
        .fg-closer {
          width: 100%;
          display: flex;
          flex-direction: column;
          gap: 20px;
        }

        .fg-kpi-grid {
          display: grid;
          grid-template-columns: repeat(5, minmax(0, 1fr));
          gap: 14px;
        }

        .fg-kpi-card {
          min-height: 132px;
          padding: 18px 19px;
          background: #ffffff;
          border: 1px solid #e5e7eb;
          border-radius: 12px;
          box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04), 0 4px 12px rgba(15, 23, 42, 0.035);
          display: flex;
          flex-direction: column;
          justify-content: space-between;
        }

        .fg-kpi-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
        }

        .fg-kpi-label {
          font-size: 10px;
          line-height: 1.2;
          font-weight: 700;
          letter-spacing: 0.075em;
          color: #6b7280;
        }

        .fg-kpi-icon {
          width: 31px;
          height: 31px;
          border-radius: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .fg-icon-neutral { background: #f3f4f6; color: #4b5563; }
        .fg-icon-ready { background: #fff7df; color: #b77900; }
        .fg-icon-review { background: #eef5ff; color: #3569a8; }
        .fg-icon-accounts { background: #f3efff; color: #6950a7; }
        .fg-icon-closed { background: #eaf8ef; color: #23804a; }

        .fg-kpi-value {
          margin-top: 8px;
          font-size: 27px;
          line-height: 1;
          font-weight: 650;
          letter-spacing: -0.025em;
          color: #111827;
        }

        .fg-kpi-meta {
          margin-top: 8px;
          font-size: 11px;
          color: #8a919b;
        }

        .fg-error {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          padding: 13px 15px;
          background: #fff5f5;
          border: 1px solid #f1d2d2;
          border-radius: 9px;
          color: #8d3535;
        }

        .fg-error-icon { flex-shrink: 0; display: flex; margin-top: 1px; }
        .fg-error strong { display: block; font-size: 12px; font-weight: 650; }
        .fg-error span { display: block; margin-top: 3px; font-size: 11px; color: #9a5b5b; word-break: break-word; }

        .fg-toolbar {
          display: flex;
          align-items: center;
          gap: 10px;
          width: 100%;
        }

        .fg-search {
          height: 44px;
          flex: 0 1 460px;
          width: min(460px, 100%);
          min-width: 220px;
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 0 13px;
          background: #ffffff;
          border: 1px solid #dfe3e8;
          border-radius: 9px;
          color: #7a818b;
        }

        .fg-search:focus-within { border-color: #b9c1ca; box-shadow: 0 0 0 3px rgba(17, 24, 39, 0.045); }
        .fg-search input { width: 100%; border: 0; outline: 0; background: transparent; color: #20252b; font: inherit; font-size: 13px; }
        .fg-search input::placeholder { color: #9aa1aa; }
        .fg-search-clear { border: 0; background: transparent; padding: 2px; display: flex; align-items: center; color: #9aa1aa; cursor: pointer; }

        .fg-toolbar-actions {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-shrink: 0;
          height: 44px;
        }

        .fg-toolbar-button {
          height: 44px;
          padding: 0 11px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          border: 1px solid #dfe3e8;
          border-radius: 8px;
          background: #ffffff;
          color: #4d5660;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          white-space: nowrap;
        }

        .fg-toolbar-button:hover,
        .fg-toolbar-button.active {
          border-color: #c8cfd7;
          background: #f8f9fa;
          color: #20252b;
        }

        .fg-toolbar-button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .fg-filter-count {
          min-width: 18px;
          height: 18px;
          padding: 0 5px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 999px;
          background: #20252b;
          color: #ffffff;
          font-size: 10px;
          font-weight: 700;
        }

        .fg-vendor-filter-wrap {
          position: relative;
        }

        .fg-vendor-menu {
          position: absolute;
          top: calc(100% + 6px);
          right: 0;
          width: 250px;
          max-height: 300px;
          padding: 8px;
          background: #ffffff;
          border: 1px solid #e1e5e9;
          border-radius: 10px;
          box-shadow: 0 8px 22px rgba(15, 23, 42, 0.10);
          z-index: 100;
        }

        .fg-vendor-menu-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 2px 3px 8px;
          border-bottom: 1px solid #edf0f2;
          font-size: 12px;
        }

        .fg-vendor-menu-head button {
          border: 0;
          background: transparent;
          color: #8b6a00;
          font-size: 11px;
          font-weight: 650;
          cursor: pointer;
        }

        .fg-vendor-options {
          max-height: 260px;
          overflow: auto;
          padding-top: 5px;
        }

        .fg-vendor-option {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 7px 4px;
          border-radius: 6px;
          color: #4c535b;
          font-size: 11px;
          cursor: pointer;
        }

        .fg-vendor-option:hover { background: #f7f8f9; }
        .fg-vendor-option input { margin: 0; }
        .fg-vendor-empty { display: block; padding: 12px 4px; color: #9aa1aa; font-size: 11px; }

        .fg-date-header {
          position: relative;
          display: inline-flex;
        }

        .fg-date-header-button {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 0;
          border: 0;
          background: transparent;
          color: inherit;
          font: inherit;
          letter-spacing: inherit;
          text-transform: inherit;
          cursor: pointer;
        }

        .fg-date-header-button:hover { color: #20252b; }

        .fg-date-menu {
          position: fixed;
          width: 156px;
          padding: 4px;
          background: #ffffff;
          border: 1px solid #e1e5e9;
          border-radius: 9px;
          box-shadow: 0 8px 22px rgba(15, 23, 42, 0.10);
          z-index: 1000;
        }

        .fg-date-menu button {
          width: 100%;
          height: 31px;
          padding: 0 9px;
          border: 0;
          border-radius: 6px;
          background: transparent;
          color: #4c535b;
          text-align: left;
          font-size: 11px;
          font-weight: 600;
          cursor: pointer;
        }

        .fg-date-menu button:hover,
        .fg-date-menu button.active {
          background: #f5f6f7;
          color: #20252b;
        }

        .fg-date-menu .fg-date-clear {
          margin-top: 3px;
          border-top: 1px solid #edf0f2;
          border-radius: 0 0 6px 6px;
          color: #8a919b;
          font-weight: 500;
        }

        .fg-primary-button {
          height: 44px;
          padding: 0 17px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          border: 1px solid #e0b900;
          border-radius: 9px;
          background: #f6c800;
          color: #151515;
          font-size: 13px;
          font-weight: 650;
          cursor: pointer;
          white-space: nowrap;
        }

        .fg-filter-bar {
          display: flex;
          align-items: center;
          gap: 3px;
          padding: 3px;
          width: fit-content;
          max-width: 100%;
          background: #f1f2f4;
          border-radius: 9px;
          overflow-x: auto;
        }

        .fg-filter {
          min-height: 34px;
          padding: 0 13px;
          border: 0;
          border-radius: 7px;
          background: transparent;
          color: #68717c;
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          white-space: nowrap;
        }

        .fg-filter.active { background: #ffffff; color: #20252b; font-weight: 650; box-shadow: 0 1px 3px rgba(15, 23, 42, 0.08); }

        .fg-table-card {
          background: #ffffff;
          border: 1px solid #e3e6ea;
          border-radius: 12px;
          overflow: hidden;
          box-shadow: 0 1px 2px rgba(15, 23, 42, 0.035), 0 5px 16px rgba(15, 23, 42, 0.03);
        }

        .fg-table-header {
          min-height: 70px;
          padding: 15px 18px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          border-bottom: 1px solid #e8eaed;
        }

        .fg-table-header h2 { margin: 0; font-size: 14px; font-weight: 650; color: #22272e; }
        .fg-table-header p { margin: 4px 0 0; font-size: 11px; color: #8a919a; }

        /* The table itself is a separate scroll surface. No forced 100vh height. */
        .fg-table-scroll {
          width: 100%;
          overflow: auto;
          max-height: 68vh;
        }

        .fg-table {
          width: max-content;
          min-width: 100%;
          border-collapse: separate;
          border-spacing: 0;
        }

        .fg-table th {
          position: sticky;
          top: 0;
          z-index: 20;
          height: 43px;
          padding: 0 16px;
          background: #fafafa;
          border-bottom: 1px solid #e6e8eb;
          color: #737b85;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.055em;
          text-align: left;
          white-space: nowrap;
        }

        .fg-table td {
          height: 62px;
          padding: 0 16px;
          border-bottom: 1px solid #edf0f2;
          color: #4c535b;
          font-size: 12px;
          white-space: nowrap;
          background: #ffffff;
        }

        .fg-table tbody tr:hover td { background: #fcfcfd; }

        .fg-sticky-col {
          position: sticky !important;
          left: 0;
          min-width: 250px;
          width: 250px;
          z-index: 25 !important;
        }

        .fg-sticky-head {
          top: 0 !important;
          left: 0 !important;
          min-width: 250px;
          width: 250px;
          z-index: 40 !important;
          background: #fafafa !important;
          box-shadow: 5px 0 8px -7px rgba(15, 23, 42, 0.35);
        }

        .fg-sticky-cell {
          background: #ffffff !important;
          box-shadow: 5px 0 8px -7px rgba(15, 23, 42, 0.35);
          font-weight: 650;
          color: #20252b !important;
        }

        .fg-po-id { font-weight: 700; color: #20252b; }
        .fg-po-ref { color: #20252b; font-size: 12px; font-weight: 600; }
        .fg-vendor { color: #555d66; }

        .fg-status {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          min-height: 27px;
          padding: 0 9px;
          border-radius: 999px;
          font-size: 10px;
          font-weight: 650;
          white-space: nowrap;
        }

        .fg-status-ready { background: #fff6dc; color: #9a6900; }
        .fg-status-merchandise { background: #edf5ff; color: #35689f; }
        .fg-status-accounts { background: #f3efff; color: #6850a4; }
        .fg-status-closed { background: #eaf7ef; color: #247847; }
        .fg-status-not-eligible { background: #f3f4f6; color: #737b85; }

        .fg-action-cell { position: sticky; right: 0; z-index: 15; width: 1%; text-align: right !important; background: #ffffff !important; box-shadow: -5px 0 8px -7px rgba(15, 23, 42, 0.25); }
        .fg-view-head { position: sticky !important; right: 0; z-index: 30 !important; background: #fafafa !important; box-shadow: -5px 0 8px -7px rgba(15, 23, 42, 0.25); }

        .fg-row-action-head {
          min-width: 105px;
          text-align: center !important;
          white-space: nowrap;
        }

        .fg-row-action-cell {
          min-width: 105px;
          text-align: center !important;
          white-space: nowrap;
        }

        .fg-view-button {
          height: 32px;
          padding: 0 10px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 5px;
          border: 1px solid #e1e4e8;
          border-radius: 7px;
          background: #ffffff;
          color: #4b535c;
          font-size: 11px;
          font-weight: 600;
          cursor: pointer;
        }

        .fg-empty { min-height: 180px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px; color: #9aa1aa; }
        .fg-empty strong { color: #555d66; font-size: 13px; }
        .fg-empty span { font-size: 11px; }

        .fg-pagination {
          min-height: 68px;
          padding: 0 18px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          border-top: 1px solid #e8eaed;
          color: #8a919a;
          font-size: 11px;
        }

        .fg-pagination-actions { display: flex; align-items: center; gap: 8px; }
        .fg-pagination-actions button, .fg-page-current {
          height: 40px;
          min-width: 40px;
          padding: 0 12px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 1px solid #e1e4e8;
          border-radius: 8px;
          background: #ffffff;
          color: #39414a;
          font-size: 11px;
          font-weight: 600;
        }
        .fg-pagination-actions button { cursor: pointer; }
        .fg-pagination-actions button:disabled { opacity: 0.45; cursor: not-allowed; }
        .fg-page-current { min-width: 40px; background: #f8f9fa; }


        .fg-initiate-button {
          height: 32px;
          padding: 0 10px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 5px;
          border: 1px solid #e0b900;
          border-radius: 7px;
          background: #f6c800;
          color: #151515;
          font-size: 11px;
          font-weight: 650;
          cursor: pointer;
          white-space: nowrap;
        }

        .fg-initiate-button:hover:not(:disabled) { background: #f4c000; }
        .fg-initiate-button:disabled { opacity: 0.45; cursor: not-allowed; }

        .fg-modal-backdrop {
          position: fixed;
          inset: 0;
          z-index: 1000;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 12px;
          background: rgba(15, 23, 42, 0.42);
          backdrop-filter: blur(2px);
        }

        .fg-modal {
          width: 96vw;
          max-width: 1600px;
          height: 94vh;
          max-height: 94vh;
          display: flex;
          flex-direction: column;
          background: #ffffff;
          border: 1px solid #e1e5ea;
          border-radius: 14px;
          box-shadow: 0 24px 70px rgba(15, 23, 42, 0.22);
          overflow: hidden;
        }

        .fg-modal-header {
          padding: 22px 28px;
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 20px;
          border-bottom: 1px solid #e8eaed;
        }

        .fg-modal-eyebrow {
          margin-bottom: 5px;
          color: #8a919a;
          font-size: 9px;
          font-weight: 750;
          letter-spacing: 0.1em;
        }

        .fg-modal-header h2 {
          margin: 0;
          color: #171b20;
          font-size: 20px;
          font-weight: 700;
        }

        .fg-modal-header p {
          margin: 5px 0 0;
          color: #6f7780;
          font-size: 12px;
        }

        .fg-modal-close {
          width: 34px;
          height: 34px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 1px solid #e1e4e8;
          border-radius: 8px;
          background: #ffffff;
          color: #68717c;
          cursor: pointer;
        }

        .fg-modal-body {
          padding: 24px 28px;
          overflow: auto;
          min-height: 0;
        }

        .fg-detail-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 16px;
        }

        .fg-detail-section {
          padding: 16px;
          border: 1px solid #e6e9ed;
          border-radius: 10px;
          background: #fcfcfd;
        }

        .fg-detail-section h3 {
          margin: 0 0 12px;
          color: #252a30;
          font-size: 12px;
          font-weight: 700;
        }

        .fg-detail-list {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 10px 18px;
        }

        .fg-detail-list > div {
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 3px;
        }

        .fg-detail-list span {
          color: #8a919a;
          font-size: 10px;
        }

        .fg-detail-list strong {
          overflow: hidden;
          color: #30363d;
          font-size: 12px;
          font-weight: 600;
          text-overflow: ellipsis;
        }

        .fg-send-message {
          margin-top: 16px;
          padding: 11px 13px;
          display: flex;
          align-items: flex-start;
          gap: 9px;
          border: 1px solid #cfe8d8;
          border-radius: 9px;
          background: #f1faf4;
          color: #277447;
          font-size: 11px;
          line-height: 1.45;
        }

        .fg-modal-footer {
          padding: 16px 28px;
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 9px;
          border-top: 1px solid #e8eaed;
          background: #ffffff;
        }

        .fg-modal-secondary,
        .fg-modal-primary {
          height: 40px;
          padding: 0 15px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
          border-radius: 8px;
          font-size: 12px;
          font-weight: 650;
          cursor: pointer;
        }

        .fg-modal-secondary {
          border: 1px solid #e0e3e7;
          background: #ffffff;
          color: #555d66;
        }

        .fg-modal-primary {
          border: 1px solid #e0b900;
          background: #f6c800;
          color: #151515;
        }

        .fg-founder-reject-button,
        .fg-founder-approve-button {
          height: 40px;
          padding: 0 15px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
          border-radius: 8px;
          font-size: 12px;
          font-weight: 650;
          cursor: pointer;
          color: #ffffff;
        }

        .fg-founder-reject-button {
          border: 1px solid #dc2626;
          background: #dc2626;
        }

        .fg-founder-reject-button:hover:not(:disabled) {
          background: #b91c1c;
          border-color: #b91c1c;
        }

        .fg-founder-approve-button {
          border: 1px solid #15803d;
          background: #16a34a;
        }

        .fg-founder-approve-button:hover:not(:disabled) {
          background: #15803d;
          border-color: #15803d;
        }

        .fg-founder-reject-button:disabled,
        .fg-founder-approve-button:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .fg-icon-founder { background: #fff2e7; color: #a55b18; }

        .fg-status-founder { background: #fff2e7; color: #a55b18; }

        .fg-action-placeholder {
          display: inline-flex;
          min-width: 50px;
          justify-content: center;
          color: #a1a7ae;
          font-size: 12px;
        }

        .fg-department-modal {
          width: min(620px, 94vw);
        }

        .fg-department-body {
          padding: 24px 22px 20px;
        }

        .fg-department-prompt {
          margin: 0 0 14px;
          color: #343a40;
          font-size: 13px;
          font-weight: 650;
        }

        .fg-department-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 12px;
        }

        .fg-department-card {
          min-height: 150px;
          padding: 18px;
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 8px;
          border: 1px solid #e1e5ea;
          border-radius: 11px;
          background: #ffffff;
          text-align: left;
          cursor: pointer;
          transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
        }

        .fg-department-card:hover {
          border-color: #c9ced5;
          box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08);
          transform: translateY(-1px);
        }

        .fg-department-card strong {
          color: #20252b;
          font-size: 14px;
        }

        .fg-department-card span {
          color: #7a818b;
          font-size: 11px;
          line-height: 1.5;
        }

        .fg-department-card > svg:last-child {
          margin-top: auto;
          align-self: flex-end;
          color: #7c848e;
        }

        .fg-department-merchandise > svg:first-child { color: #3569a8; }
        .fg-department-accounts > svg:first-child { color: #6950a7; }

        .fg-review-modal {
          width: min(1180px, 96vw);
        }

        .fg-reference-review-body {
          padding: 22px 24px 20px;
          background: #ffffff;
        }

        .fg-reference-po-details {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          column-gap: 44px;
          row-gap: 18px;
          padding: 2px 2px 24px;
          border-bottom: 1px solid #e7eaee;
        }

        .fg-reference-po-details > div {
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 5px;
        }

        .fg-reference-po-details span {
          color: #738099;
          font-size: 10px;
        }

        .fg-reference-po-details strong {
          overflow: hidden;
          color: #202833;
          font-size: 12px;
          font-weight: 650;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .fg-reference-review-section {
          margin-top: 22px;
        }

        .fg-reference-review-section > .fg-reference-review-heading {
          padding: 0 2px;
        }

        .fg-reference-review-heading {
          margin-bottom: 12px;
        }

        .fg-reference-review-heading h3 {
          margin: 0;
          color: #172033;
          font-size: 16px;
          font-weight: 750;
        }

        .fg-reference-review-heading p {
          margin: 5px 0 0;
          color: #718096;
          font-size: 11px;
        }

        /* SKU calculation is its own scrollable table surface. */
        .fg-reference-review-table-wrap {
          overflow: hidden;
          border: 1px solid #dfe4ea;
          border-radius: 10px;
          background: #ffffff;
        }

        .fg-sku-table-toolbar {
          min-height: 38px;
          padding: 0 12px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          border-bottom: 1px solid #dfe4ea;
          background: #f8fafc;
          color: #64748b;
          font-size: 11px;
          user-select: none;
        }

        .fg-sku-selection-summary {
          display: flex;
          align-items: center;
          gap: 8px;
          color: #1f2937;
        }

        .fg-sku-selection-summary strong:first-child {
          color: #64748b;
          font-size: 10px;
          letter-spacing: 0.08em;
        }

        .fg-sku-selection-summary strong:nth-child(2) {
          min-width: 70px;
          text-align: right;
          color: #111827;
          font-size: 12px;
        }

        .fg-sku-selection-summary button {
          border: 0;
          background: transparent;
          color: #64748b;
          cursor: pointer;
          font-size: 10px;
          padding: 3px 5px;
        }

        .fg-sku-selection-summary button:hover {
          color: #111827;
          text-decoration: underline;
        }

        .fg-sku-table-scroll {
          width: 100%;
          max-height: 430px;
          overflow: auto;
          scrollbar-width: thin;
          overscroll-behavior: contain;
        }

        .fg-reference-review-table {
          width: max-content;
          min-width: 100%;
          border-collapse: separate;
          border-spacing: 0;
          table-layout: auto;
        }

        /* Freeze the complete header row while scrolling vertically. */
        .fg-reference-review-table thead th {
          position: sticky;
          top: 0;
          z-index: 30;
          height: 46px;
          padding: 0 14px;
          background: #111827;
          color: #ffffff;
          text-align: left;
          font-size: 11px;
          font-weight: 700;
          white-space: nowrap;
          border-bottom: 1px solid #252d3b;
        }

        .fg-reference-review-table thead th:first-child {
          min-width: 190px;
          width: 190px;
        }

        /* Keep the Calculation column visible while scrolling horizontally. */
        .fg-sku-review-table th:first-child,
        .fg-sku-review-table td:first-child {
          position: sticky;
          left: 0;
          z-index: 20;
        }

        .fg-sku-review-table thead th:first-child {
          z-index: 40;
          background: #111827;
        }

        .fg-sku-review-table tbody td:first-child {
          background: #ffffff;
          box-shadow: 5px 0 8px -8px rgba(15, 23, 42, 0.35);
        }

        .fg-sku-review-table .fg-sku-header {
          min-width: 135px;
          width: 135px;
          text-align: center;
          white-space: nowrap;
        }

        .fg-sku-review-table .fg-sku-value-cell {
          min-width: 135px;
          width: 135px;
          height: 44px;
          padding: 0 12px;
          text-align: center;
          white-space: nowrap;
          background: #ffffff;
          cursor: cell;
          user-select: none;
        }

        .fg-sku-review-table .fg-sku-value-cell:hover {
          background: #f1f5f9;
        }

        .fg-sku-review-table .fg-sku-value-cell.fg-sku-cell-selected {
          background: #dbeafe;
          box-shadow: inset 0 0 0 2px #3b82f6;
          color: #0f172a;
        }

        .fg-sku-review-table .fg-sku-label-cell {
          min-width: 190px;
          width: 190px;
          position: sticky;
          left: 0;
          z-index: 20;
          background: #ffffff;
          box-shadow: 5px 0 8px -8px rgba(15, 23, 42, 0.35);
        }

        .fg-sku-review-table .fg-po-total-cell {
          min-width: 120px;
          width: 120px;
          background: #f8fafc;
          text-align: right;
          white-space: nowrap;
          font-weight: 650;
        }

        /* Review column stays visible at the right edge of the table. */
        .fg-sku-review-table th:last-child,
        .fg-sku-review-table td:last-child {
          position: sticky;
          right: 0;
          z-index: 21;
          min-width: 300px;
          width: 300px;
        }

        .fg-sku-review-table thead th:last-child {
          z-index: 45;
          background: #111827;
          box-shadow: -7px 0 10px -10px rgba(15, 23, 42, 0.55);
        }

        .fg-sku-review-table tbody td:last-child {
          background: #ffffff;
          box-shadow: -7px 0 10px -10px rgba(15, 23, 42, 0.35);
        }

        .fg-reference-review-table td {
          height: 52px;
          padding: 7px 14px;
          border-top: 1px solid #e5e8ec;
          background: #ffffff;
          color: #28313b;
          font-size: 12px;
          vertical-align: middle;
        }

        .fg-reference-review-table textarea {
          display: block;
          box-sizing: border-box;
          width: 100%;
          min-width: 0;
          min-height: 52px;
          height: 54px;
          padding: 9px 10px;
          resize: vertical;
          border: 1px solid #d9dee5;
          border-radius: 8px;
          outline: 0;
          background: #ffffff;
          color: #2b3440;
          font: inherit;
          font-size: 11px;
          line-height: 1.4;
        }

        .fg-reference-review-table textarea:focus {
          border-color: #b8c1cc;
          box-shadow: 0 0 0 3px rgba(17, 24, 39, 0.04);
        }

        .fg-reference-review-table tbody tr:hover td {
          background: #fbfcfd;
        }

        .fg-reference-review-table tbody tr:hover td:first-child,
        .fg-reference-review-table tbody tr:hover td:last-child {
          background: #fbfcfd;
        }

        .fg-reference-review-table tbody tr:hover .fg-po-total-cell {
          background: #f5f7fa;
        }

        .fg-reference-note-section {
          margin-top: 16px;
          padding: 14px;
          border: 1px solid #e2e7ec;
          border-radius: 9px;
          background: #fafbfd;
        }

        .fg-reference-document {
          margin-top: 12px;
          min-height: 76px;
          padding: 13px 14px;
          display: flex;
          align-items: center;
          gap: 11px;
          border: 1px solid #dfe4ea;
          border-radius: 9px;
          background: #f8fafc;
          color: #697586;
          cursor: pointer;
        }

        .fg-reference-document:hover {
          border-color: #c7ced7;
          background: #f6f8fa;
        }

        .fg-reference-document > span {
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .fg-reference-document strong {
          color: #2e3742;
          font-size: 11px;
          font-weight: 650;
        }

        .fg-reference-document small {
          color: #7d8794;
          font-size: 10px;
        }

        .fg-reference-document input {
          display: none;
        }

        .fg-fabric-table-wrap {
          margin-top: 2px;
          border: 1px solid #e4e7eb;
          border-radius: 10px;
          overflow: hidden;
          background: #ffffff;
        }

        .fg-fabric-table-scroll {
          width: 100%;
          overflow: auto;
          max-height: 430px;
        }

        .fg-fabric-review-table {
          min-width: 2100px;
        }

        .fg-fabric-review-table th {
          min-width: 108px;
          position: sticky;
          top: 0;
          z-index: 4;
          background: #fafafa;
          font-size: 9px;
          line-height: 1.25;
          white-space: normal;
        }

        .fg-fabric-review-table th:first-child,
        .fg-fabric-review-table td:first-child {
          position: sticky;
          left: 0;
          z-index: 6;
          min-width: 150px;
          width: 150px;
          background: #ffffff;
          box-shadow: 5px 0 8px -7px rgba(15, 23, 42, 0.35);
        }

        .fg-fabric-review-table th:first-child {
          background: #fafafa;
          z-index: 8;
        }

        .fg-fabric-review-table td {
          min-width: 108px;
          font-size: 11px;
          text-align: right;
        }

        .fg-fabric-review-table td:first-child {
          text-align: left;
          color: #20252b;
        }

        .fg-fabric-empty {
          padding: 22px !important;
          text-align: center !important;
          color: #8a919a !important;
          font-size: 11px !important;
        }

        .fg-review-form {
          margin-top: 16px;
          display: grid;
          grid-template-columns: minmax(0, 1fr) 330px;
          gap: 14px;
        }

        .fg-review-input-readonly {
          background: #f3f5f7 !important;
          color: #4b5563 !important;
          cursor: default !important;
          opacity: 1 !important;
          resize: none;
        }
        .fg-review-input-readonly:focus { outline: none !important; box-shadow: none !important; }

        .fg-review-label {
          display: flex;
          flex-direction: column;
          gap: 7px;
          color: #4d555e;
          font-size: 11px;
          font-weight: 650;
        }

        .fg-review-label textarea {
          width: 100%;
          min-height: 112px;
          padding: 11px 12px;
          resize: vertical;
          border: 1px solid #dfe3e8;
          border-radius: 9px;
          outline: 0;
          background: #ffffff;
          color: #252a30;
          font: inherit;
          font-size: 12px;
          font-weight: 400;
          line-height: 1.5;
        }

        .fg-review-label textarea:focus {
          border-color: #b9c1ca;
          box-shadow: 0 0 0 3px rgba(17, 24, 39, 0.045);
        }

        .fg-upload-box {
          min-height: 112px;
          padding: 14px;
          display: flex;
          align-items: center;
          gap: 10px;
          border: 1px dashed #cfd4da;
          border-radius: 9px;
          background: #fafbfc;
          color: #6e7680;
          cursor: pointer;
        }

        .fg-upload-box:hover {
          border-color: #aeb5bd;
          background: #f8f9fa;
        }

        .fg-upload-box > span {
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .fg-upload-box strong {
          overflow: hidden;
          color: #353c44;
          font-size: 11px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .fg-upload-box small {
          color: #8b929b;
          font-size: 10px;
        }

        .fg-upload-box input {
          display: none;
        }

        .fg-modal-error {
          margin-top: 14px;
        }

        .fg-founder-reviews {
          margin-top: 16px;
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 12px;
        }

        .fg-founder-review-card {
          padding: 14px;
          border: 1px solid #e4e7eb;
          border-radius: 10px;
          background: #fafbfc;
        }

        .fg-founder-additional-remarks {
          margin-top: 12px;
          padding: 10px 12px;
          border: 1px solid #e4e7eb;
          border-radius: 8px;
          background: #ffffff;
        }

        .fg-founder-additional-remarks strong {
          display: block;
          margin-bottom: 6px;
          color: #374151;
          font-size: 12px;
        }

        .fg-founder-additional-remarks p {
          margin: 0;
          color: #4b5563;
          font-size: 13px;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }

        .fg-document-button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .fg-founder-review-heading {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
        }

        .fg-founder-review-heading strong {
          color: #2c3239;
          font-size: 12px;
        }

        .fg-founder-review-heading span {
          color: #8a919a;
          font-size: 10px;
        }

        .fg-founder-review-card p {
          margin: 9px 0 11px;
          color: #59616a;
          font-size: 11px;
          line-height: 1.55;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }

        .fg-document-button {
          height: 31px;
          max-width: 100%;
          padding: 0 9px;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          border: 1px solid #dfe3e8;
          border-radius: 7px;
          background: #ffffff;
          color: #4e5761;
          font-size: 10px;
          font-weight: 600;
          cursor: pointer;
        }

        .fg-document-button:hover {
          background: #f7f8f9;
        }

        .fg-grn-table-wrap {
          width: 100%;
          border: 1px solid rgba(15, 23, 42, 0.10);
          border-radius: 14px;
          overflow: hidden;
          background: #fff;
        }

        .fg-grn-table-scroll {
          width: 100%;
          max-height: 460px;
          overflow: auto;
        }

        .fg-grn-review-table {
          min-width: 2400px;
          border-collapse: separate;
          border-spacing: 0;
        }

        .fg-grn-review-table th {
          position: sticky;
          top: 0;
          z-index: 2;
          white-space: nowrap;
          font-size: 10px;
          letter-spacing: 0.04em;
          text-transform: uppercase;
        }

        .fg-grn-review-table td {
          white-space: nowrap;
          font-size: 12px;
        }

        .fg-grn-review-table th:first-child,
        .fg-grn-review-table td:first-child {
          position: sticky;
          left: 0;
          z-index: 3;
          min-width: 105px;
        }

        .fg-grn-review-table th:first-child {
          z-index: 4;
        }

        @media (max-width: 1250px) {
          .fg-kpi-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        }

        @media (max-width: 850px) {
          .fg-detail-grid { grid-template-columns: 1fr; }
          .fg-reference-po-details { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .fg-kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .fg-toolbar { flex-direction: column; align-items: stretch; }
          .fg-primary-button { width: 100%; }
          .fg-filter-bar { width: 100%; }
          .fg-table-scroll { max-height: 62vh; }
          .fg-review-form { grid-template-columns: 1fr; }
          .fg-founder-reviews { grid-template-columns: 1fr; }
          .fg-department-grid { grid-template-columns: 1fr; }
        }

        @media (max-width: 560px) {
          .fg-modal-backdrop { padding: 10px; }
          .fg-modal {
            width: calc(100vw - 20px);
            height: 94vh;
            max-height: 94vh;
          }
          .fg-detail-list { grid-template-columns: 1fr; }
          .fg-modal-footer { flex-direction: column-reverse; align-items: stretch; }
          .fg-modal-secondary, .fg-modal-primary { width: 100%; }
          .fg-reference-po-details { grid-template-columns: 1fr; }
          .fg-sku-table-scroll { max-height: 330px; }
          .fg-sku-review-table th:last-child,
          .fg-sku-review-table td:last-child { min-width: 280px; width: 280px; }
          .fg-kpi-grid { grid-template-columns: 1fr; }
          .fg-kpi-card { min-height: 115px; }
          .fg-table-header { padding: 14px; }
        }
      `}</style>
    </div>
  );
}
