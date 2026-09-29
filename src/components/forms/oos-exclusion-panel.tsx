'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Ban, Plus, X } from 'lucide-react';
import { FilterTable, type Column } from '@/components/filter-table';
import { InfoDot } from '@/components/info-dot';
import { Notice } from '@/components/forms/form-layout';
import { addOosExclusion, addOosExclusions, removeOosExclusion, searchOosSkus, type OosSkuSuggestion } from '@/lib/forms/actions';
import { emitToast } from '@/lib/toast';
import type { OosSkuExclusion } from '@/lib/forms/types';

const HELP =
  "WHAT: SKUs deliberately left out of every table on the OOS Dashboard and DOQ Calculation.\n\nHOW: one shared list — test SKUs, samples, anything that should not count as a stock-out. Type a SKU or product name, tick the SKUs you want (Select all shown ticks every match), search again to add more, then Exclude N selected. The reason is optional and applies to the whole batch.\n\nUSE: if a number looks too good, check nothing real is on this list.";

/**
 * The shared OOS exclusion list. Suggestions come from the product master as you type,
 * the list is a proper table, and adding or restoring a SKU refreshes the page's numbers
 * in place — no full reload, so the tab you were on stays where it was.
 */
export function OosExclusionPanel({
  exclusions,
  editable,
  collapsible = false,
}: {
  exclusions: OosSkuExclusion[];
  editable: boolean;
  /** OOS Dashboard: fold the panel away under its heading. DOQ Calculation shows it open. */
  collapsible?: boolean;
}) {
  const router = useRouter();
  // Optimistic edits on top of the server's list. When the server list changes (the
  // refresh after a save, or another user's change) the edits are dropped during render —
  // the server copy already contains them.
  const [added, setAdded] = useState<OosSkuExclusion[]>([]);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [seen, setSeen] = useState(exclusions);
  if (seen !== exclusions) {
    setSeen(exclusions);
    setAdded([]);
    setRemoved(new Set());
  }
  const list = [
    ...added,
    ...exclusions.filter((e) => !removed.has(e.sku) && !added.some((a) => a.sku === e.sku)),
  ];
  const [sku, setSku] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const [hints, setHints] = useState<OosSkuSuggestion[]>([]);
  // The SKUs ticked so far — kept across searches, so one batch can be gathered from
  // several products before it is excluded in one go.
  const [picked, setPicked] = useState<Map<string, OosSkuSuggestion>>(new Map());
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const query = sku.trim();

  // Suggestions, debounced, from the product master. Nothing is set synchronously here;
  // the timeout does the work, and the list is only shown once the query is long enough.
  useEffect(() => {
    if (query.length < 2) return;
    let alive = true;
    const t = setTimeout(() => {
      setSearching(true);
      searchOosSkus(query)
        .then((r) => { if (alive) { setHints(r); setOpen(true); } })
        .finally(() => { if (alive) setSearching(false); });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [query]);

  // Click outside closes the suggestion list.
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const excludedSet = new Set(list.map((e) => e.sku.toUpperCase()));
  const nameOf = (h: OosSkuSuggestion) => [h.product_name, h.colour, h.size].filter(Boolean).join(' · ');

  function togglePick(h: OosSkuSuggestion) {
    setPicked((m) => {
      const n = new Map(m);
      if (n.has(h.sku)) n.delete(h.sku);
      else n.set(h.sku, h);
      return n;
    });
  }
  const selectable = hints.filter((h) => !excludedSet.has(h.sku));
  const allShownPicked = selectable.length > 0 && selectable.every((h) => picked.has(h.sku));
  function toggleAllShown() {
    setPicked((m) => {
      const n = new Map(m);
      if (allShownPicked) for (const h of selectable) n.delete(h.sku);
      else for (const h of selectable) n.set(h.sku, h);
      return n;
    });
  }

  /** Exclude every ticked SKU in one call. */
  function addPicked() {
    const items = [...picked.values()];
    if (!items.length) return;
    setErr(null);
    setOpen(false);
    const fd = new FormData();
    fd.set('skus', items.map((h) => h.sku).join(','));
    fd.set('reason', reason.trim());
    start(async () => {
      const r = await addOosExclusions(fd);
      if (!r.ok) { setErr(r.error); return; }
      const now = new Date().toISOString();
      setAdded((l) => [
        ...items.map((h) => ({ sku: h.sku, reason: reason.trim() || null, added_by: null, added_at: now, product_name: nameOf(h) || null })),
        ...l.filter((e) => !picked.has(e.sku)),
      ]);
      setRemoved((r) => { const n = new Set(r); for (const h of items) n.delete(h.sku); return n; });
      setPicked(new Map());
      setSku('');
      setReason('');
      setHints([]);
      emitToast(r.message ?? `${items.length} SKUs excluded.`);
      router.refresh();
    });
  }

  function add(code = sku) {
    const s = code.trim().toUpperCase();
    if (!s) return;
    setErr(null);
    setOpen(false);
    const fd = new FormData();
    fd.set('sku', s);
    fd.set('reason', reason.trim());
    const hint = hints.find((h) => h.sku === s);
    start(async () => {
      const r = await addOosExclusion(fd);
      if (!r.ok) { setErr(r.error); return; }
      // Show it at once; the server copy arrives with the refresh.
      setAdded((l) => [
        { sku: s, reason: reason.trim() || null, added_by: null, added_at: new Date().toISOString(), product_name: hint ? nameOf(hint) || null : null },
        ...l.filter((e) => e.sku !== s),
      ]);
      setRemoved((r) => { const n = new Set(r); n.delete(s); return n; });
      setSku('');
      setReason('');
      setHints([]);
      emitToast(r.message ?? `${s} excluded.`);
      router.refresh();
    });
  }

  function remove(code: string) {
    setErr(null);
    const fd = new FormData();
    fd.set('sku', code);
    start(async () => {
      const r = await removeOosExclusion(fd);
      if (!r.ok) { setErr(r.error); return; }
      setAdded((l) => l.filter((e) => e.sku !== code));
      setRemoved((r) => new Set(r).add(code));
      emitToast(r.message ?? `${code} restored.`);
      router.refresh();
    });
  }

  const cols: Column<OosSkuExclusion>[] = [
    { key: 'sku', label: 'SKU', kind: 'mono', source: 'supabase', info: 'The SKU (product code + colour + size) left out of every OOS table.' },
    { key: 'product_name', label: 'Product', kind: 'text', source: 'easyecom', accessor: (r) => r.product_name ?? '', render: (r) => r.product_name ?? <span className="wf-subtle">not in the product master</span>,
      info: 'Product name, colour and size from the product master — blank when the SKU is not on it (check the code).' },
    { key: 'reason', label: 'Reason', kind: 'text', source: 'supabase', accessor: (r) => r.reason ?? '', render: (r) => r.reason ?? '—', info: 'Why it was excluded, as typed.' },
    { key: 'added_by', label: 'Excluded by', kind: 'text', source: 'supabase', accessor: (r) => r.added_by ?? '', render: (r) => r.added_by ?? '—', info: 'Who added it to the list.' },
    { key: 'added_at', label: 'On', kind: 'text', source: 'supabase', accessor: (r) => String(r.added_at).slice(0, 10), info: 'When it was added.' },
  ];
  if (editable) {
    cols.push({
      key: '_restore', label: '', filter: 'none', sortable: false, accessor: () => '',
      render: (r) => (
        <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={busy} onClick={() => remove(r.sku)} title="Bring this SKU back into every OOS table">
          Restore
        </button>
      ),
    });
  }

  const body = (
    <div className="oos-excl">
      {err && <Notice tone="error">{err}</Notice>}
      {editable && (
        <div className="oos-excl-add" ref={boxRef}>
          <div className="oos-excl-search">
            <input
              className="wf-search"
              placeholder="Type a SKU or product name… (e.g. SDRPTBR_L or Linen Kurta)"
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              onFocus={() => hints.length && setOpen(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  // Ticked SKUs win; else a single match; else the code as typed.
                  if (picked.size) addPicked();
                  else add(hints.length === 1 ? hints[0].sku : sku);
                }
                if (e.key === 'Escape') setOpen(false);
              }}
              aria-label="SKU to exclude"
              aria-autocomplete="list"
              aria-expanded={open}
            />
            {open && query.length >= 2 && (hints.length > 0 || !searching) && (
              <ul className="oos-excl-hints" role="listbox" aria-multiselectable="true">
                {selectable.length > 1 && (
                  <li className="oos-excl-hint-head">
                    <label>
                      <input type="checkbox" checked={allShownPicked} onChange={toggleAllShown} disabled={busy} />
                      <span>Select all shown ({selectable.length})</span>
                    </label>
                    <span className="wf-subtle">{hints.length === 60 ? 'first 60 matches — type more to narrow' : `${hints.length} match${hints.length === 1 ? '' : 'es'}`}</span>
                  </li>
                )}
                {hints.map((h) => {
                  const already = excludedSet.has(h.sku);
                  const on = picked.has(h.sku);
                  return (
                    <li key={h.sku} role="option" aria-selected={on} className={already ? 'is-excluded' : on ? 'is-picked' : ''}>
                      <label>
                        <input type="checkbox" checked={on} disabled={already || busy} onChange={() => togglePick(h)} />
                        <span className="oos-excl-hint-text">
                          <span className="mono">{h.sku}</span>
                          <span className="wf-subtle">
                            {nameOf(h)}
                            {h.product_state ? ` · ${h.product_state}` : ''}
                            {already ? ' · already excluded' : ''}
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
                {!hints.length && <li className="wf-subtle oos-excl-none">No SKU in the product master matches “{query}”.</li>}
              </ul>
            )}
          </div>
          <input
            className="wf-search"
            placeholder="Reason (optional) — e.g. test SKU, sample"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
            aria-label="Reason"
          />
          {picked.size ? (
            <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={busy} onClick={addPicked}>
              <Plus size={13} /> {busy ? 'Saving…' : `Exclude ${picked.size} selected`}
            </button>
          ) : (
            <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={busy || !sku.trim()} onClick={() => add()} title="Exclude the code as typed">
              <Plus size={13} /> {busy ? 'Saving…' : 'Exclude'}
            </button>
          )}
          {picked.size > 0 && (
            <div className="oos-excl-picked" aria-label="SKUs selected to exclude">
              <span className="wf-subtle">Selected ({picked.size}) — search again to add more:</span>
              {[...picked.values()].map((h) => (
                <span key={h.sku} className="oos-excl-chip" title={nameOf(h)}>
                  <span className="mono">{h.sku}</span>
                  <button type="button" onClick={() => togglePick(h)} aria-label={`Unselect ${h.sku}`} disabled={busy}><X size={11} /></button>
                </span>
              ))}
              <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => setPicked(new Map())} disabled={busy}>Clear</button>
            </div>
          )}
        </div>
      )}
      <FilterTable
        rows={list}
        columns={cols}
        rowKey={(r) => r.sku}
        defaultSource="supabase"
        unit="SKUs"
        pageSize={25}
        searchPlaceholder="SKU, product, reason or person"
        emptyText="No SKUs are excluded — every SKU counts in the tables."
        download={{ filename: 'oos-excluded-skus' }}
      />
    </div>
  );

  if (!collapsible) return body;
  return (
    <details className="panel oos-excl-panel" open={editable && list.length === 0}>
      <summary>
        <Ban size={15} /> Excluded SKUs ({list.length})
        <InfoDot text={HELP} />
      </summary>
      <div style={{ marginTop: 12 }}>{body}</div>
    </details>
  );
}
