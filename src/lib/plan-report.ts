import 'server-only';
// Buying Plan — month-end analytical report (spec item 5).
//
// On the 1st (Vercel cron → /api/cron/month-close) — or on demand from the Analysis track
// (admin) — this builds the PDF for a plan month from the same figures the Analysis track
// shows (loadBuyingPlanAnalysis), stores it in the private `plan-reports` bucket, records
// it in sd_plan_report (one row per month; regenerating overwrites), and posts the headline
// numbers + a signed download link to the Supply Chain Slack channel.
//
// Runs with the SERVICE-ROLE client: the cron has no user session, and the report must
// read every plan/PO row regardless of who triggered it.

import { jsPDF } from 'jspdf';
import autoTableImport from 'jspdf-autotable';
import { createAdminClient, hasSupabaseAdminEnv } from '@/lib/supabase/admin';
import { loadBuyingPlanAnalysis, type AnalysisDb } from '@/lib/forms/queries-modules/buying-plan-analysis';
import { monthLabel } from '@/lib/forms/approval';
import { hasSupplyChainSlack, notifyPlanReportSlack } from '@/lib/slack';
import type { BuyingPlanAnalysis } from '@/lib/forms/analysis-types';

const BUCKET = 'plan-reports';
const SIGNED_URL_SECONDS = 60 * 60 * 24 * 30; // 30 days — long enough for the Slack link to stay useful

// CJS/ESM interop: the externalised package may expose the function as `default`.
type AutoTableFn = typeof autoTableImport;
const autoTable: AutoTableFn =
  ((autoTableImport as unknown as { default?: AutoTableFn }).default ?? autoTableImport) as AutoTableFn;

const n0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
// The built-in Helvetica has no ₹ glyph — write "Rs".
const rs = (v: number) => `Rs ${n0.format(Math.round(v))}`;
const pctText = (v: number | null) => (v == null ? '-' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);
const signed = (v: number) => (v > 0 ? `+${n0.format(v)}` : n0.format(v));

export function complianceLine(a: BuyingPlanAnalysis): string {
  const c = a.lifecycle.compliance;
  const dl = new Date(c.deadline).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
  switch (c.status) {
    case 'on_time':
      return `Approved on time (deadline ${dl})`;
    case 'pending':
      return `Awaiting approval — deadline ${dl}`;
    case 'breach_submission':
      return `BREACH — submission side, ${c.daysLate} day${c.daysLate === 1 ? '' : 's'} past the ${dl} deadline`;
    case 'breach_approval':
      return `BREACH — approval side, ${c.daysLate} day${c.daysLate === 1 ? '' : 's'} past the ${dl} deadline`;
  }
}

const STATUS_TEXT: Record<string, string> = {
  on_plan: 'On plan',
  over: 'Issued above approved',
  short: 'Issued below approved',
  unissued: 'Approved, not issued',
  not_planned: 'Not in plan',
  not_approved: 'In plan, no approved qty',
};

