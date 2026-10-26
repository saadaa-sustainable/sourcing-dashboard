'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Download } from 'lucide-react';
import type { StandardCost, StandardCostRateHistory } from '@/lib/forms/types';
import { FINISHED_GOODS_COST_STATUSES, finishedGoodsCostStatus, finishedGoodsCostUpdatedAt, hasApprovedProductCost, type FinishedGoodsCostProduct, type FinishedGoodsCostRevision } from '@/lib/finished-goods-cost';
import { downloadCsv } from '@/lib/download';
import { openFinishedGoodsCost } from './finished-goods-actions';
import './workflow.css';

const money = (n: number | null | undefined) => n == null ? '—' : new Intl.NumberFormat('en-IN', { style:'currency',currency:'INR',maximumFractionDigits:2 }).format(n);
const dateDisplay = (value: string | null) => value ? new Date(value).toLocaleDateString('en-IN', { day:'numeric',month:'short',year:'numeric',timeZone:'Asia/Kolkata' }) : '—';

export function FinishedGoodsCostTable({ products, costs, history, canEdit, warning, revisions = [], initialStatus = 'all' }: {
  products: FinishedGoodsCostProduct[]; costs: StandardCost[]; history: Record<string, StandardCostRateHistory[]>; canEdit: boolean; warning?: string;
  revisions?: FinishedGoodsCostRevision[];
  initialStatus?: string;
}) {
  const router = useRouter();
  const [query,setQuery] = useState('');
  const [page,setPage] = useState(0);
  const [status,setStatus] = useState(initialStatus);
  const [view,setView] = useState<'list' | 'kanban'>('list');
  const [busy,start] = useTransition();
  const [error,setError] = useState('');
  const costByCode = useMemo(() => new Map(costs.map(c => [c.product_code.toUpperCase(),c])),[costs]);
  const revisionByCode = useMemo(() => {
    const result = new Map<string, FinishedGoodsCostRevision>();
    for (const revision of revisions) {
      const code = revision.product_code.toUpperCase();
      if (revision.status !== 'approved' && (!result.has(code) || result.get(code)!.id < revision.id)) result.set(code,revision);
    }
    return result;
  },[revisions]);
  const rows = useMemo(() => products.map(product => {
    const cost = costByCode.get(product.code), accepted = history[product.code] ?? [];
    return { product, cost, updated: hasApprovedProductCost(cost,accepted), rate: accepted[0] ?? cost,
      status: finishedGoodsCostStatus(cost, accepted, revisionByCode.get(product.code)),
      updatedAt: finishedGoodsCostUpdatedAt(cost, accepted) };
  }),[products,costByCode,history,revisionByCode]);
  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    const matchesStatus = (rowStatus: string) =>
      status === 'all' ||
      (status === 'summary_not_added' && (rowStatus === 'Not added' || rowStatus === 'Draft')) ||
      (status === 'summary_pending' && rowStatus === 'Approval Pending') ||
      (status === 'signed_off' && rowStatus === 'Approved') ||
      (status === 'summary_partial' && rowStatus === 'Partially Approved') ||
      (status === 'summary_resubmit' && (rowStatus === 'Rework / Reassign' || rowStatus === 'Rejected / Discarded')) ||
      rowStatus === status;
    return rows.filter(({product:p,status:rowStatus}) => matchesStatus(rowStatus) && `${p.code} ${p.name} ${p.skus.join(' ')}`.toLowerCase().includes(search));
  },[rows,query,status]);
  function exportCsv() {
    downloadCsv('standard-cost-finished-goods', ['Product code','Product name','Master','Status','Job','FOB','E-FOB','Standard Cost updated date'],
      filtered.map(({product,rate,status:rowStatus,updatedAt}) => [product.code,product.name,product.source,rowStatus,rate?.job_cost,rate?.fob_cost,rate?.efob_cost,updatedAt ? dateDisplay(updatedAt) : '']));
  }
  function open(code: string) {
    setError('');
    start(async () => {
      try {
        const result = await openFinishedGoodsCost(code);
        if (result.ok) router.push(result.href);
        else setError(result.error);
      } catch { setError('Could not open the cost editor. Try again.'); }
    });
  }
  return <section id="finished-goods-cost-sheet" className="scw-panel" aria-label="Finished Goods cost sheet">
    <h2>Finished Goods cost sheet</h2>
    <p className="wf-subtle">Search a product from the EasyEcom SKU master or NPD Tracker master to add or update its standard cost.</p>
    <div className="scw-table-filters">
      <label className="field wf-field"><span>Search product</span><input type="search" value={query} placeholder="Product code, name or SKU" onChange={e => {setQuery(e.target.value);setPage(0);}} /></label>
      <label className="field wf-field"><span>Status</span><select value={status} onChange={e => {setStatus(e.target.value);setPage(0);}}><option value="all">All statuses</option><option value="summary_not_added">Cost Not Added</option><option value="summary_pending">Approval Pending</option><option value="signed_off">Approved</option><option value="summary_partial">Partially Approved</option><option value="summary_resubmit">Re-Submit</option>{FINISHED_GOODS_COST_STATUSES.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <div className="scw-table-actions">
        <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm scw-export-csv" disabled={!filtered.length} onClick={exportCsv}><Download size={15} strokeWidth={1.75} aria-hidden="true" />Export CSV</button>
        <div className="segment scw-view-switch" role="group" aria-label="Cost sheet view">
          <button type="button" className={view === 'kanban' ? 'active' : ''} aria-pressed={view === 'kanban'} onClick={() => setView('kanban')}>Kanban</button>
          <button type="button" className={view === 'list' ? 'active' : ''} aria-pressed={view === 'list'} onClick={() => setView('list')}>List</button>
        </div>
      </div>
    </div>
    {warning && <p role="status">NPD Tracker products are unavailable: {warning}</p>}
    {error && <p role="alert" className="scw-error">{error}</p>}
    {view === 'kanban' ? <div className="scw-kanban" aria-label="Costs by status">
      {FINISHED_GOODS_COST_STATUSES.filter(column => status === 'all' || column === status).map(column => {
        const items = filtered.filter(row => row.status === column);
        return <section className="scw-kanban-column" key={column} aria-label={`${column} costs`}>
          <header><span className="wf-status scw-status" data-status={column}>{column}</span><span className="scw-kanban-count">{items.length}</span></header>
          <div className="scw-kanban-items">{items.map(({product,cost,updated,rate,updatedAt}) => <article className="scw-kanban-card" key={product.code}>
            <strong className="mono">{product.code}</strong>
            <h3>{product.name || 'Product name unavailable'}</h3>
            <small>{product.source}</small>
            <dl><div><dt>Job</dt><dd>{money(rate?.job_cost)}</dd></div><div><dt>FOB</dt><dd>{money(rate?.fob_cost)}</dd></div><div><dt>E-FOB</dt><dd>{money(rate?.efob_cost)}</dd></div></dl>
            <p className="scw-kanban-date">Standard Cost updated: {dateDisplay(updatedAt)}</p>
            {canEdit ? <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={busy} onClick={() => open(product.code)}>{updated ? 'Amend/Update Standard Cost' : 'Add Standard Cost'}</button> : cost ? <a href={`/standard-cost/${encodeURIComponent(product.code)}`}>View Standard Cost</a> : <span className="wf-subtle">Not added</span>}
          </article>)}{!items.length && <p className="wf-subtle scw-kanban-empty">No matching products.</p>}</div>
        </section>;
      })}
    </div> : <div className="table-scroll"><table className="wf-grid scw-product-table"><thead><tr><th>Product code</th><th>Product name</th><th>Master</th><th>Status</th><th>Job</th><th>FOB</th><th>E-FOB</th><th>Standard Cost updated date</th><th>Standard cost</th></tr></thead>
      <tbody>{filtered.slice(page*25,(page+1)*25).map(({product,cost,updated,rate,status:rowStatus,updatedAt}) =>
        <tr key={product.code}><td className="mono">{product.code}</td><td>{product.name || '—'}</td><td>{product.source}</td><td><span className="wf-status scw-status" data-status={rowStatus}>{rowStatus}</span></td><td>{money(rate?.job_cost)}</td><td>{money(rate?.fob_cost)}</td><td>{money(rate?.efob_cost)}</td><td>{dateDisplay(updatedAt)}</td><td>{canEdit ? <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={busy} onClick={() => open(product.code)}>{updated ? 'Amend/Update Standard Cost' : 'Add Standard Cost'}</button> : cost ? <a href={`/standard-cost/${encodeURIComponent(product.code)}`}>View Standard Cost</a> : 'Not added'}</td></tr>
      )}{!filtered.length && <tr><td colSpan={9}>No matching products in the connected masters.</td></tr>}</tbody>
    </table></div>}
    <div className="scw-actions"><span>{filtered.length} products</span>{view === 'list' && filtered.length>25 && <><button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={page===0} onClick={() => setPage(p=>p-1)}>Previous</button><span>Page {page+1} of {Math.ceil(filtered.length/25)}</span><button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={(page+1)*25>=filtered.length} onClick={() => setPage(p=>p+1)}>Next</button></>}{busy && <span role="status">Opening cost editor…</span>}</div>
  </section>;
}
