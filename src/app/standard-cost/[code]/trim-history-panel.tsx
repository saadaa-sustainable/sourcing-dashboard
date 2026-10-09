'use client';

import { useState } from 'react';
import { Notice } from '@/components/forms/form-layout';
import type { TrimChange } from '@/lib/forms/queries-modules/trim-history';

/** Spread of one trim's value across every costed product (from the CMTP lines on file). */
export type TrimSpread = { min: number; max: number; median: number; products: number };

const num = (v: number | null) => (v == null ? '—' : String(Math.round(v * 100) / 100));
const when = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const itemName = (c: { trim_head: string; item: string | null }) => c.item || c.trim_head;
const itemKey = (c: { trim_head: string; item: string | null }) => `${c.trim_head} :: ${c.item ?? ''}`;

const KIND_TEXT: Record<TrimChange['change_kind'], string> = {
  added: 'Added',
  changed: 'Changed',
  removed: 'Removed',
  on_file: 'On file',
};

function delta(c: TrimChange): string {
  if (c.change_kind !== 'changed' || c.old_amount == null || c.new_amount == null) return '';
  const d = c.new_amount - c.old_amount;
  const pct = c.old_amount ? ` (${d > 0 ? '+' : ''}${Math.round((d / c.old_amount) * 100)}%)` : '';
  return `${d > 0 ? '+' : ''}${num(d)}${pct}`;
}

/**
 * Standard Cost → Trim History (2026-10-09). Every change to a trim value of this product —
 * Product Trims and Brand Trims — kept apart from Rate History. Trims vary the most between
 * products (fusing, buttons …) and drive most cost gaps, so each trim is also shown against
 * the spread of the same trim across all costed products.
 */
export function TrimHistoryPanel({
  ready,
  changes,
  spread,
}: {
  ready: boolean;
  changes: TrimChange[];
  spread: Record<string, TrimSpread>;
}) {
  const heads = Array.from(new Set(changes.map((c) => c.trim_head))).sort();
  const [head, setHead] = useState<string>('all');
  const shown = head === 'all' ? changes : changes.filter((c) => c.trim_head === head);

  // One row per trim: latest value (changes are newest first), every value it has held, count.
  const items = new Map<string, { head: string; name: string; now: number | null; removed: boolean; values: number[]; edits: number; last: string }>();
  for (const c of shown) {
    const k = itemKey(c);
    let it = items.get(k);
    if (!it) {
      it = { head: c.trim_head, name: itemName(c), now: c.new_amount, removed: c.change_kind === 'removed', values: [], edits: 0, last: c.changed_at };
      items.set(k, it);
    }
    for (const v of [c.old_amount, c.new_amount]) if (v != null) it.values.push(v);
    if (c.change_kind !== 'on_file') it.edits += 1;
  }
  const rows = Array.from(items.values()).sort((a, b) => a.head.localeCompare(b.head) || a.name.localeCompare(b.name));

  if (!ready) {
    return (
      <div className="wf-history-view">
        <Notice tone="warn">
          Trim History needs the database update <code>20261009160000_trim_history.sql</code> — run it in the Supabase SQL editor, then reload.
        </Notice>
      </div>
    );
  }

  return (
    <div className="wf-history-view">
      <p className="wf-subtle">
        Every change to a trim value — Product Trims and Brand Trims — newest first, kept apart from Rate History. Trims vary
        the most from product to product and drive most cost gaps, so each one is shown against the same trim on every costed
        product.
      </p>

      {heads.length > 1 && (
        <div className="segment wf-segment th-filter">
          <button type="button" className={head === 'all' ? 'active' : ''} onClick={() => setHead('all')}>All trims</button>
          {heads.map((h) => (
            <button key={h} type="button" className={head === h ? 'active' : ''} onClick={() => setHead(h)}>{h}</button>
          ))}
        </div>
      )}

      <p className="wf-subtle th-section"><strong>Trims now</strong></p>
      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wf-grid">
            <thead>
              <tr>
                <th>Trim</th>
                <th>Head</th>
                <th className="num">Now</th>
                <th className="num">Lowest – highest here</th>
                <th className="num">Changes</th>
                <th className="num">All products: lowest – highest</th>
                <th className="num">All products: median</th>
                <th>Last changed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const s = spread[`${r.head} :: ${r.name === r.head ? '' : r.name}`];
                const lo = Math.min(...r.values);
                const hi = Math.max(...r.values);
                return (
                  <tr key={`${r.head}-${r.name}`}>
                    <td>{r.name}</td>
                    <td className="wf-subtle">{r.head}</td>
                    <td className="num">{r.removed ? <span className="wf-subtle">Removed</span> : num(r.now)}</td>
                    <td className="num">{r.values.length ? (lo === hi ? num(lo) : `${num(lo)} – ${num(hi)}`) : '—'}</td>
                    <td className="num">{r.edits || '—'}</td>
                    <td className="num" title={s ? `${s.products} products carry this trim` : undefined}>
                      {s ? (s.min === s.max ? num(s.min) : `${num(s.min)} – ${num(s.max)}`) : '—'}
                    </td>
                    <td className="num">{s ? num(s.median) : '—'}</td>
                    <td className="wf-subtle">{when(r.last)}</td>
                  </tr>
                );
              })}
              {!rows.length && (
                <tr><td colSpan={8} className="wf-empty-cell">No trims on this product yet — add them under CMTP → Product Trims / Brand Trims.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="wf-subtle th-section"><strong>All changes</strong></p>
      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wf-grid">
            <thead>
              <tr>
                <th>When</th>
                <th>Trim</th>
                <th>What</th>
                <th className="num">Old</th>
                <th className="num">New</th>
                <th className="num">Change</th>
                <th>By</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => (
                <tr key={c.id}>
                  <td>{when(c.changed_at)}</td>
                  <td>
                    {itemName(c)} <span className="wf-subtle">· {c.trim_head}</span>
                  </td>
                  <td className="wf-subtle">{KIND_TEXT[c.change_kind]}</td>
                  <td className="num">{num(c.old_amount)}</td>
                  <td className="num">{num(c.new_amount)}</td>
                  <td className="num">{delta(c) || '—'}</td>
                  <td className="wf-subtle">{c.changed_by ?? '—'}</td>
                  <td className="wf-subtle">{c.reason ?? '—'}</td>
                </tr>
              ))}
              {!shown.length && (
                <tr><td colSpan={8} className="wf-empty-cell">No trim changes recorded yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
