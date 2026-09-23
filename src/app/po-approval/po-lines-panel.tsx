'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { toastError } from '@/lib/toast';
import { ClipboardPaste, Grid3x3, Save, Upload, Wand2, X } from 'lucide-react';
import { Notice } from '@/components/forms/form-layout';
import { InfoDot } from '@/components/info-dot';
import { HeaderInfo } from '@/components/header-info';
import { getPoLineContext, getPoPlanSuggestion, savePoLines } from '@/lib/forms/actions';
import {
  checkLines,
  fromMatrix,
  parsePastedLines,
  toMatrix,
  type PoLineDraft,
} from '@/lib/po-lines';
import type { PoLineContext, PoPlanSuggestion } from '@/lib/forms/queries-modules/po-lines-context';
import type { PoApprovalLine } from '@/lib/forms/types';

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
type Mode = 'paste' | 'matrix' | 'csv';

const SAMPLE = `Colour\tS\tM\tL\tXL
SDFLKCB\t10\t20\t30\t10
SDFLKLI\t\t15\t15\t`;

/**
 * Spec 7.2 — SKU-level quantities, three ways in: paste from Excel (a list or a size grid),
 * a matrix you type into, or a CSV file. Whatever the route, the same rows come out and are
 * matched live against what is already pending for that SKU before anything is saved.
 */
