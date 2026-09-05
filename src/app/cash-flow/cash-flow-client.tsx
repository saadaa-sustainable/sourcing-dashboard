'use client';

import { useMemo, useState, useTransition } from 'react';
import { Save } from 'lucide-react';
import { useColumnSort } from '@/lib/use-column-sort';
import { saveVendorTerms } from '@/lib/forms/actions';
import { Notice } from '@/components/forms/form-layout';
import type { CashFlowMonth, VendorTerm } from '@/lib/forms/types';

const money = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});
// Compact crore/lakh label.
function inr(n: number) {
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(1)} L`;
  return money.format(n);
}
function monthLabel(iso: string) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function CashFlowClient({
  months,
  vendorTerms,
  editable,
}: {
  months: CashFlowMonth[];
  vendorTerms: VendorTerm[];
  editable: boolean;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [showTerms, setShowTerms] = useState(false);
  const termSort = useColumnSort<VendorTerm>();

  const thisMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
  // Forward-looking (this month onward) + a single "overdue" bucket for past-due.
  const forward = useMemo(
    () => months.filter((m) => m.due_month.slice(0, 7) >= thisMonth),
    [months, thisMonth],
  );
  const overdue = useMemo(
    () =>
      months
        .filter((m) => m.due_month.slice(0, 7) < thisMonth)
        .reduce((s, m) => s + m.received, 0),
    [months, thisMonth],
  );
  const maxTotal = Math.max(1, ...forward.map((m) => m.total));
  const next3 = forward.slice(0, 3).reduce((s, m) => s + m.total, 0);

  return (
    <>
      <Notice tone="info">
        Each buying commitment is projected to its <strong>payment-due month</strong> via
        the vendor’s payment terms. <strong>Received</strong> = invoiced goods (due
        invoice date + terms); <strong>Projected</strong> = open POs not yet received
        (due delivery date + terms). Change a vendor’s terms below and the forecast
        recomputes.
      </Notice>

      {message && <Notice tone="ok">{message}</Notice>}

      <div className="metric-grid wf-metric-grid">
        <div className="metric-card">
          <span className="metric-label">Due next 3 months</span>
          <strong>{inr(next3)}</strong>
        </div>
        <div className="metric-card tone-teal">
          <span className="metric-label">This month</span>
          <strong>{inr(forward[0]?.total ?? 0)}</strong>
        </div>
        <div className={overdue > 0 ? 'metric-card tone-orange' : 'metric-card'}>
          <span className="metric-label">Past due (unpaid?)</span>
          <strong>{inr(overdue)}</strong>
        </div>
      </div>

      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wide-table wf-grid">
            <thead>
              <tr>
                <th>Month due</th>
                <th className="num">Received (invoiced)</th>
                <th className="num">Projected (open PO)</th>
                <th className="num">Total</th>
                <th>Share</th>
              </tr>
            </thead>
            <tbody>
              {forward.map((m) => (
                <tr key={m.due_month}>
                  <td className="strong">{monthLabel(m.due_month)}</td>
                  <td className="num">{inr(m.received)}</td>
                  <td className="num">{inr(m.projected)}</td>
                  <td className="num strong">{inr(m.total)}</td>
                  <td>
                    <div className="wf-progress" style={{ maxWidth: 200 }}>
                      <div
                        className="wf-progress-fill"
                        style={{ width: `${Math.round((m.total / maxTotal) * 100)}%` }}
                      />
                    </div>
                  </td>
                </tr>
              ))}
              {!forward.length && (
                <tr>
                  <td colSpan={5} className="wf-empty-cell">
                    No upcoming obligations.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="wf-toolbar">
        <button
          type="button"
          className="wf-btn wf-btn-ghost wf-btn-sm"
          onClick={() => setShowTerms((v) => !v)}
        >
          {showTerms ? 'Hide' : 'Show'} vendor payment terms ({vendorTerms.length})
        </button>
      </div>

      {showTerms && (
        <div className="table-panel wf-grid-panel">
          <div className="table-scroll">
            <table className="wf-grid">
              <thead>
                <tr>
                  <th {...termSort.th('vendor', (t) => t.vendor_name || t.vendor_code)}>Vendor {termSort.ind('vendor')}</th>
                  <th className="num input-col" {...termSort.th('days', (t) => t.payment_terms_days)}>Payment terms (days) {termSort.ind('days')}</th>
                  {editable && <th aria-label="Save" />}
                </tr>
              </thead>
              <tbody>
                {termSort.apply(vendorTerms).map((t) => (
                  <TermRow
                    key={t.vendor_code}
                    term={t}
                    editable={editable}
                    onSaved={() => setMessage('Terms saved — forecast updated on reload.')}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

function TermRow({
  term,
  editable,
  onSaved,
}: {
  term: VendorTerm;
  editable: boolean;
  onSaved: () => void;
}) {
  const [days, setDays] = useState(String(term.payment_terms_days));
  const [pending, start] = useTransition();
  const dirty = days !== String(term.payment_terms_days);

  function save() {
    const fd = new FormData();
    fd.set('vendor_code', term.vendor_code);
    fd.set('payment_terms_days', days);
    start(async () => {
      const res = await saveVendorTerms(fd);
      if (res.ok) onSaved();
    });
  }

  return (
    <tr>
      <td>
        {term.vendor_name || term.vendor_code}
        <small className="mono wf-subtle">{term.vendor_code}</small>
      </td>
      <td className="num input-col">
        <input
          type="number"
          min={0}
          value={days}
          disabled={!editable}
          onChange={(e) => setDays(e.target.value)}
        />
      </td>
      {editable && (
        <td>
          <button
            type="button"
            className="wf-btn wf-btn-ghost wf-btn-sm"
            disabled={!dirty || pending}
            onClick={save}
          >
            <Save size={13} /> Save
          </button>
        </td>
      )}
    </tr>
  );
}
