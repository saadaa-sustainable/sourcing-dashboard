'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { Notice } from '@/components/forms/form-layout';
import { FilterTable, type Column } from '@/components/filter-table';
import type { NpdMasterRow } from '@/lib/npd-tracker.server';

const fmt = new Intl.NumberFormat('en-IN');
const day = (v: string | null) =>
  v ? new Date(v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) : '—';

const STAGE_LABEL: Record<NpdMasterRow['stage'], string> = {
  added: 'On Standard Cost',
  linked: 'Linked to EasyEcom',
  can_add: 'Can be added',
  blocked: 'Blocked',
  launched: 'Launched',
};
const STAGE_TONE: Record<NpdMasterRow['stage'], string> = {
  added: 'success',
  linked: 'success',
  can_add: 'info',
  blocked: 'warn',
  launched: '',
};

/**
 * Master → NPD Products: the record of new products. Every product on NPD Tracker V7 (read live)
 * with where it stands here — on Standard Cost (added from NPD, by whom and when), linked to its
 * EasyEcom code, can be added, blocked (and why), or launched. Read-only: products are added on
 * Standard Cost, and fixed on NPD Tracker V7.
 */
export function NpdProductsClient({ rows, error }: { rows: NpdMasterRow[]; error: string | null }) {
  const counts = useMemo(() => {
    const c = { added: 0, linked: 0, can_add: 0, blocked: 0, launched: 0 };
    for (const r of rows) c[r.stage] += 1;
    return c;
  }, [rows]);

  if (error) return <Notice tone="error">{error}</Notice>;

  const columns: Column<NpdMasterRow>[] = [
    { key: 'code', label: 'Item code', kind: 'mono', filter: 'text', source: 'npd', accessor: (r) => r.code ?? r.item_code ?? '',
      render: (r) => (r.stage === 'added' || r.stage === 'linked') && r.code
        ? <Link href={`/standard-cost/${encodeURIComponent(r.code)}`}>{r.code}</Link>
        : (r.code ?? r.item_code ?? '—'),
      info: 'The NPD item code, upper-cased — the product code a new product carries on Standard Cost, Buying Plan and PO.' },
    { key: 'product_name', label: 'Product', kind: 'text', filter: 'text', source: 'npd', accessor: (r) => r.product_name ?? '',
      info: 'The product name on NPD Tracker V7.' },
    { key: 'sku_code', label: 'SKU code (NPD)', kind: 'mono', filter: 'text', source: 'npd', accessor: (r) => r.sku_code,
      info: 'The SKU-code cell as written on NPD Tracker V7. PO Approval reads the colour codes for the SKU quantities from it.' },
    { key: 'category', label: 'Category', kind: 'text', filter: 'select', source: 'npd', accessor: (r) => r.category ?? '—' },
    { key: 'product_type', label: 'Type', kind: 'text', filter: 'select', source: 'npd', accessor: (r) => r.product_type ?? '—',
      info: 'New product or product improvement, as NPD Tracker V7 records it.' },
    { key: 'status', label: 'NPD status', kind: 'text', filter: 'select', source: 'npd', accessor: (r) => r.status ?? 'No status' },
    { key: 'launch', label: 'Launch', kind: 'text', filter: 'select', source: 'npd', accessor: (r) => r.launch ?? '—' },
    { key: 'stage', label: 'On the dashboard', kind: 'text', filter: 'select', source: 'computed', accessor: (r) => STAGE_LABEL[r.stage],
      render: (r) => <span className={`badge ${STAGE_TONE[r.stage]}`}>{STAGE_LABEL[r.stage]}</span>,
      info: 'On Standard Cost = added from NPD Tracker V7. Linked to EasyEcom = since joined to its EasyEcom product code. Can be added = not launched, has a clean item code. Blocked = see the note. Launched = should already be in EasyEcom.' },
    { key: 'note', label: 'Note', kind: 'text', filter: 'text', source: 'computed', accessor: (r) => r.note,
      render: (r) => <span className="wf-subtle">{r.note}</span> },
    { key: 'added_by', label: 'Added by', kind: 'text', filter: 'select', source: 'supabase', accessor: (r) => r.added_by ?? '—' },
    { key: 'added_at', label: 'Added on', kind: 'text', filter: 'none', source: 'supabase', accessor: (r) => r.added_at ?? '', render: (r) => day(r.added_at) },
  ];

  return (
    <>
      <Notice tone="info">
        The record of new products. Every product on <strong>NPD Tracker V7</strong>, read live, with where it stands here.
        A product not in EasyEcom is added only on <Link href="/standard-cost">Standard Cost → Add product → From NPD Tracker V7</Link>,
        under its item code. A blocked one is fixed on NPD Tracker V7.
      </Notice>
      <div className="metric-grid wf-metric-grid">
        <div className="metric-card"><span className="metric-label">On Standard Cost</span><strong>{fmt.format(counts.added + counts.linked)}</strong><small>{fmt.format(counts.linked)} linked to EasyEcom</small></div>
        <div className="metric-card"><span className="metric-label">Can be added</span><strong>{fmt.format(counts.can_add)}</strong><small>not launched, clean item code</small></div>
        <div className="metric-card"><span className="metric-label">Blocked</span><strong>{fmt.format(counts.blocked)}</strong><small>to fix on NPD Tracker V7</small></div>
        <div className="metric-card"><span className="metric-label">Launched</span><strong>{fmt.format(counts.launched)}</strong><small>should be in EasyEcom</small></div>
      </div>
      <FilterTable
        rows={rows}
        columns={columns}
        rowKey={(r) => String(r.id)}
        searchPlaceholder="Item code, product, SKU code…"
        emptyText="No products on NPD Tracker V7."
        unit="products"
        defaultSource="npd"
        download={{ filename: 'npd-products' }}
      />
    </>
  );
}
