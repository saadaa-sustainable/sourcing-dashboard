'use client';

import { useRef, useState } from 'react';
import { downloadCsv } from '@/lib/csv';
import { productOptions } from '@/lib/inward-plan-v2/products';
import { parseScheduleCsv, SCHEDULE_CSV_HEADERS } from '@/lib/inward-plan-v2/schedule-csv';
import type { HeaderDraft, LineDraft, ProductSource, SourceLine } from '@/lib/inward-plan-v2/types';
import styles from './v2.module.css';

export function ScheduleCsvUpload({ header, drafts, onImport, onBusy }: {
  header: HeaderDraft; drafts: LineDraft[]; onImport: (lines: LineDraft[]) => void; onBusy: (busy: boolean) => void;
}) {
  const [preview, setPreview] = useState<{ text: string; lines: LineDraft[]; products: ProductSource[] } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const showError = (error: unknown) => setErrors((error instanceof Error ? error.message : 'CSV could not be imported.').split('\n'));
  return <div className={styles.csvUpload} aria-label="Upload schedule CSV">
    <div className={styles.csvHeader}>
      <div><h4>Import Inward Plan entries in bulk</h4><p>Upload a CSV to add multiple PO products at once.</p></div>
      <button className="wf-btn wf-btn-ghost" type="button"
        onClick={() => downloadCsv('inward-plan-schedule-template.csv', SCHEDULE_CSV_HEADERS)}>Download CSV template</button>
    </div>
    <div className={styles.csvFileRow}>
      <button className="wf-btn wf-btn-ghost" type="button" disabled={loading} onClick={() => fileInput.current?.click()}>Choose CSV file</button>
      <span className={styles.csvFileName} title={fileName}>{fileName || 'No file selected'}</span>
      <span className={styles.csvLimit}>CSV only · Up to 5 MB · 500 total lines</span>
      <input ref={fileInput} className={styles.csvFileInput} tabIndex={-1} type="file" accept=".csv,text/csv" aria-label="Upload schedule CSV" onChange={async event => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (!file) return;
        setFileName(file.name);
        setPreview(null); setErrors([]); setMessage('');
        if (file.size > 5 * 1024 * 1024) { setErrors(['CSV must be no larger than 5 MB.']); return; }
        setLoading(true); onBusy(true);
        try {
          const text = await file.text();
          const response = await fetch('/inward-plan-v2/sources?field=product', { cache: 'no-store', credentials: 'same-origin' });
          const result: { rows?: SourceLine[]; error?: string } = await response.json();
          if (!response.ok || !Array.isArray(result.rows)) throw new Error(result.error || 'Could not validate CSV against current PO products.');
          const products = productOptions(result.rows);
          const lines = parseScheduleCsv(text, header, products, drafts);
          setPreview({ text, lines, products });
        } catch (error) { showError(error); }
        finally { setLoading(false); onBusy(false); }
      }} />
    </div>
    <dl className={styles.csvHelp}>
      <div><dt>Required columns</dt><dd>PO No, Product Code, Expected Inward Date, Quantity</dd></div>
      <div><dt>Optional columns</dt><dd>Cost/piece, Remarks. Blank cost uses the source price when available.</dd></div>
      <div><dt>Dates &amp; PO reference</dt><dd>YYYY-MM-DD or DD/MM/YYYY. Use the actual PO number or its unique reference; vendor comes from the PO.</dd></div>
    </dl>
    <p className={styles.csvHint}>Preview and confirm to append entries, then save your plan.</p>
    {loading && <div className={`${styles.csvNotice} wf-notice wf-notice-info`} role="status">Validating CSV against open PO products…</div>}
    {!!errors.length && <div className={`${styles.csvNotice} wf-notice wf-notice-error`} role="alert"><p>No CSV rows were added. Resolve these issues and upload again:</p><ul>{errors.map((error, index) => <li key={index}>{error}</li>)}</ul></div>}
    {message && <div className={`${styles.csvNotice} wf-notice wf-notice-ok`} role="status">{message}</div>}
    {preview && <div className={styles.csvPreview}>
      <div className={styles.csvPreviewHeading}><strong role="status">{preview.lines.length} validated CSV entries ready to append</strong><span>Preview shows the first 10</span></div>
      <div className={styles.scroll}><table className={styles.table}>
        <caption className={styles.srOnly}>CSV schedule preview</caption>
        <thead><tr><th>PO No</th><th>Product Code</th><th>Expected Inward Date</th><th>Quantity</th><th>Cost/piece</th><th>Remarks</th></tr></thead>
        <tbody>{preview.lines.slice(0, 10).map((line, index) => <tr key={index}><td>{line.po_label}</td><td>{line.product_code}</td><td>{line.expected_date}</td><td>{line.inward_qty}</td><td>{line.cost_per_piece || 'N/A'}</td><td>{line.remarks}</td></tr>)}</tbody>
      </table></div>
      <div className={styles.csvActions}>
        <button className="wf-btn wf-btn-primary" type="button" onClick={() => {
          try {
            const lines = parseScheduleCsv(preview.text, header, preview.products, drafts);
            onImport(lines); setPreview(null); setErrors([]);
            setMessage(lines.length + ' CSV entries added. Review the schedule and click Save changes or Save draft.');
          } catch (error) { showError(error); }
        }}>Add CSV entries to schedule</button>
        <button className="wf-btn wf-btn-ghost" type="button" onClick={() => { setPreview(null); setErrors([]); }}>Cancel CSV import</button>
      </div>
    </div>}
  </div>;
}
