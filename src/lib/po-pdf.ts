import 'server-only';
// Spec 7.6 - the approved PO as a PDF.
//
// One page per PO: who it is with, what is being bought, at what price, on what critical
// path, and who approved it. It is generated from the request itself rather than stored,
// so it can never drift from the record - download it again and you get today's truth.
//
// Approved POs only. A draft or a request still in the queue is not a document anyone
// should be able to send to a vendor.

import { jsPDF } from 'jspdf';
import autoTableImport from 'jspdf-autotable';
import { addTnaDays, tnaBaseFor } from '@/lib/business-logic';
import { STATUS_LABEL } from '@/lib/forms/approval';
import type { PoApproval, PoApprovalLine } from '@/lib/forms/types';

// CJS/ESM interop: the externalised package may expose the function as `default`.
type AutoTableFn = typeof autoTableImport;
const autoTable: AutoTableFn =
  ((autoTableImport as unknown as { default?: AutoTableFn }).default ?? autoTableImport) as AutoTableFn;

const n0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const n2 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
// The built-in Helvetica has no ₹ glyph - write "Rs".
const rs = (v: number | null | undefined) => (v == null ? '-' : `Rs ${n2.format(Number(v))}`);
const dash = (v: string | null | undefined) => (v && String(v).trim() ? String(v) : '-');
const day = (iso: string | null | undefined) =>
  iso
    ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      })
    : '-';
const ts = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Kolkata',
      })
    : '-';

