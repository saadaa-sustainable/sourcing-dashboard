'use client';

import { Fragment, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { toastError } from '@/lib/toast';
import { ClipboardPaste, Grid3x3, Plus, Save, Trash2, Upload, Wand2 } from 'lucide-react';
import { Combobox } from '@/components/forms/combobox';
import { Notice } from '@/components/forms/form-layout';
import { InfoDot } from '@/components/info-dot';
import { HeaderInfo } from '@/components/header-info';
import { getPoLineContext, getPoPlanSuggestion, savePoLines } from '@/lib/forms/actions';
import {
  checkLines,
  skuOf,
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
  inlineEdit = false,
  onSaved,
  onClose,
}: {
  poId: number;
  poRef: string | null;
  productCode: string | null;
  lines: PoApprovalLine[];
  editable: boolean;
  inlineEdit?: boolean;
  onSaved: () => void;
  onClose: () => void;
}) {
  // The fill-in table is the default way in: the master's colours and sizes, ready to type.
  const [mode, setMode] = useState<Mode>(editable ? 'matrix' : 'paste');
  const [ctx, setCtx] = useState<PoLineContext | null>(null);
  const [text, setText] = useState('');
  const [matrixRows, setMatrixRows] = useState<string[]>(() => {
    const variants = [...new Set(lines.filter((line) => Number(line.qty) > 0).map((line) => (line.product_variant ?? '').toUpperCase()).filter(Boolean))];
    return variants.length ? variants : [''];
  });
  const [grid, setGrid] = useState<Record<string, Record<string, string>>>(() => {
    const g: Record<string, Record<string, string>> = {};
    for (const l of lines) {
      const v = (l.product_variant ?? '').toUpperCase();
      if (!v) continue;
      g[v] ??= {};
      g[v][(l.size ?? '').toUpperCase()] = String(Number(l.qty) || '');
    }
    return g;
  });
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
    const variants = [...new Set(draft.map((line) => line.product_variant))];
    setMatrixRows(variants.length ? variants : ['']);
    setMode('matrix');
  }

  const matrix = useMemo(
    () => toMatrix(draft, ctx?.variants ?? [], ctx?.sizes ?? []),
    [draft, ctx],
  );
  const { totalQty, totalPending, over } = useMemo(
    () => checkLines(draft, ctx?.pending ?? [], ctx?.variants ?? []),
    [draft, ctx],
  );

  const reviewMatrix = useMemo(() => {
    const sizes = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'];
    const groups = new Map<string, { variant: string; quantities: Record<string, number>; total: number }>();
    for (const line of (editable ? draft : lines)) {
      const qty = Number(line.qty);
      const variant = (line.product_variant ?? '').trim().toUpperCase();
      const size = (line.size ?? '').trim().toUpperCase();
      if (!variant || (!inlineEdit || !editable) && !(qty > 0)) continue;
      if (!sizes.includes(size)) sizes.push(size);
      const group = groups.get(variant) ?? { variant, quantities: {}, total: 0 };
      group.quantities[size] = (group.quantities[size] ?? 0) + qty;
      group.total += qty;
      groups.set(variant, group);
    }
    const pending = new Map((ctx?.pending ?? []).map((row) => [row.sku.toUpperCase(), row.pendingQty]));
    return { sizes, groups: [...groups.values()], pending };
  }, [lines, ctx, inlineEdit, editable, draft]);

  function readText(raw: string) {
    const r = parsePastedLines(raw, ctx?.colours ?? {});
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
          setMatrixRows([...new Set(s.lines.map((line) => line.product_variant))]);
          setIssues([]);
          setGrid(Object.fromEntries([...new Set(s.lines.map((line) => line.product_variant))].map((variant) => [variant, Object.fromEntries(s.lines.filter((line) => line.product_variant === variant).map((line) => [line.size, String(line.qty)]))])));
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
      </div>

      {editable && !inlineEdit && (
        <div className="role-tabs pl-tabs" role="tablist" aria-label="How to enter quantities">
          <button role="tab" aria-selected={mode === 'matrix'} className={mode === 'matrix' ? 'active' : ''} onClick={openMatrix}>
            <Grid3x3 size={13} /> Fill the table
          </button>
          <button role="tab" aria-selected={mode === 'paste'} className={mode === 'paste' ? 'active' : ''} onClick={() => setMode('paste')}>
            <ClipboardPaste size={13} /> Paste from Excel
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

      {editable && !inlineEdit && mode === 'paste' && (
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
            is fine), or <strong>sizes across the top</strong> with one colour per row — including the team&rsquo;s
            PO sheet as it is (VENDOR CODE · PRODUCT CODE · DYED FABRIC SKU · COLOR, then the sizes; the
            consumption row above, the Total / Fabric Req. columns and the totals row are ignored). Tabs,
            commas and spaces all separate; blank cells mean none of that size.
          </p>
        </div>
      )}

      {editable && !inlineEdit && mode === 'csv' && (
        <div className="pl-csv">
          <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,text/csv" onChange={(e) => onFile(e.target.files?.[0])} />
          <p className="wf-subtle pl-hint">
            Same two shapes as paste. The file is read in your browser — nothing is uploaded until you save.
          </p>
        </div>
      )}

      {/* A product added from NPD Tracker V7: its colours come from the NPD SKU-code cell. */}
      {ctx?.npd && (
        <p className="pl-npd-note">
          <b>Colours from NPD Tracker V7.</b> This product is not in EasyEcom yet, so its colour codes are read from its
          NPD SKU code <span className="mono">{ctx.npd.skuText || '(blank)'}</span>
          {ctx.npd.sizesFromNpd ? ' and its sizes from NPD' : ''}. Check them before saving
          {ctx.npd.unread.length > 0 && (
            <> — could not read <span className="mono">{ctx.npd.unread.join(', ')}</span> as a code</>
          )}
          . A code that is wrong can be fixed on NPD Tracker V7, or paste your own colours and quantities.
        </p>
      )}

      {editable && !inlineEdit && mode === 'matrix' && (
        <div className="table-scroll pl-matrix">
          {!ctx ? (
            <p className="wf-subtle">Loading this product’s colours…</p>
          ) : (
            <table className="wide-table wf-grid pl-fill">
              <colgroup>
                <col style={{width: '16%'}} />
                <col style={{width: '13%'}} />
                <col style={{width: '11%'}} />
                {matrix.sizes.map((size) => <col key={size} style={{width: `${49 / Math.max(matrix.sizes.length, 1)}%`}} />)}
                <col style={{width: '7%'}} /><col style={{width: '4%'}} />
              </colgroup>
              <thead>
                <tr>
                  <th>Variant code <HeaderInfo label="Product SKU" text="The colour variant code; with the size it makes the SKU (e.g. SDCPBL + _S)." /></th>
                  <th>Dyed fabric SKU <HeaderInfo label="Dyed fabric SKU" text="The dyed fabric this colour is cut from, as the product master holds it." /></th>
                  <th>Colour</th>
                  {matrix.sizes.map((s) => (
                    <th key={s} className="num">{s}</th>
                  ))}
                  <th className="num">Total</th><th aria-label="Row actions" />
                </tr>
              </thead>
              <tbody>
                {matrixRows.map((v, rowIndex) => {
                  const info = ctx.variantInfo?.[v];
                  const rowTotal = matrix.sizes.reduce((sum, s) => sum + (Number(grid[v]?.[s]) || 0), 0);
                  return (
                    <tr key={rowIndex} className={rowTotal ? 'is-filled' : undefined}>
                      <td className="pl-variant-picker">
                        <Combobox ariaLabel={`Variant code row ${rowIndex + 1}`} value={v} allowFreeText={false} disabled={pending}
                          placeholder="Choose variant code"
                          options={ctx.variants.filter((variant) => variant === v || !matrixRows.includes(variant)).map((variant) => ({value: variant, label: variant, detail: ctx.variantInfo[variant]?.colour ?? undefined}))}
                          onChange={(variant) => {
                            if (variant && matrixRows.some((row, index) => index !== rowIndex && row === variant)) return;
                            setMatrixRows((rows) => rows.map((row, index) => index === rowIndex ? variant : row));
                            const next = {...grid};
                            if (v) delete next[v];
                            if (variant) next[variant] = {};
                            applyMatrix(next);
                          }} />
                      </td>
                      <td className="mono">{info?.dyedFabricSku ?? <span className="wf-subtle">—</span>}</td>
                      <td>{info?.colour ?? <span className="wf-subtle">—</span>}</td>
                      {matrix.sizes.map((s) => {
                        // A size the master has no SKU for is greyed, but can still be typed into.
                        const known = !info?.sizes.length || info.sizes.includes(s);
                        return (
                          <td key={s} className={`num input-col${known ? '' : ' pl-nosku'}`}>
                            <input
                              type="number"
                              disabled={!v || pending}
                              step={1}
                              min={0}
                              aria-label={`${v} ${s}`}
                              title={known ? `${v}_${s}` : `${v}_${s} is not in the product master`}
                              placeholder={known ? '' : '—'}
                              value={grid[v]?.[s] ?? ''}
                              onChange={(e) => applyMatrix({ ...grid, [v]: { ...(grid[v] ?? {}), [s]: e.target.value } })}
                            />
                          </td>
                        );
                      })}
                      <td className="num">{rowTotal ? fmt.format(rowTotal) : '—'}</td>
                      <td><button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={pending} aria-label={`Remove variant row ${rowIndex + 1}`}
                        onClick={() => {
                          setMatrixRows((rows) => rows.filter((_, index) => index !== rowIndex));
                          const next = {...grid}; if (v) delete next[v]; applyMatrix(next);
                        }}><Trash2 size={14} /></button></td>
                    </tr>
                  );
                })}
                {matrixRows.length > 0 && (
                  <tr className="pl-fill-total">
                    <td colSpan={3}>Total</td>
                    {matrix.sizes.map((s) => {
                      const t = matrixRows.filter(Boolean).reduce((sum, v) => sum + (Number(grid[v]?.[s]) || 0), 0);
                      return <td key={s} className="num">{t ? fmt.format(t) : '—'}</td>;
                    })}
                    <td className="num">{fmt.format(totalQty)}</td><td />
                  </tr>
                )}
                {!matrixRows.length && (
                  <tr>
                    <td colSpan={matrix.sizes.length + 5} className="wf-empty-cell">
                      {ctx.variants.length ? 'Click Add variant row to choose a variant and enter size quantities.' : ctx.npd
                        ? `No colour code could be read from the NPD SKU code of ${productCode ?? 'this product'} — use Paste instead, or fix the SKU code on NPD Tracker V7.`
                        : `No colours on record for ${productCode ?? 'this product'} in the product master — use Paste instead.`}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
          {ctx && <div className="pl-add-row">
            <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={pending || matrixRows.includes('') || matrixRows.filter(Boolean).length >= ctx.variants.length}
              onClick={() => setMatrixRows((rows) => [...rows, ''])}><Plus size={14} /> Add variant row</button>
          </div>}
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
          <table className="wide-table wf-grid pl-review-matrix" aria-label="SKU quantities by colour and size">
            <thead><tr>
              <th scope="col">Colour</th><th scope="col">Variant Code</th><th scope="col">Quantity</th>
              {reviewMatrix.sizes.map((size) => <th scope="col" className="num" key={size}>{size || 'Unspecified'}</th>)}
              <th scope="col" className="num">Total PO Qty</th>
            </tr></thead>
            <tbody>
              {reviewMatrix.groups.map((group) => (
                <Fragment key={group.variant}>
                  <tr>
                    <th rowSpan={2} scope="rowgroup">{ctx?.variantInfo[group.variant]?.colour || group.variant}</th>
                    <td rowSpan={2} className="mono">{group.variant}</td>
                    <th scope="row">PO Qty</th>
                    {reviewMatrix.sizes.map((size) => <td key={size} className="num">
                      {inlineEdit && editable ? <input type="number" min="0" step="1" disabled={pending}
                        aria-label={`PO quantity ${group.variant} ${size || 'unspecified'}`}
                        value={group.quantities[size] || ''}
                        onChange={(event) => {
                          const qty = Math.max(0, Math.floor(Number(event.target.value) || 0));
                          setDraft((rows) => [...rows.filter((row) => row.product_variant !== group.variant || row.size !== size),
                            {product_variant: group.variant, size, qty}]);
                        }} /> : group.quantities[size] ? fmt.format(group.quantities[size]) : '—'}
                    </td>)}
                    <td rowSpan={2} className="num"><strong>{fmt.format(group.total)}</strong></td>
                  </tr>
                  <tr>
                    <th scope="row">In-Process Qty</th>
                    {reviewMatrix.sizes.map((size) => <td key={size} className="num">{ctx ? fmt.format(reviewMatrix.pending.get(skuOf(group.variant, size)) ?? 0) : 'Loading…'}</td>)}
                  </tr>
                </Fragment>
              ))}
              {!reviewMatrix.groups.length && <tr><td colSpan={reviewMatrix.sizes.length + 4} className="wf-empty-cell">{editable ? 'Add a variant row and fill its size quantities to see the summary.' : 'No saved SKU quantities. Click Edit to add quantities.'}</td></tr>}
            </tbody>
          </table>
          <p className="wf-subtle pl-review-help">In-Process Qty shows pending quantities on open POs for the same variant and size.</p>
        </div>
      {editable && (
        <div className="wf-footer-actions">
          <button type="button" className="wf-btn wf-btn-sm pl-save-button" onClick={save} disabled={pending || !draft.length}>
            <Save size={14} /> {pending ? 'Saving…' : `Save ${fmt.format(draft.length)} SKU${draft.length === 1 ? '' : 's'} · ${fmt.format(totalQty)} pcs`}
          </button>
          {!inlineEdit && <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => { setDraft([]); setText(''); setGrid({}); setMatrixRows(['']); setIssues([]); }} disabled={pending}>
            Clear
          </button>}
          {inlineEdit && <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={onClose} disabled={pending}>
            Cancel
          </button>}
        </div>
      )}
    </div>
  );
}
