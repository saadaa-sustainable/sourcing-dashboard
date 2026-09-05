'use client';

import { useMemo, useState, useTransition } from 'react';
import { useColumnSort } from '@/lib/use-column-sort';
import { Check, CircleAlert, Save } from 'lucide-react';
import { saveProductCategory } from '@/lib/forms/actions';
import { Notice } from '@/components/forms/form-layout';
import type { CategoryMapRow } from '@/lib/category-mapping.server';

/**
 * Item 2 — the authoritative category / sub-category editor. Category and sub-category
 * are mandatory at product-code level; this is where the team sets/overrides them. The
 * effective value (what the app reads) prefills each row; saving writes the override to
 * sd_product_master, which the coalesced sd_product_catalog view then serves everywhere.
 */
export function CategoryMappingClient({
  rows,
  missingCount,
  categoryOptions,
  subCategoryOptions,
  editable,
}: {
  rows: CategoryMapRow[];
  missingCount: number;
  categoryOptions: string[];
  subCategoryOptions: string[];
  editable: boolean;
}) {
  const [search, setSearch] = useState('');
  const [missingOnly, setMissingOnly] = useState(false);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (missingOnly && r.effectiveCategory && r.effectiveSubCategory) return false;
      if (!q) return true;
      return (
        r.product_code.toLowerCase().includes(q) ||
        (r.product_name ?? '').toLowerCase().includes(q)
      );
    });
  }, [rows, search, missingOnly]);
  const sort = useColumnSort<CategoryMapRow>();

  return (
    <>
      <Notice tone="info">
        Category &amp; sub-category are mandatory at product-code level and the one authoritative
        dimension every zoomed-out view slices by. The team override set here wins over the
        EasyEcom-derived value; where nothing is set yet, the row is flagged below.
      </Notice>

      <div className="chip-row" style={{ margin: '10px 0' }}>
        {missingCount > 0 ? (
          <span className="wf-sub-banner is-pending">
            <CircleAlert size={15} /> {missingCount} product{missingCount === 1 ? '' : 's'} missing category
          </span>
        ) : (
          <span className="wf-sub-banner is-done">
            <Check size={15} /> Every product has a category
          </span>
        )}
        <input
          placeholder="Search code or name"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ padding: '5px 10px', borderRadius: 7, border: '1px solid var(--line-2,#e4e0d5)' }}
        />
        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12, fontWeight: 650 }}>
          <input type="checkbox" checked={missingOnly} onChange={(e) => setMissingOnly(e.target.checked)} />
          Missing only
        </label>
        <span className="wf-subtle">{shown.length} of {rows.length}</span>
      </div>

      <datalist id="cat-opts">
        {categoryOptions.map((c) => <option key={c} value={c} />)}
      </datalist>
      <datalist id="subcat-opts">
        {subCategoryOptions.map((c) => <option key={c} value={c} />)}
      </datalist>

      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wf-grid">
            <thead>
              <tr>
                <th {...sort.th('product', (r) => r.product_code)}>Product {sort.ind('product')}</th>
                <th {...sort.th('category', (r) => r.effectiveCategory)}>Category {sort.ind('category')}</th>
                <th {...sort.th('sub', (r) => r.effectiveSubCategory)}>Sub-category {sort.ind('sub')}</th>
                <th {...sort.th('source', (r) => (r.overrideCategory ? 'Team override' : r.effectiveCategory ? 'EasyEcom' : ''))}>Source {sort.ind('source')}</th>
                {editable && <th>Save</th>}
              </tr>
            </thead>
            <tbody>
              {sort.apply(shown).map((r) => (
                <CategoryRow
                  key={r.product_code}
                  row={r}
                  editable={editable}
                />
              ))}
              {!shown.length && (
                <tr><td colSpan={editable ? 5 : 4} className="wf-empty-cell">No products match.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function CategoryRow({ row, editable }: { row: CategoryMapRow; editable: boolean }) {
  const [cat, setCat] = useState(row.effectiveCategory ?? '');
  const [sub, setSub] = useState(row.effectiveSubCategory ?? '');
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const missing = !row.effectiveCategory || !row.effectiveSubCategory;
  const source = row.overrideCategory ? 'Team override' : row.effectiveCategory ? 'EasyEcom' : '—';

  function save() {
    setErr(null);
    if (!cat.trim() || !sub.trim()) {
      setErr('Both required.');
      return;
    }
    const fd = new FormData();
    fd.set('product_code', row.product_code);
    fd.set('category', cat.trim());
    fd.set('sub_category', sub.trim());
    start(async () => {
      const res = await saveProductCategory(fd);
      if (res.ok) setSaved(true);
      else setErr(res.error);
    });
  }

  return (
    <tr className={missing ? 'wf-row-attention' : undefined}>
      <td>
        <strong>{row.product_code}</strong>
        {row.product_name && <small className="wf-subtle" style={{ display: 'block' }}>{row.product_name}</small>}
      </td>
      <td>
        {editable ? (
          <input list="cat-opts" value={cat} onChange={(e) => { setCat(e.target.value); setSaved(false); }} placeholder="e.g. Menswear" />
        ) : (row.effectiveCategory ?? '—')}
      </td>
      <td>
        {editable ? (
          <input list="subcat-opts" value={sub} onChange={(e) => { setSub(e.target.value); setSaved(false); }} placeholder="e.g. Top wear" />
        ) : (row.effectiveSubCategory ?? '—')}
      </td>
      <td className="wf-subtle">{source}</td>
      {editable && (
        <td>
          {err && <span style={{ color: '#c0392b', fontSize: 11 }}>{err}</span>}
          <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={busy} onClick={save}>
            {saved ? <><Check size={12} /> Saved</> : <><Save size={12} /> {busy ? 'Saving…' : 'Save'}</>}
          </button>
        </td>
      )}
    </tr>
  );
}