/** Renders the month report as a PDF (A4 portrait). Pure: no I/O. */
export function renderPlanReportPdf(a: BuyingPlanAnalysis): Buffer {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const m = a.metrics;
  const label = monthLabel(a.planMonth);
  const left = 40;
  const width = 515;

  doc.setFontSize(16);
  doc.setTextColor(20);
  doc.text(`Buying Plan — ${label} · Month report`, left, 46);
  doc.setFontSize(8.5);
  doc.setTextColor(110);
  doc.text(
    `Generated ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST · approved plan vs POs actually issued (EasyEcom, by PO date) · SAADAA Sourcing Dashboard`,
    left,
    60,
  );

  // 1 — Approval compliance + freeze
  doc.setFontSize(11);
  doc.setTextColor(20);
  doc.text('Approval compliance', left, 84);
  const lc = a.lifecycle;
  const fmtTs = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '-';
  const approvalKind =
    lc.approvalKind === 'first_time'
      ? 'First-time approval'
      : lc.approvalKind === 'edited'
        ? 'Approved after rework (edited)'
        : lc.approvalKind === 'amended_after_freeze'
          ? 'Amended after freeze'
          : 'Not approved';
  autoTable(doc, {
    startY: 92,
    margin: { left, right: 40 },
    theme: 'plain',
    styles: { fontSize: 8.5, cellPadding: 3 },
    columnStyles: { 0: { fontStyle: 'bold', cellWidth: 150 } },
    body: [
      ['Plan status', a.hasPlan ? `${a.planStatus} · ${a.approvedLines} of ${a.totalLines} lines approved` : 'No plan for this month'],
      ['Deadline', `${lc.compliance.deadlineDay}th of the month (${new Date(lc.compliance.deadline).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })})`],
      ['Submitted / first admin action / approved', `${fmtTs(lc.submittedAt)}  /  ${fmtTs(lc.firstActionAt)}  /  ${fmtTs(lc.approvedAt)}`],
      ['Compliance', complianceLine(a)],
      ['Approval quality', approvalKind],
      ['First-time approval rate', lc.firstTimeRate.approved ? `${lc.firstTimeRate.firstTime} of ${lc.firstTimeRate.approved} plans (${Math.round((lc.firstTimeRate.firstTime / lc.firstTimeRate.approved) * 100)}%) — ${lc.firstTimeRate.months.join(', ')}` : 'no approved plans in the window'],
      ['Freeze', lc.frozen ? `Closed — frozen from ${lc.frozenSince}` : 'Open'],
    ],
  });

  // 2 — Variance vs approved plan
  let y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 18;
  doc.setFontSize(11);
  doc.text('Variance vs approved plan', left, y);
  autoTable(doc, {
    startY: y + 8,
    margin: { left, right: 40 },
    styles: { fontSize: 8.5, cellPadding: 4 },
    headStyles: { fillColor: [31, 29, 26] },
    head: [['Metric', 'Approved', 'Issued', 'Variance']],
    body: [
      ['Quantity (pcs)', n0.format(m.plannedQty), n0.format(m.issuedQty), `${signed(m.issuedQty - m.plannedQty)} (${pctText(m.qtyVarPct)})`],
      ['Value', rs(m.plannedValue), rs(m.issuedValue), `${m.issuedValue - m.plannedValue >= 0 ? '+' : ''}${rs(m.issuedValue - m.plannedValue)} (${pctText(m.valueVarPct)})`],
      ['PO count', `${n0.format(m.plannedPoCount)} (product x PO-type cells)`, `${n0.format(m.actualPoCount)} POs`, signed(m.actualPoCount - m.plannedPoCount)],
      ['Excess (issued above approved)', '-', `${n0.format(m.excessQty)} pcs · ${rs(m.excessValue)}`, m.excessPct == null ? '-' : `${(m.excessPct * 100).toFixed(1)}% of approved qty`],
      ['Short (issued below approved)', '-', `${n0.format(m.shortQty)} pcs · ${rs(m.shortValue)}`, m.shortPct == null ? '-' : `${(m.shortPct * 100).toFixed(1)}% of approved qty`],
      ['Products', `${m.approvedProducts} budgeted`, `${m.issuedProducts} issued`, `${a.exceptions.notBudgeted.length} not budgeted · ${a.exceptions.overApproved.length} over approved`],
    ],
  });

  const poRefs = (p: BuyingPlanAnalysis['products'][number]) =>
    p.pos.map((x) => `${x.po_ref_num || x.po_number || x.po_id} (${x.vendor_code ?? '?'} · ${n0.format(x.qty)})`).join(', ');

  // 3 — Exception (a)
  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 18;
  doc.setFontSize(11);
  doc.setTextColor(192, 57, 43);
  doc.text(`(a) Issued but NOT budgeted — ${a.exceptions.notBudgeted.length} product${a.exceptions.notBudgeted.length === 1 ? '' : 's'}`, left, y);
  doc.setTextColor(20);
  autoTable(doc, {
    startY: y + 8,
    margin: { left, right: 40 },
    styles: { fontSize: 8, cellPadding: 3, overflow: 'linebreak' },
    headStyles: { fillColor: [192, 57, 43] },
    columnStyles: { 4: { cellWidth: 200 } },
    head: [['Product', 'Reason', 'Issued qty', 'Issued value', 'PO references']],
    body: a.exceptions.notBudgeted.length
      ? a.exceptions.notBudgeted.map((p) => [p.product_code, STATUS_TEXT[p.status], n0.format(p.issuedQty), rs(p.issuedValue), poRefs(p)])
      : [['-', 'None — every issued product was budgeted and approved', '', '', '']],
  });

  // 4 — Exception (b)
  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 18;
  doc.setFontSize(11);
  doc.setTextColor(181, 117, 20);
  doc.text(`(b) Issued ABOVE approved — ${a.exceptions.overApproved.length} product${a.exceptions.overApproved.length === 1 ? '' : 's'}`, left, y);
  doc.setTextColor(20);
  autoTable(doc, {
    startY: y + 8,
    margin: { left, right: 40 },
    styles: { fontSize: 8, cellPadding: 3, overflow: 'linebreak' },
    headStyles: { fillColor: [181, 117, 20] },
    columnStyles: { 5: { cellWidth: 170 } },
    head: [['Product', 'Approved', 'Issued', 'Excess', 'Excess %', 'PO references']],
    body: a.exceptions.overApproved.length
      ? a.exceptions.overApproved.map((p) => [
          p.product_code,
          n0.format(p.plannedQty),
          n0.format(p.issuedQty),
          `+${n0.format(p.deltaQty)}`,
          p.plannedQty > 0 ? `${((p.deltaQty / p.plannedQty) * 100).toFixed(1)}%` : '-',
          poRefs(p),
        ])
      : [['-', '', '', '', '', 'None — nothing issued above its approved quantity']],
  });

  // 5 — All products (largest deviations first)
  doc.addPage();
  doc.setFontSize(11);
  doc.setTextColor(20);
  doc.text(`All products — approved vs issued (${a.products.length})`, left, 46);
  const sorted = [...a.products].sort((x, y2) => Math.abs(y2.deltaQty) - Math.abs(x.deltaQty)).slice(0, 250);
  autoTable(doc, {
    startY: 54,
    margin: { left, right: 40 },
    styles: { fontSize: 7.5, cellPadding: 2.5 },
    headStyles: { fillColor: [31, 29, 26] },
    head: [['Product', 'Status', 'Approved qty', 'Issued qty', 'Δ qty', 'Approved value', 'Issued value', 'POs']],
    body: sorted.map((p) => [
      p.product_code,
      STATUS_TEXT[p.status],
      n0.format(p.plannedQty),
      n0.format(p.issuedQty),
      signed(p.deltaQty),
      rs(p.plannedValue),
      rs(p.issuedValue),
      String(p.poCount),
    ]),
    tableWidth: width,
  });

  return Buffer.from(doc.output('arraybuffer'));
}

