import 'server-only';
// Vendor Capacity — mandatory monthly report to management (user, 2026-10-09).
//
// On the 1st (Vercel cron → /api/cron/month-close, next to the Buying Plan report) — or on
// demand by an admin — this builds the month's PDF from the monthly analysis
// (loadVendorCapacityMonth), stores it in the private `plan-reports` bucket under
// vendor-capacity/YYYY-MM.pdf, records it in sd_plan_report (plan_type 'vendor_capacity'; one row
// per month, regenerating overwrites) and posts the headline figures + a signed link to the
// management Slack channel. Service-role client: the cron has no user session.

import { jsPDF } from 'jspdf';
import autoTableImport from 'jspdf-autotable';
import { createAdminClient, hasSupabaseAdminEnv } from '@/lib/supabase/admin';
import { loadVendorCapacityMonth } from '@/lib/vendor-capacity-month';
import { utilisationLabel } from '@/lib/utilisation';
import { hasManagementSlack, notifyVendorCapacityReportSlack } from '@/lib/slack';
import type { VendorCapacityMonth } from '@/lib/vendor-capacity-month-types';

const BUCKET = 'plan-reports';
export const VC_REPORT_TYPE = 'vendor_capacity';
const SIGNED_URL_SECONDS = 60 * 60 * 24 * 30;

type AutoTableFn = typeof autoTableImport;
const autoTable: AutoTableFn =
  ((autoTableImport as unknown as { default?: AutoTableFn }).default ?? autoTableImport) as AutoTableFn;

const n0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const num = (v: number | null | undefined) => (v == null ? '-' : n0.format(Math.round(v)));
const change = (a: number | null, b: number | null) => {
  if (a == null || b == null) return '-';
  const d = a - b;
  return d === 0 ? '0' : `${d > 0 ? '+' : '-'}${n0.format(Math.abs(d))}`;
};
const ist = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) : '-';

export function complianceText(a: VendorCapacityMonth): string {
  const t = a.totals;
  return t.compliancePct == null ? 'no weeks to update yet' : `${Math.round(t.compliancePct)}% of vendor-weeks updated (${t.vendorWeeksUpdated} of ${t.vendorWeeksExpected})`;
}

/** The month report as an A4 PDF. Pure: no I/O. */
export function renderVendorCapacityReportPdf(a: VendorCapacityMonth): Buffer {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const left = 40;
  const lastY = () => (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;
  let y = 46;
  doc.setFontSize(16);
  doc.setTextColor(22);
  doc.text(`Vendor Capacity - ${a.label}`, left, y);
  y += 16;
  doc.setFontSize(9);
  doc.setTextColor(90);
  doc.text(`Monthly report to management · ${a.closed ? 'month closed' : 'month running'} · generated ${new Date(a.generatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`, left, y);
  y += 18;

  const t = a.totals;
  autoTable(doc, {
    startY: y,
    margin: { left, right: left },
    head: [['Headline', 'Figure']],
    body: [
      ['Active vendors', num(t.active)],
      ['Weekly input', complianceText(a)],
      ['Vendors never updated this month', num(t.neverUpdated)],
      ['Capacity declared (pcs / month), first week -> last week', `${num(t.capStart)} -> ${num(t.capEnd)} (${change(t.capEnd, t.capStart)})`],
      ['PO capacity at month end (pcs)', num(t.poCapEnd)],
      ['On order at month end (pcs)', num(t.onOrderEnd)],
      ['Capacity used at month end', utilisationLabel(t.utilEnd)],
      ['Vendors over capacity in at least one week', num(t.overAnyWeek)],
    ],
    styles: { fontSize: 9, cellPadding: 4 },
    headStyles: { fillColor: [22, 21, 19], textColor: 255 },
    columnStyles: { 0: { cellWidth: 300 } },
  });
  y = lastY() + 20;

  doc.setFontSize(12);
  doc.setTextColor(22);
  doc.text('Week by week', left, y);
  autoTable(doc, {
    startY: y + 6,
    margin: { left, right: left },
    head: [['Week (Mon-Sun)', 'Vendors updated', 'Capacity / month', 'PO capacity', 'On order', 'Capacity used', 'Over capacity']],
    body: a.weeks.map((w) => [
      `${w.label}${w.running ? ' (running)' : ''}`,
      `${w.updated} / ${w.active}`,
      num(w.capacityPerMonth),
      num(w.poCapacity),
      num(w.onOrder),
      utilisationLabel(w.util),
      w.overVendors == null ? '-' : String(w.overVendors),
    ]),
    styles: { fontSize: 8, cellPadding: 3 },
    headStyles: { fillColor: [240, 198, 30], textColor: 22 },
    columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 6: { halign: 'right' } },
  });
  y = lastY() + 20;

  doc.setFontSize(12);
  doc.text('By vendor', left, y);
  autoTable(doc, {
    startY: y + 6,
    margin: { left, right: left },
    head: [['Vendor', 'Weeks updated', 'Capacity / month (start -> end)', 'Signed', 'On order (end)', 'Avg used', 'Peak used', 'Weeks over', 'Last update']],
    body: a.vendors.map((v) => [
      `${v.name}\n${[v.code, v.type].filter(Boolean).join(' · ')}`,
      `${v.weeksUpdated} / ${v.weeksExpected}`,
      `${num(v.capStart)} -> ${num(v.capEnd)}`,
      num(v.signed),
      num(v.onOrderEnd),
      utilisationLabel(v.avgUtil),
      utilisationLabel(v.peakUtil),
      String(v.weeksOver),
      ist(v.lastUpdate),
    ]),
    styles: { fontSize: 7, cellPadding: 2.5, overflow: 'linebreak' },
    headStyles: { fillColor: [240, 198, 30], textColor: 22, fontSize: 7 },
    alternateRowStyles: { fillColor: [250, 249, 245] },
    columnStyles: { 0: { cellWidth: 120 }, 1: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 7: { halign: 'right' } },
  });
  y = lastY() + 18;

  if (y > doc.internal.pageSize.getHeight() - 90) {
    doc.addPage();
    y = 46;
  }
  doc.setFontSize(8.5);
  doc.setTextColor(90);
  for (const note of a.notes) {
    const lines = doc.splitTextToSize(`- ${note}`, W - left * 2) as string[];
    doc.text(lines, left, y);
    y += lines.length * 10.5;
  }
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFontSize(7.5);
    doc.setTextColor(140);
    doc.text(`SAADAA Sourcing · Vendor Capacity ${a.label} · page ${p} of ${pages}`, left, doc.internal.pageSize.getHeight() - 20);
  }
  return Buffer.from(doc.output('arraybuffer'));
}

