import type { Metadata } from 'next';
import { loadVendorView, VI_PENDING_FROM } from '@/lib/vendor-invoice-view';
import { ViewFileButton } from './view-file-button';

// A vendor's own "pending and filled invoices" page. No login: the long random token in the
// URL is the key, issued per vendor code from /vendor-invoices and revocable there. An
// unknown or revoked token gets the same generic page, so tokens cannot be probed.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Your invoices · SAADAA',
  robots: { index: false, follow: false },
};

const fmtDate = (s: string | null) =>
  s ? new Date(`${s.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const qty = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

export default async function VendorViewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let view = null;
  try {
    view = await loadVendorView(token);
  } catch {
    view = null;
  }

  if (!view) {
    return (
      <main className="fill-shell">
        <div className="fill-card">
          <div className="fill-brand">SAADAA</div>
          <h1>Link no longer active</h1>
          <p>This link has expired or was switched off. Please ask the SAADAA team for a fresh link.</p>
        </div>
      </main>
    );
  }

  const uploadHref = `/vendor-invoice?code=${encodeURIComponent(view.vendorCode)}`;

  return (
    <main className="fill-shell vi-view-shell">
      <div className="fill-card vi-view-card">
        <div className="fill-brand">SAADAA</div>
        <h1>Your invoices</h1>
        <p className="fill-meta">
          Vendor <strong>{view.vendorCode}</strong>
          {view.vendorName ? <> · {view.vendorName}</> : null}
        </p>
        <a className="fill-submit vi-upload-btn" href={uploadHref}>
          Upload an invoice / debit note / credit note
        </a>

        <section className="vi-view-section">
          <h2>Pending ({view.pending.length})</h2>
          <p className="vi-hint">
            POs where goods were received at the SAADAA warehouse on or after {fmtDate(VI_PENDING_FROM)} and the
            quantity on your uploaded invoices is still less than the quantity received.
          </p>
          {view.pending.length ? (
            <div className="vi-table-wrap">
              <table className="vi-table">
                <thead>
                  <tr>
                    <th>PO No.</th>
                    <th>Received on</th>
                    <th className="num">Qty received</th>
                    <th className="num">Qty invoiced</th>
                    <th className="num">Not yet invoiced</th>
                  </tr>
                </thead>
                <tbody>
                  {view.pending.map((p) => (
                    <tr key={p.po}>
                      <td className="mono">{p.po}</td>
                      <td>
                        {fmtDate(p.first_grn)}
                        {p.last_grn !== p.first_grn ? <> – {fmtDate(p.last_grn)}</> : null}
                        <span className="vi-sub"> · {p.grn_ids.length} GRN{p.grn_ids.length === 1 ? '' : 's'}</span>
                      </td>
                      <td className="num">{qty.format(p.received)}</td>
                      <td className="num">{qty.format(p.invoiced)}</td>
                      <td className="num vi-due">{qty.format(p.received - p.invoiced)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="vi-empty">Nothing pending.</p>
          )}
        </section>

        <section className="vi-view-section">
          <h2>Filled ({view.entries.length})</h2>
          {view.entries.length ? (
            <div className="vi-table-wrap">
              <table className="vi-table">
                <thead>
                  <tr>
                    <th>Uploaded</th>
                    <th>Document</th>
                    <th>PO No.</th>
                    <th>Number</th>
                    <th>Date</th>
                    <th className="num">Qty</th>
                    <th className="num">Value</th>
                    <th>PDF</th>
                  </tr>
                </thead>
                <tbody>
                  {view.entries.map((e) => (
                    <tr key={e.id}>
                      <td>{fmtDate(e.created_at)}</td>
                      <td>{e.document_type}</td>
                      <td className="mono">{e.po_ref_num}</td>
                      <td className="mono">{e.invoice_number ?? e.reference_document_number ?? '—'}</td>
                      <td>{fmtDate(e.invoice_date ?? e.note_date)}</td>
                      <td className="num">{e.invoice_total_qty == null ? '—' : qty.format(e.invoice_total_qty)}</td>
                      <td className="num">{e.invoice_value == null ? '—' : `₹${qty.format(e.invoice_value)}`}</td>
                      <td>
                        <ViewFileButton token={token} id={e.id} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="vi-empty">No documents uploaded yet.</p>
          )}
        </section>
      </div>
    </main>
  );
}
