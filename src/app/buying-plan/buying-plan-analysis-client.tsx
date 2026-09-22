'use client';

import { useMemo, useState, useTransition } from 'react';
import { AlertTriangle, ChevronRight, Download, FileText, Send, TrendingDown, TrendingUp } from 'lucide-react';
import { addMonths, monthLabel } from '@/lib/forms/approval';
import { generatePlanReportAction, getPlanReportUrl } from '@/lib/forms/actions';
import { Notice } from '@/components/forms/form-layout';
import { Field } from '@/components/forms/form-layout';
import { FilterTable, type Column } from '@/components/filter-table';
import { downloadCsv } from '@/lib/download';
import { InfoDot } from '@/components/info-dot';
import type {
  BuyingPlanAnalysis,
  BuyingPlanAnalysisProduct,
  BuyingPlanAnalysisStatus,
} from '@/lib/forms/analysis-types';

const num = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const pctText = (v: number | null) => (v == null ? '—' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);
const signed = (v: number) => (v > 0 ? `+${num.format(v)}` : num.format(v));

const STATUS_LABEL: Record<BuyingPlanAnalysisStatus, string> = {
  on_plan: 'On plan',
  over: 'Issued above approved',
  short: 'Issued below approved',
  unissued: 'Approved, not issued',
  not_planned: 'Not in plan',
  not_approved: 'In plan, no approved qty',
};

// Highlight colours: red = exception (a) not budgeted, amber = exception (b) over-issued.
const STATUS_STYLE: Record<BuyingPlanAnalysisStatus, { bg: string; fg: string }> = {
  on_plan: { bg: '#ecf1e9', fg: '#4f7c4d' },
  over: { bg: '#fdf1dc', fg: '#9a6b12' },
  short: { bg: '#f3f1ec', fg: '#6e695e' },
  unissued: { bg: '#f3f1ec', fg: '#6e695e' },
  not_planned: { bg: '#fdecea', fg: '#c0392b' },
  not_approved: { bg: '#fdecea', fg: '#c0392b' },
};

const fmtTs = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—';

/** Approval deadline compliance, approval quality and the first-time-approval rate. */
function LifecycleCard({ lifecycle: lc, planMonth }: { lifecycle: BuyingPlanAnalysis['lifecycle']; planMonth: string }) {
  const c = lc.compliance;
  const dl = new Date(c.deadline).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
  const comp: Record<typeof c.status, { tone: 'green' | 'yellow' | 'red'; text: string }> = {
    on_time: { tone: 'green', text: 'Approved on time' },
    pending: { tone: 'yellow', text: `Awaiting approval — due ${dl}` },
    breach_submission: { tone: 'red', text: `Compliance breach — submission side · ${c.daysLate} day${c.daysLate === 1 ? '' : 's'} late` },
    breach_approval: { tone: 'red', text: `Compliance breach — approval side · ${c.daysLate} day${c.daysLate === 1 ? '' : 's'} late` },
  };
  const kind: Record<typeof lc.approvalKind, { tone: 'green' | 'yellow' | 'red' | 'gray'; text: string }> = {
    first_time: { tone: 'green', text: 'First-time approval' },
    edited: { tone: 'yellow', text: 'Approved after rework' },
    amended_after_freeze: { tone: 'red', text: 'Amended after freeze' },
    not_approved: { tone: 'gray', text: 'Not approved yet' },
  };
  const rate = lc.firstTimeRate;
  const ratePct = rate.approved ? Math.round((rate.firstTime / rate.approved) * 100) : null;
  return (
    <section className="bp-card">
      <div className="bp-cardhead">
        <h2>
          Approval compliance
          <InfoDot text={"WHAT: was the plan approved on time, and how often plans get through first time.\n\nHOW: the plan must be approved by the deadline day of its month (Rules Master, default the 7th). Late = a breach, on the submission side if it was not even submitted by then, on the approval side if it was submitted in time but not decided. First-time rate = plans approved without rework, over the last six plans.\n\nUSE: a submission-side breach is the planner's; an approval-side breach is the approver's."} />
        </h2>
        <span className={`bp-badge ${comp[c.status].tone}`}>{comp[c.status].text}</span>
      </div>
      <div className="bp-cardbody">
        <div className="bp-summaryrow"><span>Deadline</span><b>{c.deadlineDay}th of the month · {dl}</b></div>
        <div className="bp-summaryrow"><span>Submitted</span><b>{fmtTs(lc.submittedAt)}</b></div>
        <div className="bp-summaryrow">
          <span>First admin action<small className="bp-summary-sub">approve / reject / rework — what the deadline measures</small></span>
          <b>{fmtTs(lc.firstActionAt)}</b>
        </div>
        <div className="bp-summaryrow"><span>Approved</span><b>{fmtTs(lc.approvedAt)}</b></div>
        <div className="bp-summaryrow"><span>Approval quality</span><b><span className={`bp-badge ${kind[lc.approvalKind].tone}`}>{kind[lc.approvalKind].text}</span></b></div>
        <div className="bp-summaryrow">
          <span>First-time approval rate<small className="bp-summary-sub">key metric · trailing 6 months{rate.months.length ? ` · ${rate.months.join(', ')}` : ''}</small></span>
          <b>{ratePct == null ? '—' : `${ratePct}% (${rate.firstTime}/${rate.approved})`}</b>
        </div>
        <div className="bp-summaryrow">
          <span>Month-end freeze</span>
          <b>{lc.frozen ? `Closed since ${monthLabel(lc.frozenSince ?? planMonth)}` : 'Open'}</b>
        </div>
      </div>
    </section>
  );
}

