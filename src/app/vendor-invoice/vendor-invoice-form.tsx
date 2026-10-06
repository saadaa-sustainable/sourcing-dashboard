'use client';

import { useRef, useState, useTransition } from 'react';
import { createClient } from '@/lib/supabase/client';
import { startVendorInvoiceUpload, submitVendorInvoice } from '@/lib/forms/actions';
import {
  asksVendorSection,
  emptyViDraft,
  validateViDraft,
  VI_ASSOCIATIONS,
  VI_BUCKET,
  VI_DOCUMENT_TYPES,
  VI_MAX_BYTES,
  VI_PO_TYPES,
  VI_VENDOR_CODES,
  type ViDraft,
} from '@/lib/vendor-invoice';

const OTHER = '__other__';

/**
 * The Google Form's questions on one page. Sections appear as the answers that lead to
 * them are given, following the form's branching:
 *   association -> (vendor code + PO type, unless a dyeing / fabric-supply partner)
 *   -> type of document -> that document's fields + its PDF.
 */
export function VendorInvoiceForm({ vendorNames }: { vendorNames: Record<string, string> }) {
  const [d, setD] = useState<ViDraft>(emptyViDraft);
  const [codeChoice, setCodeChoice] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [honeypot, setHoneypot] = useState('');
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const set = (k: keyof ViDraft) => (e: { target: { value: string } }) => setD((p) => ({ ...p, [k]: e.target.value }));
  const vendorSection = asksVendorSection(d.association);
  const docLabel = d.document_type === 'DEBIT NOTE' ? 'DEBIT NOTE' : d.document_type === 'CREDIT NOTE' ? 'CREDIT NOTE' : 'Invoice';

  function pickCode(v: string) {
    setCodeChoice(v);
    setD((p) => ({ ...p, vendor_code: v === OTHER ? '' : v }));
  }

  function pickFile(f: File | null) {
    setErr(null);
    if (f && (f.type !== 'application/pdf' && !/\.pdf$/i.test(f.name))) {
      setErr('Upload a PDF file only.');
      if (fileInput.current) fileInput.current.value = '';
      return setFile(null);
    }
    if (f && f.size > VI_MAX_BYTES) {
      setErr('The PDF is larger than 10 MB.');
      if (fileInput.current) fileInput.current.value = '';
      return setFile(null);
    }
    setFile(f);
  }

  function submit() {
    setErr(null);
    const checked = validateViDraft(d);
    if (!checked.ok) return setErr(checked.error);
    if (!file) return setErr(`Attach the ${docLabel} document (PDF).`);
    start(async () => {
      const ticket = await startVendorInvoiceUpload(file.name, file.size);
      if (!ticket.ok) return setErr(ticket.error);
      const { error: upErr } = await createClient()
        .storage.from(VI_BUCKET)
        .uploadToSignedUrl(ticket.path, ticket.token, file, { contentType: 'application/pdf' });
      if (upErr) return setErr('The PDF could not be uploaded. Please check your connection and try again.');
      const res = await submitVendorInvoice(d, ticket.path, file.name, honeypot);
      if (res.ok) setDone(true);
      else setErr(res.error);
    });
  }

  function another() {
    // Keep who they are and which PO; clear the document.
    setD((p) => ({
      ...emptyViDraft(),
      email: p.email, po_ref_num: p.po_ref_num, association: p.association, vendor_code: p.vendor_code, po_type: p.po_type,
    }));
    setFile(null);
    setErr(null);
    setDone(false);
  }

  if (done) {
    return (
      <div className="fill-done">
        <h2>Submitted ✓</h2>
        <p>Your response has been recorded. Please also submit the hard copy to the Merchandiser team / Warehouse / Saadaa Accounts.</p>
        <button type="button" className="fill-submit vi-again" onClick={another}>
          Submit another document
        </button>
      </div>
    );
  }

  return (
    <div className="fill-form">
      <label className="fill-field">
        <span>Email *</span>
        <input type="email" autoComplete="email" value={d.email} onChange={set('email')} />
      </label>
      <label className="fill-field">
        <span>PO No. issued by SAADAA *</span>
        <input value={d.po_ref_num} onChange={set('po_ref_num')} />
      </label>
      <label className="fill-field">
        <span>Your Association with SAADAA *</span>
        <select value={d.association} onChange={set('association')}>
          <option value="">Choose</option>
          {VI_ASSOCIATIONS.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
      </label>

      {vendorSection && (
        <fieldset className="vi-section">
          <legend>Fabrication Partner</legend>
          <label className="fill-field">
            <span>Vendor Code *</span>
            <select value={codeChoice} onChange={(e) => pickCode(e.target.value)}>
              <option value="">Choose</option>
              {VI_VENDOR_CODES.map((c) => (
                <option key={c} value={c}>
                  {vendorNames[c] ? `${c} — ${vendorNames[c]}` : c}
                </option>
              ))}
              <option value={OTHER}>Other…</option>
            </select>
          </label>
          {codeChoice === OTHER && (
            <label className="fill-field">
              <span>Other vendor code *</span>
              <input value={d.vendor_code} onChange={set('vendor_code')} />
            </label>
          )}
          <div className="fill-field" role="radiogroup" aria-label="PO Type">
            <span>PO Type *</span>
            {VI_PO_TYPES.map((t) => (
              <label key={t} className="vi-radio">
                <input type="radio" name="po_type" value={t} checked={d.po_type === t} onChange={set('po_type')} />
                {t}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {d.association && (
        <label className="fill-field">
          <span>TYPE OF DOCUMENT *</span>
          <select value={d.document_type} onChange={set('document_type')}>
            <option value="">Choose</option>
            {VI_DOCUMENT_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>
      )}

      {d.document_type === 'INVOICE' && (
        <fieldset className="vi-section">
          <legend>INVOICE DOCUMENT</legend>
          <p className="vi-note">1) अपलोड की गई इनवॉइस की हार्ड कॉपी मर्चेंडाइज़र टीम एवं सादा अकाउंट्स में जमा करवाएं।</p>
          <label className="fill-field">
            <span>Invoice Number *</span>
            <input value={d.invoice_number} onChange={set('invoice_number')} />
          </label>
          <label className="fill-field">
            <span>Invoice Date *</span>
            <input type="date" value={d.invoice_date} onChange={set('invoice_date')} />
          </label>
          <label className="fill-field">
            <span>Invoice Total Qty *</span>
            <input inputMode="decimal" value={d.invoice_total_qty} onChange={set('invoice_total_qty')} />
          </label>
          <label className="fill-field">
            <span>Invoice Value *</span>
            <input inputMode="decimal" value={d.invoice_value} onChange={set('invoice_value')} />
          </label>
          <label className="fill-field">
            <span>GRN Number (As per GRN Report)</span>
            <input value={d.grn_number} onChange={set('grn_number')} />
          </label>
          <label className="fill-field">
            <span>Reference Challan Number *</span>
            <input value={d.reference_challan_number} onChange={set('reference_challan_number')} />
          </label>
        </fieldset>
      )}

      {(d.document_type === 'DEBIT NOTE' || d.document_type === 'CREDIT NOTE') && (
        <fieldset className="vi-section">
          <legend>{d.document_type}</legend>
          <label className="fill-field">
            <span>Date of {d.document_type === 'DEBIT NOTE' ? 'Debit' : 'Credit'} Note *</span>
            <input type="date" value={d.note_date} onChange={set('note_date')} />
          </label>
          <label className="fill-field">
            <span>Reference Document Number *</span>
            <input value={d.reference_document_number} onChange={set('reference_document_number')} />
          </label>
        </fieldset>
      )}

      {d.document_type && (
        <label className="fill-field">
          <span>{docLabel} Document (PDF Only) *</span>
          <input
            ref={fileInput}
            type="file"
            accept="application/pdf,.pdf"
            onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
          />
          <small className="vi-hint">One PDF, up to 10 MB.</small>
        </label>
      )}

      {/* Bots fill every field; people never see this one. */}
      <input
        className="vi-hp"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        value={honeypot}
        onChange={(e) => setHoneypot(e.target.value)}
        name="website"
      />

      {err && <p className="fill-error">{err}</p>}
      <button type="button" className="fill-submit" disabled={busy} onClick={submit}>
        {busy ? 'Submitting…' : 'Submit'}
      </button>
    </div>
  );
}