export type PlanReportResult =
  | { ok: true; path: string; bytes: number; url: string | null; posted: boolean; slackConfigured: boolean }
  | { ok: false; error: string };

/**
 * Generate (and optionally post) the month report. Idempotent per month: the PDF and the
 * registry row are overwritten; Slack is only posted when `post` is true.
 */
export async function generatePlanReport(
  planMonth: string,
  opts: { post: boolean; by: string },
): Promise<PlanReportResult> {
  if (!/^\d{4}-\d{2}-01$/.test(planMonth)) return { ok: false, error: 'Invalid plan month.' };
  if (!hasSupabaseAdminEnv()) return { ok: false, error: 'Service-role key not configured — the report needs it to read every row and write the file.' };
  const admin = createAdminClient();

  let analysis: BuyingPlanAnalysis;
  try {
    analysis = await loadBuyingPlanAnalysis(planMonth, admin as unknown as AnalysisDb);
  } catch (err) {
    return { ok: false, error: `Could not compute the analysis: ${err instanceof Error ? err.message : String(err)}` };
  }

  let pdf: Buffer;
  try {
    pdf = renderPlanReportPdf(analysis);
  } catch (err) {
    return { ok: false, error: `PDF render failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const path = `buying-plan/${planMonth.slice(0, 7)}.pdf`;
  const { error: upErr } = await admin.storage.from(BUCKET).upload(path, pdf, { contentType: 'application/pdf', upsert: true });
  if (upErr) return { ok: false, error: `Could not store the PDF: ${upErr.message}` };

  const m = analysis.metrics;
  const summary = {
    plannedQty: m.plannedQty,
    issuedQty: m.issuedQty,
    plannedValue: m.plannedValue,
    issuedValue: m.issuedValue,
    excessPct: m.excessPct,
    shortQty: m.shortQty,
    notBudgeted: analysis.exceptions.notBudgeted.length,
    overApproved: analysis.exceptions.overApproved.length,
    compliance: complianceLine(analysis),
    approvalKind: analysis.lifecycle.approvalKind,
  };

  const { data: signedData } = await admin.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS);
  const url = signedData?.signedUrl ?? null;

  let posted = false;
  let slackError: string | null = null;
  const slackConfigured = hasSupplyChainSlack();
  if (opts.post) {
    if (!slackConfigured) {
      slackError = 'No Slack webhook configured (SLACK_SUPPLY_CHAIN_WEBHOOK_URL / SLACK_OPS_WEBHOOK_URL).';
    } else {
      try {
        posted = await notifyPlanReportSlack({
          monthLabel: monthLabel(planMonth),
          plannedQty: m.plannedQty,
          issuedQty: m.issuedQty,
          plannedValue: m.plannedValue,
          issuedValue: m.issuedValue,
          excessPct: m.excessPct,
          shortQty: m.shortQty,
          notBudgeted: summary.notBudgeted,
          overApproved: summary.overApproved,
          compliance: summary.compliance,
          pdfUrl: url,
          analysisPath: `/buying-plan?month=${planMonth}&type=analysis`,
        });
        if (!posted) slackError = 'Slack post was skipped (no webhook).';
      } catch (err) {
        slackError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  const { error: regErr } = await admin.from('sd_plan_report').upsert(
    {
      plan_month: planMonth,
      plan_type: 'fg',
      generated_at: new Date().toISOString(),
      generated_by: opts.by,
      storage_path: path,
      file_bytes: pdf.length,
      summary,
      ...(opts.post ? { slack_posted_at: posted ? new Date().toISOString() : null, slack_error: slackError } : {}),
    },
    { onConflict: 'plan_month,plan_type' },
  );
  if (regErr) return { ok: false, error: `Report stored but the registry write failed: ${regErr.message}` };

  return { ok: true, path, bytes: pdf.length, url, posted, slackConfigured };
}

/** Short-lived signed URL for an already-generated report (viewer download). */
export async function signPlanReport(storagePath: string, seconds = 60 * 15): Promise<string | null> {
  if (!hasSupabaseAdminEnv()) return null;
  const admin = createAdminClient();
  const { data } = await admin.storage.from(BUCKET).createSignedUrl(storagePath, seconds);
  return data?.signedUrl ?? null;
}