/** The auto-generated month report: status, download, and (admin) generate / post now. */
function ReportCard({
  lifecycle: lc,
  planMonth,
  isAdmin,
  busy,
  onGenerate,
  onDownload,
}: {
  lifecycle: BuyingPlanAnalysis['lifecycle'];
  planMonth: string;
  isAdmin: boolean;
  busy: boolean;
  onGenerate: (post: boolean) => void;
  onDownload: () => void;
}) {
  const r = lc.report;
  return (
    <section className="bp-card">
      <div className="bp-cardhead">
        <h2>
          Month report (PDF)
          <InfoDot text={"WHAT: the month-end PDF — approved plan against what was actually ordered.\n\nHOW: generated from the approved plan and the POs dated in the month; can be posted straight to the Supply Chain Slack channel.\n\nUSE: the record of the month once it is frozen."} />
        </h2>
        <span className="wf-subtle">auto on the 1st · posted to Supply Chain</span>
      </div>
      <div className="bp-cardbody">
        {/* Which webhook the post will actually hit — so nobody has to guess the channel. */}
        <div className="bp-summaryrow">
          <span>Posts to<small className="bp-summary-sub">Slack incoming webhook in use</small></span>
          <b>
            {lc.slackTarget === 'supply_chain' && <span className="bp-badge green">Supply Chain webhook</span>}
            {lc.slackTarget === 'ops' && <span className="bp-badge yellow" title="SLACK_SUPPLY_CHAIN_WEBHOOK_URL is not set; falling back to SLACK_OPS_WEBHOOK_URL">Ops webhook (fallback)</span>}
            {lc.slackTarget === 'feedback' && <span className="bp-badge yellow" title="Neither SLACK_SUPPLY_CHAIN_WEBHOOK_URL nor SLACK_OPS_WEBHOOK_URL is set; falling back to SLACK_FEEDBACK_WEBHOOK_URL">Feedback webhook (fallback)</span>}
            {lc.slackTarget === 'none' && <span className="bp-badge red" title="Set SLACK_SUPPLY_CHAIN_WEBHOOK_URL in Vercel">Not configured</span>}
          </b>
        </div>
        {r ? (
          <>
            <div className="bp-summaryrow"><span>Generated</span><b>{fmtTs(r.generatedAt)}{r.generatedBy ? ` · ${r.generatedBy}` : ''}</b></div>
            <div className="bp-summaryrow">
              <span>Slack</span>
              <b>
                {r.slackPostedAt
                  ? <span className="bp-badge green">Posted {fmtTs(r.slackPostedAt)}</span>
                  : r.slackError
                    ? <span className="bp-badge red" title={r.slackError}>Not posted</span>
                    : <span className="bp-badge gray">Not posted</span>}
              </b>
            </div>
            {r.slackError && !r.slackPostedAt && <p className="wf-subtle" style={{ fontSize: 11.5, margin: '6px 0 0' }}>{r.slackError}</p>}
          </>
        ) : (
          <p className="wf-subtle" style={{ margin: 0 }}>
            No report yet for {monthLabel(planMonth)}. It is generated automatically on the 1st after the month closes
            {isAdmin ? ', or you can generate it now.' : '.'}
          </p>
        )}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          {r && (
            <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={busy} onClick={onDownload}>
              <FileText size={13} /> Download PDF
            </button>
          )}
          {isAdmin && (
            <>
              <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={busy} onClick={() => onGenerate(false)}>
                {busy ? 'Working…' : r ? 'Regenerate' : 'Generate now'}
              </button>
              <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={busy} onClick={() => onGenerate(true)}>
                <Send size={13} /> Generate &amp; post to Slack
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function StatusBadge({ status }: { status: BuyingPlanAnalysisStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 11.5, fontWeight: 600, background: s.bg, color: s.fg, whiteSpace: 'nowrap' }}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function Tile({ q, val, note, tone }: { q: string; val: string; note: string; tone?: 'red' | 'amber' | 'green' }) {
  const color = tone === 'red' ? '#c0392b' : tone === 'amber' ? '#9a6b12' : tone === 'green' ? '#4f7c4d' : undefined;
  return (
    <div className="wf-macro-card">
      <span className="wf-macro-q">{q}</span>
      <strong className="wf-macro-val" style={color ? { color } : undefined}>{val}</strong>
      <span className="wf-subtle">{note}</span>
    </div>
  );
}

/** PO refs for a product, compact: "FY26-27/FOB/SDAVSK/KVN-10 (KVN · 1,200)". */
function PoList({ row }: { row: BuyingPlanAnalysisProduct }) {
  if (!row.pos.length) return <span className="wf-subtle">—</span>;
  return (
    <span style={{ fontSize: 12 }}>
      {row.pos.map((p, i) => (
        <span key={p.po_id}>
          {i > 0 && ', '}
          <span className="mono">{p.po_ref_num || p.po_number || p.po_id}</span>
          <span className="wf-subtle"> ({p.vendor_code ?? '?'} · {num.format(p.qty)})</span>
        </span>
      ))}
    </span>
  );
}

function poCsvText(row: BuyingPlanAnalysisProduct) {
  return row.pos
    .map((po) => `${po.po_ref_num || po.po_number || po.po_id} (${po.vendor_code ?? '?'} · ${po.qty})`)
    .join('; ');
}

export function BuyingPlanAnalysisClient({ analysis, isAdmin = false }: { analysis: BuyingPlanAnalysis; isAdmin?: boolean }) {
  const { planMonth, metrics: m, products, exceptions, hasPlan, planStatus, approvedLines, totalLines, lifecycle } = analysis;
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [busy, start] = useTransition();
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  function generate(post: boolean) {
    setNote(null);
    const fd = new FormData();
    fd.set('plan_month', planMonth);
    fd.set('post', post ? '1' : '0');
    start(async () => {
      const r = await generatePlanReportAction(fd);
      setNote(r.ok ? { tone: 'ok', text: r.message ?? 'Done.' } : { tone: 'error', text: r.error });
      if (r.ok) window.location.reload();
    });
  }

  function download() {
    if (!lifecycle.report) return;
    start(async () => {
      const r = await getPlanReportUrl(lifecycle.report!.storagePath);
      if ('url' in r) window.open(r.url, '_blank', 'noopener,noreferrer');
      else setNote({ tone: 'error', text: r.error });
    });
  }

  function downloadNotBudgetedCsv() {
    downloadCsv(
      `buying-plan-not-budgeted-${planMonth.slice(0, 7)}`,
      ['Product', 'Reason', 'Issued qty', 'Issued value', 'POs', 'PO references'],
      exceptions.notBudgeted.map((row) => [
        row.product_code,
        STATUS_LABEL[row.status],
        row.issuedQty,
        row.issuedValue,
        row.poCount,
        poCsvText(row),
      ]),
    );
  }

  function downloadOverApprovedCsv() {
    downloadCsv(
      `buying-plan-over-approved-${planMonth.slice(0, 7)}`,
      ['Product', 'Approved qty', 'Issued qty', 'Excess qty', 'Excess %', 'Excess value', 'PO references'],
      exceptions.overApproved.map((row) => [
        row.product_code,
        row.plannedQty,
        row.issuedQty,
        row.deltaQty,
        row.plannedQty > 0 ? `${((row.deltaQty / row.plannedQty) * 100).toFixed(1)}%` : '',
        row.deltaValue,
        poCsvText(row),
      ]),
    );
  }

  const rows = useMemo(
    () => (onlyFlagged ? products.filter((r) => r.status !== 'on_plan' && r.status !== 'unissued' && r.status !== 'short') : products),
    [products, onlyFlagged],
  );

  const columns = useMemo<Column<BuyingPlanAnalysisProduct>[]>(
    () => [
      { key: 'product_code', label: 'Product', kind: 'mono', source: 'supabase' },
      {
        key: 'status', label: 'Status', filter: 'select', source: 'computed',
        accessor: (r) => STATUS_LABEL[r.status],
        render: (r) => <StatusBadge status={r.status} />,
        info: "WHAT: the two ways a PO can break the plan.\n\nHOW: red = a PO was issued for a product with no approved plan quantity (not budgeted). Amber = POs issued for more than the approved quantity (over approved).\n\nUSE: both are buying outside the plan; red is the more serious because nobody approved any of it.",
      },
      { key: 'plannedQty', label: 'Approved qty', kind: 'num', source: 'supabase', info: "WHAT: what the approved plan said to buy.\n\nHOW: Job Work + FOB + E-FOB pieces on the approved plan for the month.\n\nUSE: the budget the issued column is measured against." },
      { key: 'issuedQty', label: 'Issued qty', kind: 'num', source: 'easyecom', info: "WHAT: what was actually ordered.\n\nHOW: pieces on real EasyEcom POs (issued or completed) with a PO date in the month — not the dashboard's PO Approval drafts.\n\nUSE: issued above planned = over-buying; well below = the plan was not executed." },
      { key: 'deltaQty', label: 'Δ qty', kind: 'num', source: 'computed', render: (r) => <span style={{ color: r.deltaQty > 0 ? '#9a6b12' : r.deltaQty < 0 ? '#6e695e' : undefined }}>{signed(r.deltaQty)}</span> },
      { key: 'plannedValue', label: 'Approved value', kind: 'num', source: 'supabase', render: (r) => money.format(r.plannedValue) },
      { key: 'issuedValue', label: 'Issued value', kind: 'num', source: 'easyecom', render: (r) => money.format(r.issuedValue) },
      { key: 'deltaValue', label: 'Δ value', kind: 'num', source: 'computed', render: (r) => (r.deltaValue > 0 ? '+' : '') + money.format(r.deltaValue) },
      { key: 'poCount', label: 'POs', kind: 'num', source: 'easyecom' },
      { key: 'pos', label: 'PO references', filter: 'none', sortable: false, source: 'easyecom', accessor: (r) => r.pos.map((p) => p.po_ref_num || p.po_number || '').join(' '), render: (r) => <PoList row={r} /> },
    ],
    [],
  );

  const planNote = !hasPlan
    ? 'No finished-goods plan exists for this month — everything issued counts as not budgeted.'
    : planStatus === 'approved' || approvedLines > 0
      ? `Plan ${planStatus} · ${approvedLines} of ${totalLines} lines approved.`
      : `Plan is ${planStatus} — no lines approved yet, so every issued PO shows as not budgeted until approval.`;

  return (
    <div className="wf-stack">
      <div className="wf-toolbar">
        <div className="wf-toolbar-left">
          <Field label="Month">
            <select
              value={planMonth}
              onChange={(e) => { window.location.href = `/buying-plan?month=${e.target.value}&type=analysis`; }}
            >
              {[-3, -2, -1, 0, 1].map((delta) => {
                const month = addMonths(planMonth, delta);
                return <option key={month} value={month}>{monthLabel(month)}</option>;
              })}
            </select>
          </Field>
          <span className="wf-subtle" style={{ fontSize: 12 }}>{planNote}</span>
        </div>
      </div>

      {note && <Notice tone={note.tone}>{note.text}</Notice>}

      {/* Month-end lifecycle: approval compliance + the auto-generated month report */}
      <div className="bp-lifecycle">
        <LifecycleCard lifecycle={lifecycle} planMonth={planMonth} />
        <ReportCard
          lifecycle={lifecycle}
          planMonth={planMonth}
          isAdmin={isAdmin}
          busy={busy}
          onGenerate={generate}
          onDownload={download}
        />
      </div>

      {/* Five variance metrics for the month */}
      <div className="wf-macro">
        <Tile
          q="Quantity variation"
          val={`${num.format(m.issuedQty)} / ${num.format(m.plannedQty)} pcs`}
          note={`issued vs approved · ${signed(m.issuedQty - m.plannedQty)} (${pctText(m.qtyVarPct)})`}
          tone={m.issuedQty > m.plannedQty ? 'amber' : undefined}
        />
        <Tile
          q="Value variation"
          val={`${money.format(m.issuedValue)} / ${money.format(m.plannedValue)}`}
          note={`issued vs approved · ${pctText(m.valueVarPct)}`}
          tone={m.issuedValue > m.plannedValue ? 'amber' : undefined}
        />
        <Tile
          q="PO count variation"
          val={`${num.format(m.actualPoCount)} / ${num.format(m.plannedPoCount)}`}
          note={`actual POs vs planned (product × PO-type cells) · ${signed(m.actualPoCount - m.plannedPoCount)}`}
        />
        <Tile
          q="Excess %"
          val={pctText(m.excessPct) === '—' ? '—' : `${(m.excessPct! * 100).toFixed(1)}%`}
          note={`${num.format(m.excessQty)} pcs · ${money.format(m.excessValue)} issued above approved`}
          tone={m.excessQty > 0 ? 'amber' : 'green'}
        />
        <Tile
          q="Short"
          val={`${num.format(m.shortQty)} pcs`}
          note={`${pctText(m.shortPct) === '—' ? '—' : (m.shortPct! * 100).toFixed(1) + '%'} of approved · ${money.format(m.shortValue)} not yet issued`}
          tone={m.shortQty > 0 ? 'red' : 'green'}
        />
      </div>

      {/* Exception (a): issued but not budgeted */}
      <details className="wf-card bp-analysis-disclosure bp-analysis-not-budgeted">
        <summary className="bp-analysis-summary">
          <span className="bp-analysis-summary-title">
            <AlertTriangle size={16} aria-hidden="true" />
            Issued but NOT budgeted — {exceptions.notBudgeted.length} product{exceptions.notBudgeted.length === 1 ? '' : 's'}
          </span>
          <ChevronRight size={16} className="bp-analysis-chevron" aria-hidden="true" />
        </summary>
        <div className="bp-analysis-content">
        <p className="wf-subtle" style={{ margin: '0 0 8px', fontSize: 12 }}>
          POs issued for products that are not in the {monthLabel(planMonth)} buying plan, or are in the plan with no approved quantity (never approved, or approved at zero). Why were these issued?
          <InfoDot text={"WHAT: products bought this month that were never in the plan.\n\nHOW: products with issued POs in the month but no approved plan quantity — absent from the plan, or approved at zero.\n\nUSE: each one was an ad-hoc purchase. Fine if deliberate (an urgent stock-out); a problem if routine."} />
        </p>
        <div className="bp-analysis-actions">
          <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={downloadNotBudgetedCsv}>
            <Download size={14} aria-hidden="true" /> Download CSV
          </button>
        </div>
        {exceptions.notBudgeted.length === 0 ? (
          <div className="wf-subtle">None — every issued product was budgeted and approved.</div>
        ) : (
          <div className="table-scroll">
            <table className="wf-grid">
              <thead><tr><th>Product</th><th>Reason</th><th className="num">Issued qty</th><th className="num">Issued value</th><th className="num">POs</th><th>PO references</th></tr></thead>
              <tbody>
                {exceptions.notBudgeted.map((r) => (
                  <tr key={r.product_code}>
                    <td className="mono"><strong>{r.product_code}</strong></td>
                    <td><StatusBadge status={r.status} /></td>
                    <td className="num">{num.format(r.issuedQty)}</td>
                    <td className="num">{money.format(r.issuedValue)}</td>
                    <td className="num">{r.poCount}</td>
                    <td><PoList row={r} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        </div>
      </details>

      {/* Exception (b): issued above approved */}
      <details className="wf-card bp-analysis-disclosure bp-analysis-over-approved">
        <summary className="bp-analysis-summary">
          <span className="bp-analysis-summary-title">
            <TrendingUp size={16} aria-hidden="true" />
            Issued ABOVE approved quantity — {exceptions.overApproved.length} product{exceptions.overApproved.length === 1 ? '' : 's'}
          </span>
          <ChevronRight size={16} className="bp-analysis-chevron" aria-hidden="true" />
        </summary>
        <div className="bp-analysis-content">
        <p className="wf-subtle" style={{ margin: '0 0 8px', fontSize: 12 }}>
          Approved 100, issued 110 — the excess over what the plan approved.
          <InfoDot text={"WHAT: products bought in larger quantity than approved.\n\nHOW: issued pieces − approved pieces, where positive. Example: approved 500, issued 800 → 300 over.\n\nUSE: over-buying ties up cash the plan did not allow for."} />
        </p>
        <div className="bp-analysis-actions">
          <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={downloadOverApprovedCsv}>
            <Download size={14} aria-hidden="true" /> Download CSV
          </button>
        </div>
        {exceptions.overApproved.length === 0 ? (
          <div className="wf-subtle">None — nothing was issued above its approved quantity.</div>
        ) : (
          <div className="table-scroll">
            <table className="wf-grid">
              <thead><tr><th>Product</th><th className="num">Approved</th><th className="num">Issued</th><th className="num">Excess</th><th className="num">Excess %</th><th className="num">Excess value</th><th>PO references</th></tr></thead>
              <tbody>
                {exceptions.overApproved.map((r) => (
                  <tr key={r.product_code}>
                    <td className="mono"><strong>{r.product_code}</strong></td>
                    <td className="num">{num.format(r.plannedQty)}</td>
                    <td className="num">{num.format(r.issuedQty)}</td>
                    <td className="num" style={{ color: '#9a6b12', fontWeight: 600 }}>+{num.format(r.deltaQty)}</td>
                    <td className="num">{r.plannedQty > 0 ? `${((r.deltaQty / r.plannedQty) * 100).toFixed(1)}%` : '—'}</td>
                    <td className="num">{r.deltaValue > 0 ? '+' + money.format(r.deltaValue) : '—'}</td>
                    <td><PoList row={r} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        </div>
      </details>

      {/* Every product: approved vs issued */}
      <details className="wf-card bp-analysis-disclosure">
        <summary className="bp-analysis-summary">
          <span className="bp-analysis-summary-title">
            <TrendingDown size={16} aria-hidden="true" />
            All products — approved vs issued
          </span>
          <span className="bp-analysis-summary-meta">
            {products.length} product{products.length === 1 ? '' : 's'}
            <ChevronRight size={16} className="bp-analysis-chevron" aria-hidden="true" />
          </span>
        </summary>
        <div className="bp-analysis-content">
        <div className="bp-analysis-actions">
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} />
            flagged only
          </label>
          <span className="wf-subtle" style={{ fontSize: 12 }}>
            {m.approvedProducts} approved · {m.issuedProducts} issued
            <InfoDot text={"WHAT: every product, planned against issued, in pieces and rupees.\n\nHOW: approved plan quantity and value beside issued PO quantity and value; the difference as Excess or Short.\n\nUSE: the full reconciliation behind the two exception lists above."} />
          </span>
        </div>
        <FilterTable
          rows={rows}
          columns={columns}
          rowKey={(r) => r.product_code}
          defaultSource="computed"
          unit="products"
          searchPlaceholder="Search product / PO…"
          emptyText="Nothing planned or issued for this month."
          download={{ filename: `buying-plan-analysis-${planMonth.slice(0, 7)}` }}
        />
        </div>
      </details>
    </div>
  );
}