const finalY = (doc: jsPDF) => (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;

/** Renders one approved PO as a PDF (A4 portrait). Pure: no I/O. */
export function renderPoPdf(po: PoApproval, lines: PoApprovalLine[]): Buffer {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const left = 40;

  doc.setFontSize(16);
  doc.setTextColor(20);
  doc.text(`Purchase Order - ${po.request_id}`, left, 46);
  doc.setFontSize(8.5);
  doc.setTextColor(110);
  doc.text(
    `${STATUS_LABEL[po.status]} · generated ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST · SAADAA Sourcing Dashboard`,
    left,
    60,
  );
  // An approved PO that has no EasyCom number yet has not reached the vendor - say so on
  // the document itself rather than letting it read as a live order.
  if (!po.po_issued_at) {
    doc.setTextColor(179, 38, 30);
    doc.text('Approved internally - not yet created in EasyCom. Dates below are provisional.', left, 72);
    doc.setTextColor(110);
  }

  const base = tnaBaseFor({ po_issued_at: po.po_issued_at });

  autoTable(doc, {
    startY: po.po_issued_at ? 84 : 92,
    margin: { left, right: 40 },
    theme: 'plain',
    styles: { fontSize: 9, cellPadding: 3 },
    columnStyles: { 0: { fontStyle: 'bold', cellWidth: 130 }, 2: { fontStyle: 'bold', cellWidth: 120 } },
    body: [
      ['Vendor', `${dash(po.vendor_code).toUpperCase()} ${dash(po.vendor_name)}`, 'Product', dash(po.product_code)],
      ['PO type', dash(po.po_type), 'Category', (po.category ?? '').toUpperCase()],
      ['Quantity', `${n0.format(Number(po.po_qty || 0))} pcs`, 'Rate', rs(po.rate)],
      ['EasyCom PO no.', dash(po.easycom_po_no), 'EasyCom reference', dash(po.po_ref_num)],
      ['Buying plan', dash(po.buying_plan_no), 'Order value', rs(Number(po.po_qty || 0) * Number(po.rate || 0))],
    ],
  });

  // Cost build-up - what the vendor controls, and what is commodity.
  let y = finalY(doc) + 16;
  doc.setFontSize(11);
  doc.setTextColor(20);
  doc.text('Cost per piece', left, y);
  autoTable(doc, {
    startY: y + 8,
    margin: { left, right: 40 },
    styles: { fontSize: 8.5, cellPadding: 4 },
    headStyles: { fillColor: [31, 29, 26] },
    head: [['Rate', 'CMTP', 'Grey', 'Finished fabric', 'Margin %']],
    body: [[rs(po.rate), rs(po.cm_cost), rs(po.grey_cost), rs(po.finished_fabric_cost), po.margin_pct == null ? '-' : `${po.margin_pct}%`]],
  });

  // Critical path - days as agreed, and the dates they produce from the EasyCom PO date.
  y = finalY(doc) + 16;
  doc.setFontSize(11);
  doc.text('Critical path (TNA)', left, y);
  doc.setFontSize(8);
  doc.setTextColor(110);
  doc.text(
    base.source === 'issued'
      ? `Counted from the EasyCom PO date, ${day(base.date)}.`
      : `No EasyCom PO yet - counted from today, ${day(base.date)}. Every date moves to the day the PO is created in EasyCom.`,
    left,
    y + 12,
  );
  doc.setTextColor(20);
  const stage = (label: string, days: number | null | undefined, fallback: string | null) => [
    label,
    days == null ? '-' : `+${days} days`,
    days == null ? day(fallback) : day(addTnaDays(base.date, days) ?? fallback),
  ];
  autoTable(doc, {
    startY: y + 20,
    margin: { left, right: 40 },
    styles: { fontSize: 8.5, cellPadding: 4 },
    headStyles: { fillColor: [31, 29, 26] },
    head: [['Stage', 'Days from EasyCom PO', 'Date']],
    body: [
      stage('PP sample', po.tna_days_pp_sample, po.cs_pp_sample_due),
      stage('GPT', po.tna_days_gpt, po.cs_gpt_due),
      stage('Cutting start', po.tna_days_cutting, po.cs_cutting_start),
      stage('Inline QC', po.tna_days_inline_qc, po.cs_inline_qc_due),
      stage('First delivery', po.tna_days_first_delivery, po.critical_path_first_delivery),
      stage('PO closing', po.tna_days_po_closing, po.po_closing_date),
    ],
  });

  // Size break-up.
  if (lines.length) {
    y = finalY(doc) + 16;
    doc.setFontSize(11);
    doc.text('Quantity by SKU', left, y);
    autoTable(doc, {
      startY: y + 8,
      margin: { left, right: 40 },
      styles: { fontSize: 8.5, cellPadding: 4 },
      headStyles: { fillColor: [31, 29, 26] },
      head: [['SKU', 'Variant', 'Size', 'Qty']],
      body: lines.map((l) => {
        const variant = (l.product_variant ?? '').trim().toUpperCase();
        const size = (l.size ?? '').trim().toUpperCase();
        return [size ? `${variant}_${size}` : variant || '-', variant || '-', size || '-', n0.format(Number(l.qty || 0))];
      }),
      foot: [['', '', 'Total', n0.format(lines.reduce((s, l) => s + Number(l.qty || 0), 0))]],
      footStyles: { fillColor: [245, 242, 234], textColor: 20, fontStyle: 'bold' },
    });
  }

  // The approval trail - the three dates, and who signed off.
  y = finalY(doc) + 16;
  doc.setFontSize(11);
  doc.text('Approval trail', left, y);
  autoTable(doc, {
    startY: y + 8,
    margin: { left, right: 40 },
    theme: 'plain',
    styles: { fontSize: 8.5, cellPadding: 3 },
    columnStyles: { 0: { fontStyle: 'bold', cellWidth: 150 } },
    body: [
      ['Raised by', `${dash(po.created_by)} · ${ts(po.timestamp_created)}`],
      ['Request raised for approval', ts(po.submitted_for_approval_at)],
      ['Approved by', `${dash(po.approved_by)} · ${ts(po.approved_at)}`],
      ['EasyCom PO created', po.po_issued_at ? ts(po.po_issued_at) : 'not yet'],
      ['TNA confirmed by', po.tna_confirmed ? `${dash(po.tna_confirmed_by)} · ${ts(po.tna_confirmed_at)}` : 'not confirmed'],
      ['PO signed', po.date_of_po_sign ? `${day(po.date_of_po_sign)} · ref ${dash(po.signed_po_ref_number)}` : 'not signed'],
      ['Remark at submission', dash(po.submit_remark)],
    ],
  });

  doc.setFontSize(7.5);
  doc.setTextColor(140);
  doc.text(
    'Generated from the sourcing dashboard record. Not a tax document; the EasyCom PO is the commercial instrument.',
    left,
    Math.min(finalY(doc) + 22, 810),
  );

  return Buffer.from(doc.output('arraybuffer'));
}
