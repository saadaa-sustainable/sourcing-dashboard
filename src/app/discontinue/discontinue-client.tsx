'use client';

import { useMemo, useState, useTransition } from 'react';
import { Ban } from 'lucide-react';
import { createDiscontinueRequest } from '@/lib/forms/actions';
import { canApprove, canEdit } from '@/lib/forms/approval';
import { Field, Notice, StatusBadge } from '@/components/forms/form-layout';
import { ApprovalBar } from '@/components/forms/approval-bar';
import type { DiscontinueRequest, SdRole } from '@/lib/forms/types';

export function DiscontinueClient({
  requests,
  variants,
  role,
}: {
  requests: DiscontinueRequest[];
  variants: { product_code: string; product_variant: string }[];
  role: SdRole;
}) {
  const editable = canEdit(role, 'draft');
  const [productCode, setProductCode] = useState('');
  const [variant, setVariant] = useState('');
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const productCodes = useMemo(
    () => [...new Set(variants.map((v) => v.product_code))].sort(),
    [variants],
  );
  const variantOptions = useMemo(
    () =>
      variants
        .filter((v) => v.product_code === productCode)
        .map((v) => v.product_variant)
        .sort(),
    [variants, productCode],
  );

  function submit() {
    setError(null);
    setMessage(null);
    const payload = new FormData();
    payload.set('product_code', productCode);
    payload.set('product_variant', variant);
    payload.set('reason', reason);
    start(async () => {
      const result = await createDiscontinueRequest(payload);
      if (result.ok) {
        setMessage(result.message ?? 'Submitted.');
        setProductCode('');
        setVariant('');
        setReason('');
      } else setError(result.error);
    });
  }

  return (
    <>
      <Notice tone="info">
        Approval only — no PO is issued here. Once approved, the variant drops out
        of the Buying Plan product list so it stops showing as in-process.
      </Notice>

      {message && <Notice tone="ok">{message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      {editable && (
        <div className="panel wf-form-panel">
          <div className="panel-title">
            <h3>Raise a discontinue request</h3>
          </div>
          <div className="wf-form-grid">
            <Field label="Product code">
              <select
                value={productCode}
                onChange={(event) => {
                  setProductCode(event.target.value);
                  setVariant('');
                }}
              >
                <option value="">Select…</option>
                {productCodes.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Variant" hint="Approval is at variant level">
              <select
                value={variant}
                disabled={!productCode}
                onChange={(event) => setVariant(event.target.value)}
              >
                <option value="">
                  {productCode ? 'Select…' : 'Pick a product code first'}
                </option>
                {variantOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Reason">
              <input
                value={reason}
                placeholder="Why is this variant being discontinued?"
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
          </div>
          <div className="wf-footer-actions">
            <button
              type="button"
              className="wf-btn wf-btn-primary"
              onClick={submit}
              disabled={pending || !productCode || !variant}
            >
              <Ban size={15} /> {pending ? 'Submitting…' : 'Submit for approval'}
            </button>
          </div>
        </div>
      )}

      <div className="table-panel">
        <div className="table-meta">
          <h3>Requests</h3>
          <span>{requests.length} total</span>
        </div>
        <div className="table-scroll">
          <table className="wide-table">
            <thead>
              <tr>
                <th>Product code</th>
                <th>Variant</th>
                <th>Reason</th>
                <th>Status</th>
                <th>Requested by</th>
                <th>Decision</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((request) => (
                <tr key={request.id}>
                  <td className="mono">{request.product_code}</td>
                  <td>{request.product_variant}</td>
                  <td>{request.reason ?? '—'}</td>
                  <td>
                    <StatusBadge status={request.status} />
                    {request.status === 'rejected' && request.rejection_notes && (
                      <small className="wf-subtle">{request.rejection_notes}</small>
                    )}
                  </td>
                  <td className="wf-subtle">{request.requested_by ?? '—'}</td>
                  <td>
                    {canApprove(role, request.status) ? (
                      <ApprovalBar
                        entityType="discontinue"
                        entityId={String(request.id)}
                        entityLabel={`${request.product_code} / ${request.product_variant}`}
                        onDone={(result) => {
                          if (result.ok) window.location.reload();
                        }}
                      />
                    ) : (
                      <span className="wf-subtle">
                        {request.approved_by ?? '—'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {!requests.length && (
                <tr>
                  <td colSpan={6} className="wf-empty-cell">
                    No discontinue requests yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