export type VendorCapacityReportResult =
  | { ok: true; path: string; bytes: number; url: string | null; posted: boolean; slackConfigured: boolean }
  | { ok: false; error: string };

/** Generate (and optionally post) the month's report. Idempotent per month. */
export async function generateVendorCapacityReport(month: string, opts: { post: boolean; by: string }): Promise<VendorCapacityReportResult> {
  if (!/^\d{4}-\d{2}-01$/.test(month)) return { ok: false, error: 'Invalid month.' };
  if (!hasSupabaseAdminEnv()) return { ok: false, error: 'Service-role key not configured — the report needs it to read every vendor and write the file.' };
  const admin = createAdminClient();

  let a: VendorCapacityMonth;
  try {
    a = await loadVendorCapacityMonth(month, admin as never);
  } catch (err) {
    return { ok: false, error: `Could not build the monthly analysis: ${err instanceof Error ? err.message : String(err)}` };
  }
  let pdf: Buffer;
  try {
    pdf = renderVendorCapacityReportPdf(a);
  } catch (err) {
    return { ok: false, error: `PDF render failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const path = `vendor-capacity/${month.slice(0, 7)}.pdf`;
  const { error: upErr } = await admin.storage.from(BUCKET).upload(path, pdf, { contentType: 'application/pdf', upsert: true });
  if (upErr) return { ok: false, error: `Could not store the PDF: ${upErr.message}` };
  const { data: signedData } = await admin.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS);
  const url = signedData?.signedUrl ?? null;

  const t = a.totals;
  const summary = {
    active: t.active,
    compliancePct: t.compliancePct,
    neverUpdated: t.neverUpdated,
    overAnyWeek: t.overAnyWeek,
    capStart: t.capStart,
    capEnd: t.capEnd,
    utilEnd: t.utilEnd,
  };

  let posted = false;
  let slackError: string | null = null;
  const slackConfigured = hasManagementSlack();
  if (opts.post) {
    if (!slackConfigured) slackError = 'No Slack webhook configured (SLACK_MANAGEMENT_WEBHOOK_URL / SLACK_SUPPLY_CHAIN_WEBHOOK_URL).';
    else {
      try {
        posted = await notifyVendorCapacityReportSlack({
          monthLabel: a.label,
          active: t.active,
          compliance: complianceText(a),
          neverUpdated: t.neverUpdated,
          overAnyWeek: t.overAnyWeek,
          capacity: `${num(t.capEnd)} pcs / month (first week ${num(t.capStart)})`,
          utilisation: utilisationLabel(t.utilEnd),
          pdfUrl: url,
          path: `/vendor-capacity?view=month&month=${month}`,
        });
        if (!posted) slackError = 'Slack post was skipped (no webhook).';
      } catch (err) {
        slackError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  const { error: regErr } = await admin.from('sd_plan_report').upsert(
    {
      plan_month: month,
      plan_type: VC_REPORT_TYPE,
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