export function PoLinesPanel({
  poId,
  poRef,
  productCode,
  lines,
  editable,
  onSaved,
  onClose,
}: {
  poId: number;
  poRef: string | null;
  productCode: string | null;
  lines: PoApprovalLine[];
  editable: boolean;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>('paste');
  const [ctx, setCtx] = useState<PoLineContext | null>(null);
  const [text, setText] = useState('');
  const [grid, setGrid] = useState<Record<string, Record<string, string>>>({});
  const [draft, setDraft] = useState<PoLineDraft[]>(
    lines.map((l) => ({
      product_variant: (l.product_variant ?? '').toUpperCase(),
      size: (l.size ?? '').toUpperCase(),
      qty: Number(l.qty) || 0,
    })).filter((l) => l.product_variant),
  );
  const [issues, setIssues] = useState<{ row: number; text: string; reason: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  // The plan suggestion (spec 7.5) and whether it is being fetched.
  const [suggestion, setSuggestion] = useState<PoPlanSuggestion | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [pending, start] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  // The colours, sizes and pending quantities for this product.
  useEffect(() => {
    if (!productCode) return;
    let alive = true;
    getPoLineContext(productCode).then((c) => {
      if (alive) setCtx(c);
    });
    return () => {
      alive = false;
    };
  }, [productCode]);

  /** Build the grid from the current draft. Done when the Matrix tab is opened rather
   *  than in an effect, so opening it cannot re-render in a loop. */
  function openMatrix() {
    const g: Record<string, Record<string, string>> = {};
    for (const l of draft) {
      g[l.product_variant] ??= {};
      g[l.product_variant][l.size] = String(l.qty);
    }
    setGrid(g);
    setMode('matrix');
  }

  const matrix = useMemo(
    () => toMatrix(draft, ctx?.variants ?? [], ctx?.sizes ?? []),
    [draft, ctx],
  );
  const { checks, totalQty, totalPending, over } = useMemo(
    () => checkLines(draft, ctx?.pending ?? [], ctx?.variants ?? []),
    [draft, ctx],
  );

  function readText(raw: string) {
    const r = parsePastedLines(raw);
    setDraft(r.rows);
    setIssues(r.issues);
    setError(
      r.rows.length
        ? null
        : r.issues.length
          ? 'Nothing could be read — check the columns below.'
          : 'Nothing to read. Paste the colours, sizes and quantities.',
    );
  }

  function onFile(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => readText(String(reader.result ?? ''));
    reader.readAsText(file);
  }

  /**
   * Spec 7.5 — fill the draft from what the buying plan still approves. It replaces what is
   * in the grid, so anything already typed is confirmed first; nothing is saved either way.
   */
  function suggest() {
    if (draft.length && !window.confirm('Replace the quantities below with the plan suggestion?')) return;
    setError(null);
    setSuggesting(true);
    void getPoPlanSuggestion(poId)
      .then((s) => {
        setSuggestion(s);
        if (s?.lines.length) {
          setDraft(s.lines);
          setIssues([]);
          setGrid({});
        }
      })
      .finally(() => setSuggesting(false));
  }

  function applyMatrix(next: Record<string, Record<string, string>>) {
    setGrid(next);
    setDraft(fromMatrix(next));
    setIssues([]);
  }

  function save() {
    setError(null);
    const p = new FormData();
    p.set('po_id', String(poId));
    p.set('lines', JSON.stringify(draft));
    start(async () => {
      const res = await savePoLines(p);
      if (res.ok) onSaved();
      else setError(toastError(res.error));
    });
  }

  return (
    <div className="wf-issue-panel pl-panel">
      <div className="pl-head">
        <strong className="wf-issue-title">
          SKU quantities — {poRef ?? `PO #${poId}`}
          <InfoDot text={"WHAT: the pieces this PO orders, per SKU (colour + size).\n\nHOW: three ways in, all landing on the same rows — Paste (copy the block straight out of Excel: either colour/size/quantity columns, or sizes across the top with a colour per row), Matrix (type into a grid of this product's colours × sizes), or a CSV file. Every row is matched against the pieces already pending for that SKU on open POs before you save.\n\nUSE: the PO quantity is the sum of these lines — it is never typed."} />
        </strong>
        <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={onClose} aria-label="Close">
          <X size={14} />
        </button>
      </div>

      {editable && (
        <div className="role-tabs pl-tabs" role="tablist" aria-label="How to enter quantities">
          <button role="tab" aria-selected={mode === 'paste'} className={mode === 'paste' ? 'active' : ''} onClick={() => setMode('paste')}>
            <ClipboardPaste size={13} /> Paste from Excel
          </button>
          <button role="tab" aria-selected={mode === 'matrix'} className={mode === 'matrix' ? 'active' : ''} onClick={openMatrix}>
            <Grid3x3 size={13} /> Matrix
          </button>
          <button role="tab" aria-selected={mode === 'csv'} className={mode === 'csv' ? 'active' : ''} onClick={() => setMode('csv')}>
            <Upload size={13} /> CSV file
          </button>
          {/* Spec 7.5 — start from the buying plan rather than a blank grid. */}
          <button
            type="button"
            className="wf-btn wf-btn-ghost wf-btn-sm pl-suggest-btn"
            onClick={suggest}
            disabled={pending || suggesting}
            title="Fill from what the buying plan still approves for this product"
          >
            <Wand2 size={13} /> {suggesting ? 'Reading the plan…' : 'Suggest from plan'}
          </button>
        </div>
      )}

      {suggestion && (
        <Notice tone={suggestion.lines.length ? 'ok' : 'warn'}>
          {suggestion.lines.length ? (
            <>
              <strong>
                Suggested {suggestion.remainingQty.toLocaleString('en-IN')} pcs from the{' '}
                {suggestion.planMonth.slice(0, 7)} buying plan
              </strong>{' '}
              — it approves {suggestion.approvedQty.toLocaleString('en-IN')} pcs of {suggestion.poTypeLabel} for this
              product
              {suggestion.issuedQty
                ? `, of which ${suggestion.issuedQty.toLocaleString('en-IN')} is already on other requests`
                : ''}
              . The plan approves a quantity for the product, not per size, so it is split{' '}
              {suggestion.basis === 'history'
                ? 'in the colour and size mix this product has been bought in before'
                : 'evenly across its colours and the core sizes, since it has no order history'}
              . <strong>Check it and change anything</strong> before you save.
            </>
          ) : (
            suggestion.note
          )}
        </Notice>
      )}

      {editable && mode === 'paste' && (
        <div className="pl-paste">
          <textarea
            className="wf-textarea pl-textarea"
            rows={6}
            value={text}
            placeholder={`Paste here — Ctrl+V straight from Excel.\n\n${SAMPLE}`}
            onChange={(e) => {
              setText(e.target.value);
              readText(e.target.value);
            }}
            onPaste={(e) => {
              const raw = e.clipboardData.getData('text');
              if (raw) {
                e.preventDefault();
                setText(raw);
                readText(raw);
              }
            }}
          />
          <p className="wf-subtle pl-hint">
            Either shape works: <strong>colour · size · quantity</strong> columns (a header row in any order
            is fine), or <strong>sizes across the top</strong> with one colour per row. Tabs, commas and
            spaces all separate; blank cells mean none of that size.
          </p>
        </div>
      )}

      {editable && mode === 'csv' && (
        <div className="pl-csv">
          <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,text/csv" onChange={(e) => onFile(e.target.files?.[0])} />
          <p className="wf-subtle pl-hint">
            Same two shapes as paste. The file is read in your browser — nothing is uploaded until you save.
          </p>
        </div>
      )}

      {editable && mode === 'matrix' && (
        <div className="table-scroll pl-matrix">
          {!ctx ? (
            <p className="wf-subtle">Loading this product’s colours…</p>
          ) : (
            <table className="wide-table wf-grid">
              <thead>
                <tr>
                  <th className="pl-matrix-corner">Colour</th>
                  {matrix.sizes.map((s) => (
                    <th key={s} className="num">{s}</th>
                  ))}
                  <th className="num">Row total</th>
                </tr>
              </thead>
              <tbody>
                {matrix.variants.map((v) => {
                  const rowTotal = matrix.sizes.reduce((sum, s) => sum + (Number(grid[v]?.[s]) || 0), 0);
                  return (
                    <tr key={v}>
                      <td className="mono pl-matrix-row">{v}</td>
                      {matrix.sizes.map((s) => (
                        <td key={s} className="num input-col">
                          <input
                            type="number"
                            min={0}
                            value={grid[v]?.[s] ?? ''}
                            onChange={(e) => applyMatrix({ ...grid, [v]: { ...(grid[v] ?? {}), [s]: e.target.value } })}
                          />
                        </td>
                      ))}
                      <td className="num">{rowTotal ? fmt.format(rowTotal) : '—'}</td>
                    </tr>
                  );
                })}
                {!matrix.variants.length && (
                  <tr>
                    <td colSpan={matrix.sizes.length + 2} className="wf-empty-cell">
                      No active colours on record for {productCode ?? 'this product'} — use Paste instead.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      )}

      {error && <Notice tone="error">{error}</Notice>}
      {issues.length > 0 && (
        <Notice tone="warn">
          <strong>{issues.length} row{issues.length === 1 ? '' : 's'} could not be read</strong> — everything else is below.
          <ul className="pl-issues">
            {issues.slice(0, 6).map((i) => (
              <li key={`${i.row}-${i.text}`}>
                Row {i.row}: {i.reason} — <span className="mono">{i.text}</span>
              </li>
            ))}
            {issues.length > 6 && <li>…and {issues.length - 6} more</li>}
          </ul>
        </Notice>
      )}

      {/* What will be saved, matched against pending at SKU level. */}
      <div className="pl-summary">
        <span>
          <strong>{fmt.format(totalQty)}</strong> pcs on this PO
        </span>
        <span className="wf-subtle">·</span>
        <span>
          {fmt.format(draft.length)} SKU{draft.length === 1 ? '' : 's'}
        </span>
        <span className="wf-subtle">·</span>
        <span>
          <strong>{fmt.format(totalPending)}</strong> pcs already pending on these SKUs
        </span>
        {over > 0 && (
          <span className="pl-over">
            {over} SKU{over === 1 ? '' : 's'} ordered above what is still outstanding
          </span>
        )}
      </div>

      <div className="table-scroll">
        <table className="wide-table wf-grid">
          <thead>
            <tr>
              <th>SKU <HeaderInfo label="SKU" /></th>
              <th>Colour <HeaderInfo label="Colour" /></th>
              <th>Size <HeaderInfo label="Size" /></th>
              <th className="num">This PO <HeaderInfo label="Qty" text="Pieces this PO orders for the SKU." /></th>
              <th className="num">
                Already pending
                <HeaderInfo label="Already pending" text={"WHAT: pieces of this exact SKU still to arrive on other open POs.\n\nHOW: summed from every open PO line for the product, matched on colour + size.\n\nUSE: ordering more than is outstanding is allowed, but it should be deliberate — the approver sees the same comparison."} />
              </th>
              <th className="num">
                Difference
                <HeaderInfo label="Difference" text="This PO minus what is already pending for the SKU. Red when this PO orders more than is still outstanding." />
              </th>
              <th>Line status <HeaderInfo label="Line status" /></th>
            </tr>
          </thead>
          <tbody>
            {checks.map((c) => {
              const was = lines.find(
                (l) => (l.product_variant ?? '').toUpperCase() === c.product_variant && (l.size ?? '').toUpperCase() === c.size,
              );
              return (
                <tr key={c.sku} className={c.unknownVariant ? 'pl-unknown' : undefined}>
                  <td className="mono">{c.sku}</td>
                  <td className="mono">
                    {c.product_variant}
                    {c.unknownVariant && <small className="wf-error-text"> not an active colour</small>}
                  </td>
                  <td>{c.size || '—'}</td>
                  <td className="num">{fmt.format(c.qty)}</td>
                  <td className="num">{c.pendingQty ? fmt.format(c.pendingQty) : '—'}</td>
                  <td className={`num${c.delta > 0 && c.pendingQty > 0 ? ' wf-error-text' : ''}`}>
                    {c.pendingQty ? `${c.delta > 0 ? '+' : ''}${fmt.format(c.delta)}` : '—'}
                  </td>
                  <td>
                    {was?.line_status === 'rework' ? (
                      <span className="wf-over-tag" title={was.rework_notes ?? ''}>rework</span>
                    ) : (
                      <span className="wf-subtle">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {!checks.length && (
              <tr>
                <td colSpan={7} className="wf-empty-cell">
                  No SKU quantities yet — paste them, type them in the matrix, or upload a CSV.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editable && (
        <div className="wf-footer-actions">
          <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" onClick={save} disabled={pending || !draft.length}>
            <Save size={14} /> {pending ? 'Saving…' : `Save ${fmt.format(draft.length)} SKU${draft.length === 1 ? '' : 's'} · ${fmt.format(totalQty)} pcs`}
          </button>
          <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => { setDraft([]); setText(''); setGrid({}); setIssues([]); }} disabled={pending}>
            Clear
          </button>
          <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={onClose} disabled={pending}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}
