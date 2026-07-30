'use client';

import { useMemo, useState, useTransition } from 'react';
import { Plus, Save, TrendingUp } from 'lucide-react';
import { promoteToNpd, saveProductMaster } from '@/lib/forms/actions';
import { Field, Notice } from '@/components/forms/form-layout';
import type { NpdPromotionCandidate, ProductMaster } from '@/lib/forms/types';

const STATUSES = [
  'Active', 'Inactive', 'TBD', 'NPD', 'NPD-Not-Launched', 'Ongoing', 'Discontinued',
];
const FABRICS = ['Woven', 'Knitted'];

export function ProductMasterClient({
  products,
  npdCandidates,
  editable,
}: {
  products: ProductMaster[];
  npdCandidates: NpdPromotionCandidate[];
  editable: boolean;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [filter, setFilter] = useState('');
  const [draft, setDraft] = useState({ product_code: '', product_status: '', fabric_type: '' });

  const filled = products.filter((p) => p.product_status || p.fabric_type).length;

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q
      ? products.filter((p) => p.product_code.toLowerCase().includes(q))
      : products;
  }, [products, filter]);

  function submit(payload: FormData) {
    setError(null);
    setMessage(null);
    start(async () => {
      const result = await saveProductMaster(payload);
      if (result.ok) {
        setMessage(result.message ?? 'Saved.');
        window.location.reload();
      } else {
        setError(result.error);
      }
    });
  }

  function addProduct() {
    if (!draft.product_code.trim()) {
      setError('Enter a product code.');
      return;
    }
    const fd = new FormData();
    fd.set('product_code', draft.product_code.trim());
    fd.set('product_status', draft.product_status);
    fd.set('fabric_type', draft.fabric_type);
    fd.set('is_active', 'true');
    submit(fd);
  }

  function promote(productCode: string) {
    setError(null);
    setMessage(null);
    const fd = new FormData();
    fd.set('product_code', productCode);
    start(async () => {
      const result = await promoteToNpd(fd);
      if (result.ok) {
        setMessage(result.message ?? 'Promoted.');
        window.location.reload();
      } else setError(result.error);
    });
  }

  return (
    <>
      <Notice tone="info">
        {filled} of {products.length} products have status/fabric set. These values
        are read-only in the Buying Plan — maintained here.
      </Notice>

      {message && <Notice tone="ok">{message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      {npdCandidates.length > 0 && (
        <div className="panel wf-form-panel">
          <div className="panel-title">
            <h3>
              <TrendingUp size={16} /> Suggested NPD promotions
            </h3>
            <span className="wf-report-count">{npdCandidates.length}</span>
          </div>
          <Notice tone="warn">
            These products are still <strong>NPD – Not Launched</strong> but a colour
            has sold more than 50 pcs (last 45 days). The rule says promote them to
            NPD. Review and apply.
          </Notice>
          <div className="table-scroll">
            <table className="wf-grid">
              <thead>
                <tr>
                  <th>Product code</th>
                  <th>Name</th>
                  <th className="num">Colours &gt;50</th>
                  <th className="num">Top colour sales (45d)</th>
                  {editable && <th aria-label="Promote" />}
                </tr>
              </thead>
              <tbody>
                {npdCandidates.map((c) => (
                  <tr key={c.product_code}>
                    <td className="mono">{c.product_code}</td>
                    <td>{c.product_name ?? '—'}</td>
                    <td className="num">{c.qualifying_colours}</td>
                    <td className="num strong">
                      {Number(c.top_colour_sales_45d).toLocaleString('en-IN')}
                    </td>
                    {editable && (
                      <td>
                        <button
                          type="button"
                          className="wf-btn wf-btn-primary wf-btn-sm"
                          onClick={() => promote(c.product_code)}
                          disabled={pending}
                        >
                          <TrendingUp size={13} /> Promote to NPD
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {editable && (
        <div className="wf-form-panel">
          <div className="wf-form-grid">
            <Field label="Product code" hint="Add a code not already listed">
              <input
                value={draft.product_code}
                placeholder="e.g. SDRPT"
                onChange={(e) => setDraft({ ...draft, product_code: e.target.value })}
              />
            </Field>
            <Field label="Status">
              <select
                value={draft.product_status}
                onChange={(e) => setDraft({ ...draft, product_status: e.target.value })}
              >
                <option value="">—</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </Field>
            <Field label="Woven / Knitted">
              <select
                value={draft.fabric_type}
                onChange={(e) => setDraft({ ...draft, fabric_type: e.target.value })}
              >
                <option value="">—</option>
                {FABRICS.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            </Field>
            <button
              type="button"
              className="wf-btn wf-btn-primary"
              onClick={addProduct}
              disabled={pending}
            >
              <Plus size={15} /> Add / update
            </button>
          </div>
        </div>
      )}

      <div className="wf-toolbar">
        <input
          className="wf-search"
          placeholder="Filter product code…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="wf-subtle">{shown.length} shown</span>
      </div>

      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wf-grid">
            <thead>
              <tr>
                <th>Product code</th>
                <th>Status</th>
                <th>Woven / Knitted</th>
                <th>Active</th>
                {editable && <th aria-label="Save" />}
              </tr>
            </thead>
            <tbody>
              {shown.map((product) => (
                <ProductRow
                  key={product.product_code}
                  product={product}
                  editable={editable}
                  pending={pending}
                  onSave={(status, fabric, isActive) => {
                    const fd = new FormData();
                    fd.set('product_code', product.product_code);
                    fd.set('product_status', status);
                    fd.set('fabric_type', fabric);
                    fd.set('is_active', String(isActive));
                    submit(fd);
                  }}
                />
              ))}
              {!shown.length && (
                <tr>
                  <td colSpan={editable ? 5 : 4} className="wf-empty-cell">
                    No products match.
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

function ProductRow({
  product,
  editable,
  pending,
  onSave,
}: {
  product: ProductMaster;
  editable: boolean;
  pending: boolean;
  onSave: (status: string, fabric: string, isActive: boolean) => void;
}) {
  const [status, setStatus] = useState(product.product_status ?? '');
  const [fabric, setFabric] = useState(product.fabric_type ?? '');
  const [active, setActive] = useState(product.is_active);
  const dirty =
    status !== (product.product_status ?? '') ||
    fabric !== (product.fabric_type ?? '') ||
    active !== product.is_active;

  if (!editable) {
    return (
      <tr>
        <td className="mono">{product.product_code}</td>
        <td>{product.product_status || '—'}</td>
        <td>{product.fabric_type || '—'}</td>
        <td>{product.is_active ? 'Yes' : 'No'}</td>
      </tr>
    );
  }

  return (
    <tr>
      <td className="mono">{product.product_code}</td>
      <td>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">—</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </td>
      <td>
        <select value={fabric} onChange={(e) => setFabric(e.target.value)}>
          <option value="">—</option>
          {FABRICS.map((f) => (
            <option key={f} value={f}>{f}</option>
          ))}
        </select>
      </td>
      <td>
        <input
          type="checkbox"
          checked={active}
          onChange={(e) => setActive(e.target.checked)}
        />
      </td>
      <td>
        <button
          type="button"
          className="wf-btn wf-btn-ghost"
          disabled={!dirty || pending}
          onClick={() => onSave(status, fabric, active)}
        >
          <Save size={14} /> Save
        </button>
      </td>
    </tr>
  );
}
