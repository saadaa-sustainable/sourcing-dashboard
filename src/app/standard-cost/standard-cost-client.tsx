'use client';

import { confirmDelete } from '@/lib/confirm';
import { Fragment, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { HeaderInfo } from '@/components/header-info';
import { reloadWithToast, toastError } from '@/lib/toast';
import { Check, Download, Lock, Plus, Search, Save, Trash2, X } from 'lucide-react';
import { CostEditApprove } from '@/components/forms/cost-edit-approve';
import Link from 'next/link';
import { downloadCsv } from '@/lib/download';
import {
  acceptProposedCost,
  confirmCmRate,
  confirmFabricRate,
  proposeCost,
  addCmtpSubitem,
  rejectCost,
  renegotiateCost,
  saveCmtpComponents,
  saveCostStandards,
  saveEfobFabricCost,
  saveMaterialCost,
  saveStandardCost,
  saveStandardCostLines,
  setStandardCostHidden,
  setTargetCost,
  signOffCost,
  submitActualRate,
  mintTempProduct,
  decideCostsBulk,
  type ActionResult,
} from '@/lib/forms/actions';
import {
  CMTP_HEADS,
  CMTP_MANDATORY,
  COST_STAGE_LABEL,
  costStageText,
  COST_STAGE_TONE,
  canAcceptProposal,
  canConfirmCm,
  canConfirmFabric,
  canPropose,
  canRejectCost,
  canRenegotiate,
  canSetTarget,
  canSignOff,
  canSubmitRate,
  isAdminTurn,
  isTeamTurn,
  nextActor,
  targetSummary,
  RATE_LABELS,
  type RateKey,
} from '@/lib/forms/cost';
import { targetFields } from '@/components/forms/target-inputs';
import { canEdit } from '@/lib/forms/approval';
import { Field, Notice } from '@/components/forms/form-layout';
import { ProductPicker } from '@/components/forms/product-picker';
import type {
  CmtpComponent,
  CostStandards,
  EfobFabricCost,
  FabricUom,
  ProductCatalogItem,
  SdRole,
  StandardCost,
  StandardCostExtraFabric,
  StandardCostLine,
  StandardCostRateHistory,
} from '@/lib/forms/types';
import type { CmtpRevision } from '@/lib/standard-cost-revisions.server';
import type { TempProductInfo } from '@/lib/temp-product.server';
import { useColumnSort } from '@/lib/use-column-sort';

// Rounded to 2 decimals so summed figures never print float noise (163.98000000000002).
const disp = (v: number | null) => (v == null ? '—' : String(Math.round(v * 100) / 100));

/** Read-only fabric buildup referenced from the Fabric Cost master. */
type FabricBuildup = { grey: number | null; processing: number | null; finished: number | null };

type SheetView = 'cards' | 'kanban' | 'table';
/** Kanban columns, in the order a cost moves through them. */
const KANBAN_STAGES = ['', 'proposed', 'target_set', 'rate_submitted', 'renegotiate', 'signed_off', 'rejected'];

const rateDisplay = (v: number | null) =>
  v == null ? '—' : `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(v)}`;

/** "12 Sep 2026" — when the current cost was last accepted. */
const shortDate = (iso: string | null) =>
  !iso
    ? null
    : new Date(iso).toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'Asia/Kolkata',
      });

export function StandardCostClient({
  costs,
  standards,
  efob = [],
  catalog = [],
  rateHistory = {},
  hiddenCodes = [],
  tempProducts = {},
  materialNames = {},
  role,
  track = 'fg',
}: {
  costs: StandardCost[];
  standards?: CostStandards;
  efob?: EfobFabricCost[];
  catalog?: ProductCatalogItem[];
  rateHistory?: Record<string, StandardCostRateHistory[]>;
  /** Product codes soft-deleted from this track — re-adding one restores it intact. */
  hiddenCodes?: string[];
  /** Temporary products keyed by code (badge + merge). */
  tempProducts?: Record<string, TempProductInfo>;
  /** Material track: "fabric · colour · type" per material code, for the cards. */
  materialNames?: Record<string, string>;
  role: SdRole;
  track?: 'fg' | 'material';
  /** Final-price margin as a fraction (e.g. 0.15), from Rules Master (margin_pct). */
}) {
  const isMat = track === 'material';
  const codeLabel = isMat ? 'Material code' : 'Product code';
  // Material track relabels the three rate columns (2026-09-08): Billing (fob_cost),
  // FOB Fabric (job_cost), Standard Fabric = the EFOB fabric rate we value from (efob_cost).
  const jobLabel = isMat ? 'FOB Fabric' : 'Job';
  const fobLabel = isMat ? 'Billing' : 'FOB';
  const efobLabel = isMat ? 'Standard Fabric' : 'E-FOB';

  const editable = canEdit(role, 'draft');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [filter, setFilter] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [stageFilter, setStageFilter] = useState('all');
  // Cards carry no column headers, so the ordering the table's headers gave gets an
  // explicit control rather than quietly disappearing.
  const [cardSort, setCardSort] = useState<'code' | 'job' | 'fob' | 'efob' | 'stage' | 'updated'>('code');
  // Cards / Kanban / Table, remembered per browser (both tracks share the choice).
  const [view, setView] = useState<SheetView>('kanban');
  useEffect(() => {
    try {
      const saved = localStorage.getItem('sc-sheet-view-v2');
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read once from storage on mount
      if (saved === 'cards' || saved === 'kanban' || saved === 'table') setView(saved);
    } catch {
      /* storage blocked: keep kanban */
    }
  }, []);
  const chooseView = (v: SheetView) => {
    setView(v);
    try { localStorage.setItem('sc-sheet-view-v2', v); } catch { /* ignore */ }
  };
  const addCloseRef = useRef<HTMLButtonElement>(null);
  const [newCode, setNewCode] = useState('');
  const [tempName, setTempName] = useState('');
  // Add popup: where the product comes from, and the one picked (added only on confirm).
  const [addMode, setAddMode] = useState<'master' | 'new'>('master');
  const [pickedCode, setPickedCode] = useState<string | null>(null);
  function openAdd() {
    setAddMode('master');
    setPickedCode(null);
    setNewCode('');
    setTempName('');
    setError(null);
    setAddOpen(true);
  }

  const signedOff = costs.filter((c) => c.neg_stage === 'signed_off' || c.status === 'approved').length;
  const undocumented = costs.filter((c) => !c.documented && c.neg_stage == null).length;
  const productNames = useMemo(
    () => new Map(catalog.map((item) => [item.product_code.toUpperCase(), item.product_name ?? ''])),
    [catalog],
  );

  // Rows waiting on the signed-in user's side of the negotiation.
  // An approver opens the sheet on what is waiting for them; everyone else on everything.
  const [mineOnly, setMineOnly] = useState(() => role === 'admin' && costs.some((c) => isAdminTurn(c.neg_stage)));
  // Proposals ticked on the "Needs approval" view for a group decision.
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const togglePick = (id: number) =>
    setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const pickable = (c: StandardCost) =>
    role === 'admin' && mineOnly && c.neg_stage === 'proposed' && !c.frozen &&
    (c.job_cost != null || c.fob_cost != null || c.efob_cost != null);
  const myTurn = useMemo(
    () => (role === 'admin' ? isAdminTurn : isTeamTurn),
    [role],
  );
  const awaitingCount = useMemo(
    () => costs.filter((c) => myTurn(c.neg_stage)).length,
    [costs, myTurn],
  );

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const base = mineOnly ? costs.filter((c) => myTurn(c.neg_stage)) : costs;
    return base.filter((c) => {
      if (!isMat && stageFilter === 'not_in_easyecom') {
        // Products the product master does not know: typed codes and TMP-xxxx temporaries.
        if (productNames.has(c.product_code.toUpperCase())) return false;
      } else if (!isMat && stageFilter !== 'all' && (c.neg_stage ?? 'not_started') !== stageFilter) return false;
      return !q || c.product_code.toLowerCase().includes(q) ||
        (!isMat && (productNames.get(c.product_code.toUpperCase()) ?? '').toLowerCase().includes(q));
    });
  }, [costs, filter, mineOnly, myTurn, isMat, stageFilter, productNames]);
  const sort = useColumnSort<StandardCost>();

  useEffect(() => {
    if (!addOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    addCloseRef.current?.focus();
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAddOpen(false);
    };
    window.addEventListener('keydown', onEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onEscape);
    };
  }, [addOpen]);

  function exportFinishedGoods() {
    downloadCsv(
      'standard-cost-finished-goods',
      ['Product code', 'Product name', 'Status', 'Proposed', 'Target', 'Job', 'FOB', 'E-FOB', 'Next step'],
      (isMat ? sort.apply(shown) : sortCards(shown)).map((c) => [
        c.product_code,
        productNames.get(c.product_code.toUpperCase()) ?? '',
        costStageText(c.neg_stage, c),
        c.proposed_cost,
        targetSummary(c, isMat ? 'material' : 'fg') ?? '',
        c.job_cost,
        c.fob_cost,
        c.efob_cost,
        nextActor(c.neg_stage),
      ]),
    );
  }

  const existingCodes = useMemo(() => new Set(costs.map((c) => c.product_code)), [costs]);
  // Codes soft-deleted from this track (upper-cased) — re-adding restores them intact.
  const hiddenSet = useMemo(() => new Set(hiddenCodes.map((c) => c.toUpperCase())), [hiddenCodes]);

  function addCode(codeRaw: string) {
    const code = codeRaw.trim();
    if (!code) {
      setError(`Enter a ${codeLabel.toLowerCase()}.`);
      return;
    }
    setError(null);
    setMessage(null);
    const fd = new FormData();
    fd.set('product_code', code);
    // A previously-removed (hidden) product is RESTORED, not re-created — flip the
    // hidden flag so all its kept fields + history come back untouched. A genuinely
    // new code seeds a fresh row.
    const isRestore = hiddenSet.has(code.toUpperCase());
    start(async () => {
      let result: ActionResult;
      if (isRestore) {
        fd.set('hidden', 'false');
        fd.set('track', track);
        result = await setStandardCostHidden(fd);
      } else {
        // upsert by code — seeds a row; then open straight into its cost format.
        result = await (isMat ? saveMaterialCost : saveStandardCost)(fd);
      }
      if (result.ok) {
        // A freshly seeded row opens straight into its own cost page, which is where the
        // cost format is filled in.
        const to = `/standard-cost/${encodeURIComponent(code.toUpperCase())}`;
        window.location.href = isMat ? `${to}?track=material` : to;
      } else setError(toastError(result.error));
    });
  }

  // Create a not-yet-in-EasyEcom product with a system-minted TMP-xxxx code.
  function addTemp(typed?: string) {
    const name = (typed ?? tempName).trim();
    if (!name) return;
    setError(null);
    setMessage(null);
    const fd = new FormData();
    fd.set('name', name);
    start(async () => {
      const result = await mintTempProduct(fd);
      if (result.ok) {
        window.location.href = '/standard-cost';
      } else setError(toastError(result.error));
    });
  }


  // CMTP + Fabric Cost are documentation: editable until the cost is FROZEN (a PO was
  // issued), even after sign-off — a CMTP amount change still logs a revision reason. The
  // rate itself stays governed by the negotiation controls, not these tabs.

  /** Ordering for the Finished Goods cards. Blank rates sort last in every direction. */
  function sortCards(list: StandardCost[]): StandardCost[] {
    const num = (v: number | null) => (v == null ? null : Number(v));
    const rate = (c: StandardCost) =>
      cardSort === 'job' ? num(c.job_cost) : cardSort === 'fob' ? num(c.fob_cost) : num(c.efob_cost);
    return [...list].sort((a, b) => {
      if (cardSort === 'code') return a.product_code.localeCompare(b.product_code, undefined, { numeric: true });
      if (cardSort === 'stage') {
        return (a.neg_stage ?? '').localeCompare(b.neg_stage ?? '') ||
          a.product_code.localeCompare(b.product_code);
      }
      if (cardSort === 'updated') {
        const at = rateHistory[a.product_code]?.[0]?.accepted_at ?? a.updated_at;
        const bt = rateHistory[b.product_code]?.[0]?.accepted_at ?? b.updated_at;
        return String(bt).localeCompare(String(at));
      }
      const av = rate(a);
      const bv = rate(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return bv - av; // highest rate first
    });
  }

  /* ---- the sheet's three views (Finished Goods and Material share them) ---- */
  const nameOf = (cost: StandardCost) =>
    isMat
      ? materialNames[cost.product_code.toUpperCase()] || null
      : productNames.get(cost.product_code.toUpperCase()) || tempProducts[cost.product_code]?.name || null;
  const missingName = isMat ? 'Not in the material master' : 'Product name unavailable';
  const detailHref = (cost: StandardCost) =>
    `/standard-cost/${encodeURIComponent(cost.product_code)}${isMat ? '?track=material' : ''}`;
  // Rates in each track's own order and words (Material: Billing, FOB Fabric, Standard Fabric).
  const rateCols: { label: string; get: (c: StandardCost) => number | null }[] = isMat
    ? [
        { label: fobLabel, get: (c) => c.fob_cost },
        { label: jobLabel, get: (c) => c.job_cost },
        { label: efobLabel, get: (c) => c.efob_cost },
      ]
    : [
        { label: 'Job', get: (c) => c.job_cost },
        { label: 'FOB', get: (c) => c.fob_cost },
        { label: 'E-FOB', get: (c) => c.efob_cost },
      ];
  const updatedOf = (cost: StandardCost) => shortDate(rateHistory[cost.product_code]?.[0]?.accepted_at ?? cost.updated_at);
  const stageBadge = (cost: StandardCost) => {
    const key = cost.neg_stage ?? '';
    return <span className={`wf-status tone-${COST_STAGE_TONE[key] ?? 'purple'}`}>{costStageText(key, cost)}</span>;
  };
  const pickBox = (cost: StandardCost) =>
    pickable(cost) ? (
      <input type="checkbox" className="sc-card-pick" checked={picked.has(cost.id)} onChange={() => togglePick(cost.id)} aria-label={`Select ${cost.product_code} for a group decision`} />
    ) : null;
  const tags = (cost: StandardCost) => {
    const temp = tempProducts[cost.product_code];
    return (
      <>
        {!isMat && temp?.status === 'active' && <span className="wf-temp-badge">TEMP</span>}
        {!isMat && !productNames.has(cost.product_code.toUpperCase()) && temp?.status !== 'active' && (
          <span className="wf-temp-badge" title="Not in the product master: open Cost Details to link it to its EasyEcom product or delete it">
            Not in EasyEcom
          </span>
        )}
        {cost.frozen && <span className="sc-card-frozen"><Lock size={11} /> Frozen</span>}
        {!isMat && !cost.documented && cost.neg_stage == null && <span className="wf-gap-tag">Undocumented</span>}
      </>
    );
  };
  const emptyText = `No ${isMat ? 'material code' : 'product'}s match these filters.`;

  const viewSwitch = (
    <div className="segment sc-view-seg" role="group" aria-label="View">
      {(['kanban', 'cards', 'table'] as SheetView[]).map((v) => (
        <button key={v} type="button" className={view === v ? 'active' : ''} aria-pressed={view === v} onClick={() => chooseView(v)}>
          {v === 'cards' ? 'Cards' : v === 'kanban' ? 'Kanban' : 'Table'}
        </button>
      ))}
    </div>
  );

  function sheetViews(list: StandardCost[]) {
    if (view === 'kanban') {
      return (
        <div className="sc-kanban">
          {KANBAN_STAGES.map((key) => {
            const items = list.filter((c) => (c.neg_stage ?? '') === key);
            return (
              <section key={key || 'not_started'} className="sc-kcol" aria-label={COST_STAGE_LABEL[key]}>
                <div className="sc-kcol-head">
                  <span className={`wf-status tone-${COST_STAGE_TONE[key] ?? 'purple'}`}>{COST_STAGE_LABEL[key]}</span>
                  <span className="sc-kcol-n">{items.length}</span>
                </div>
                <small className="sc-kcol-hint">{nextActor(key || null)}</small>
                {items.map((cost) => (
                  <article className="sc-kcard" key={cost.product_code}>
                    <div className="sc-kcard-top">
                      <span className="mono sc-card-code">{pickBox(cost)}{cost.product_code}</span>
                      {cost.frozen && <Lock size={11} aria-label="Frozen" />}
                    </div>
                    <Link className="sc-kcard-name" href={detailHref(cost)}>{nameOf(cost) || <span className="wf-subtle">{missingName}</span>}</Link>
                    <div className="sc-kcard-rates">
                      {rateCols.map((r) => (
                        <span key={r.label}><small>{r.label}</small>{rateDisplay(r.get(cost))}</span>
                      ))}
                    </div>
                    <div className="sc-kcard-foot">
                      <small className="wf-subtle">{updatedOf(cost) ? `Updated ${updatedOf(cost)}` : 'No cost yet'}</small>
                      <span className="sc-card-tags">{tags(cost)}</span>
                    </div>
                  </article>
                ))}
                {!items.length && <p className="sc-kcol-empty">Nothing here.</p>}
              </section>
            );
          })}
        </div>
      );
    }
    if (view === 'table') {
      return (
        <div className="table-scroll sc-table-wrap">
          <table className="wf-grid sc-table">
            <thead>
              <tr>
                <th {...sort.th('code', (c) => c.product_code)}>{codeLabel} {sort.ind('code')}</th>
                <th {...sort.th('name', (c) => nameOf(c) ?? '')}>{isMat ? 'Material' : 'Product'} {sort.ind('name')}</th>
                <th {...sort.th('stage', (c) => costStageText(c.neg_stage, c))}>Status {sort.ind('stage')}</th>
                {rateCols.map((r) => (
                  <th key={r.label} className="num" {...sort.th(`rate-${r.label}`, (c) => (r.get(c) == null ? null : Number(r.get(c))))}>{r.label} {sort.ind(`rate-${r.label}`)}</th>
                ))}
                <th>Target</th>
                <th>Next step</th>
                <th {...sort.th('updated', (c) => rateHistory[c.product_code]?.[0]?.accepted_at ?? c.updated_at ?? '')}>Updated {sort.ind('updated')}</th>
                <th aria-label="Open" />
              </tr>
            </thead>
            <tbody>
              {sort.apply(list).map((cost) => (
                <tr key={cost.product_code}>
                  <td><span className="mono sc-card-code">{pickBox(cost)}{cost.product_code}</span></td>
                  <td className="sc-table-name">
                    <span>{nameOf(cost) || <span className="wf-subtle">{missingName}</span>}</span>
                    <span className="sc-card-tags">{tags(cost)}</span>
                  </td>
                  <td>{stageBadge(cost)}</td>
                  {rateCols.map((r) => <td key={r.label} className="num">{rateDisplay(r.get(cost))}</td>)}
                  <td className="wf-subtle">{targetSummary(cost, isMat ? 'material' : 'fg') ?? '—'}</td>
                  <td className="wf-subtle">{nextActor(cost.neg_stage)}</td>
                  <td className="wf-subtle">{updatedOf(cost) ?? '—'}</td>
                  <td><Link className="wf-btn wf-btn-ghost wf-btn-sm" href={detailHref(cost)}>Cost Details</Link></td>
                </tr>
              ))}
              {!list.length && (
                <tr><td colSpan={rateCols.length + 7} className="wf-empty-cell">{emptyText}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      );
    }
    // Cards: code, name, then the three rates side by side, the Cost Details link, and when
    // the current cost was last accepted. Rate entry and the negotiation steps live on the
    // product's own page; the sheet is for scanning.
    return (
      <div className="sc-cards">
        {list.map((cost) => {
          const updated = updatedOf(cost);
          return (
            <article className={`sc-card${picked.has(cost.id) ? ' picked' : ''}`} key={cost.product_code}>
              <div className="sc-card-head">
                <span className="mono sc-card-code">{pickBox(cost)}{cost.product_code}</span>
                {stageBadge(cost)}
              </div>
              <h3 className="sc-card-name">{nameOf(cost) || <span className="wf-subtle">{missingName}</span>}</h3>
              <div className="sc-card-rates">
                {rateCols.map((r) => (
                  <div key={r.label}><span>{r.label}</span><strong>{rateDisplay(r.get(cost))}</strong></div>
                ))}
              </div>
              <div className="sc-card-foot">
                <Link className="wf-btn wf-btn-ghost wf-btn-sm sc-card-btn" href={detailHref(cost)}>Cost Details</Link>
                <small className="wf-subtle">{updated ? `Cost updated ${updated}` : 'No cost recorded yet'}</small>
              </div>
              <div className="sc-card-tags">{tags(cost)}</div>
            </article>
          );
        })}
        {!list.length && <p className="wf-empty-cell sc-cards-empty">{emptyText}</p>}
      </div>
    );
  }

  // What the add popup will do, worked out once so the body, the hint and the main button agree.
  const matUp = newCode.trim().toUpperCase();
  const matExists = isMat && matUp !== '' && existingCodes.has(matUp);
  const addTarget = isMat ? matUp : addMode === 'master' ? pickedCode : null;
  const restoring = addTarget ? hiddenSet.has(addTarget) : false;
  const canSubmitAdd = !pending && (isMat ? matUp.length >= 2 && !matExists : addMode === 'master' ? !!pickedCode : tempName.trim().length > 0);
  const submitAdd = () => {
    if (!canSubmitAdd) return;
    if (isMat) addCode(matUp);
    else if (addMode === 'master' && pickedCode) addCode(pickedCode);
    else addTemp();
  };
  const submitLabel = pending
    ? 'Adding…'
    : restoring
      ? 'Restore and open'
      : isMat
        ? 'Add material'
        : addMode === 'new'
          ? 'Create temporary product'
          : 'Add product';

  const addForm = editable ? (
    <form
      className="sc-add"
      onSubmit={(e) => {
        e.preventDefault();
        submitAdd();
      }}
    >
      {isMat ? (
        <div className="sc-add-body">
          <label className="sc-add-field" htmlFor="sc-add-mat">
            <span>Material code</span>
            <input
              id="sc-add-mat"
              autoFocus
              value={newCode}
              placeholder="e.g. TRM07"
              autoComplete="off"
              onChange={(e) => setNewCode(e.target.value)}
            />
            <small>The code as it is in the material master. Its rates are filled in on its own page.</small>
          </label>
          {matExists && (
            <p className="sc-add-note is-warn">
              {matUp} is already on the sheet.{' '}
              <Link href={`/standard-cost/${encodeURIComponent(matUp)}?track=material`}>Open it</Link>
            </p>
          )}
        </div>
      ) : (
        <div className="sc-add-body">
          <div className="sc-add-choice" role="radiogroup" aria-label="Where the product comes from">
            <button type="button" role="radio" aria-checked={addMode === 'master'} className="sc-add-option" onClick={() => setAddMode('master')}>
              <span className="sc-add-radio" aria-hidden="true" />
              <span><b>From Product Master</b><small>A product already in EasyEcom</small></span>
            </button>
            <button type="button" role="radio" aria-checked={addMode === 'new'} className="sc-add-option" onClick={() => { setAddMode('new'); setPickedCode(null); }}>
              <span className="sc-add-radio" aria-hidden="true" />
              <span><b>New product</b><small>Not in EasyEcom yet, gets a TMP code</small></span>
            </button>
          </div>

          {addMode === 'master' ? (
            pickedCode ? (
              <div className="sc-add-picked">
                <div>
                  <span className="mono">{pickedCode}</span>
                  <b>{productNames.get(pickedCode) || 'Product name unavailable'}</b>
                </div>
                <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => setPickedCode(null)}>Change</button>
              </div>
            ) : (
              <div className="sc-add-field">
                <span>Product</span>
                <ProductPicker
                  items={catalog}
                  exclude={existingCodes}
                  onPick={(code) => setPickedCode(code)}
                  // Anything typed that is not in the product master becomes a temporary
                  // product with a TMP code, never a free-text product code.
                  onAddNew={(typed) => { setTempName(typed); setAddMode('new'); }}
                  disabled={pending}
                  placeholder="Search product code or name…"
                />
                <small>Products already on the sheet are not listed.</small>
              </div>
            )
          ) : (
            <label className="sc-add-field" htmlFor="sc-add-temp">
              <span>Product name</span>
              <input
                id="sc-add-temp"
                autoFocus
                value={tempName}
                placeholder="e.g. Linen co-ord set, sage"
                autoComplete="off"
                onChange={(e) => setTempName(e.target.value)}
              />
              <small>It gets a temporary code (TMP-…). Link it to its EasyEcom product later from its cost page.</small>
            </label>
          )}
          {restoring && (
            <p className="sc-add-note">This product was removed from the sheet earlier. Adding it brings back its cost, cost sheet and history.</p>
          )}
        </div>
      )}

      {error && <p className="sc-add-note is-error" role="alert">{error}</p>}

      <div className="sc-add-foot">
        <span className="sc-add-next">Next: the {isMat ? 'material' : 'product'}’s own page opens to fill in the cost.</span>
        <div className="sc-add-actions">
          <button type="button" className="wf-btn wf-btn-ghost" onClick={() => setAddOpen(false)} disabled={pending}>Cancel</button>
          <button type="submit" className="wf-btn wf-btn-primary" disabled={!canSubmitAdd}>
            <Plus size={14} /> {submitLabel}
          </button>
        </div>
      </div>
    </form>
  ) : null;

  return (
    <>
      <Notice tone="info">
        Cost is <strong>negotiated</strong>, not just approved: team{' '}
        <strong>proposes</strong> (fill the {jobLabel} / {fobLabel} / {efobLabel} rate that
        applies) → the approver <strong>accepts the proposal as-is</strong>, <strong>rejects</strong> it, or
        sets a <strong>target</strong> → team returns with the <strong>actual vendor rate</strong> →
        the approver <strong>approves</strong> it, and that becomes the Standard Cost the Buying Plan values
        from. {signedOff} of {costs.length} {isMat ? 'materials' : 'products'} are approved.
      </Notice>

      {message && <Notice tone="ok">{message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      {/* EFOB rate lives on the Material track — fabrics are the materials there (the
          /RM codes). Its fabric options are the material codes themselves. */}
      {isMat && (
        <EfobFabricCostPanel
          rows={efob}
          fabricCodes={costs.map((c) => c.product_code)}
          editable={editable}
        />
      )}

      {isMat ? (
        <>

      <div className="wf-toolbar">
        <input
          className="wf-search"
          placeholder="Filter code…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {/* Always-visible filter so approvers can jump straight to what needs them,
            without scrolling the whole list. */}
        <div className="segment fb-seg">
          <button type="button" className={!mineOnly ? 'active' : ''} onClick={() => setMineOnly(false)}>
            All
          </button>
          <button
            type="button"
            className={mineOnly ? 'active' : ''}
            onClick={() => setMineOnly(true)}
            title={role === 'admin' ? 'Only costs waiting on your approval' : 'Only costs waiting on your input'}
          >
            {role === 'admin' ? 'Needs approval' : 'Needs your input'} ({awaitingCount})
          </button>
        </div>
        {viewSwitch}
        <span className="wf-subtle">{shown.length} shown</span>
        {editable && (
          <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" onClick={openAdd}>
            <Plus size={14} /> Add Material to Input Standard Cost
          </button>
        )}
      </div>

      {/* Material codes get the same three views as Finished Goods. Rate entry happens on the
          code's own page. */}
      <div className="table-panel wf-grid-panel">
        {sheetViews(sortCards(shown))}
      </div>
        </>
      ) : (
        <div className="sc-fg">
          <div className="sc-fg-metrics" aria-label="Finished Goods cost overview">
            <div className="sc-fg-metric"><span>Products tracked</span><strong>{costs.length}</strong><small>Finished Goods cost records</small></div>
            <div className="sc-fg-metric"><span>Approved</span><strong>{signedOff}</strong><small>Accepted standard rates</small></div>
            <div className="sc-fg-metric"><span>Needs my action</span><strong>{awaitingCount}</strong><small>{role === 'admin' ? 'Proposals and submitted rates' : 'Targets and revisions'}</small></div>
            <div className="sc-fg-metric"><span>Not documented</span><strong>{undocumented}</strong><small>Cost sheet to complete</small></div>
          </div>

          <section className="sc-fg-sheet" aria-label="Finished Goods cost sheet">
            <div className="sc-fg-sheet-head">
              <div><h2>Finished Goods cost sheet</h2><p>Every product as cards, by status (Kanban) or as a table. Open Cost Details to see the full record and change a rate.</p></div>
              <div className="sc-fg-head-actions">
                <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={exportFinishedGoods}>
                  <Download size={14} /> Export CSV
                </button>
                {editable && <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" onClick={openAdd}><Plus size={14} /> Add Product to Input Standard Cost</button>}
              </div>
            </div>
            <div className="sc-fg-toolbar">
              <label className="sc-fg-search"><Search size={15} aria-hidden="true" /><input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search product code or name" aria-label="Search product code or name" /></label>
              <select aria-label="Filter by status" value={stageFilter} onChange={(e) => setStageFilter(e.target.value)}>
                <option value="all">All statuses</option>
                <option value="not_started">Not started</option>
                <option value="proposed">Approval Pending · Proposal</option>
                <option value="target_set">Target set · with the team</option>
                <option value="rate_submitted">Approval Pending · Vendor rate</option>
                <option value="signed_off">Approved</option>
                <option value="renegotiate">Rework / Reassign</option>
                <option value="rejected">Rejected / Discarded</option>
                <option value="not_in_easyecom">Not in EasyEcom</option>
              </select>
              <select
                aria-label="Sort products"
                value={cardSort}
                onChange={(e) => setCardSort(e.target.value as typeof cardSort)}
              >
                <option value="code">Sort: Product code</option>
                <option value="updated">Sort: Recently updated</option>
                <option value="stage">Sort: Status</option>
                <option value="job">Sort: Job rate (high first)</option>
                <option value="fob">Sort: FOB rate (high first)</option>
                <option value="efob">Sort: E-FOB rate (high first)</option>
              </select>
              <div className="segment fb-seg" aria-label="Quick filter">
                <button type="button" className={!mineOnly ? 'active' : ''} aria-pressed={!mineOnly} onClick={() => setMineOnly(false)}>All products</button>
                <button type="button" className={mineOnly ? 'active' : ''} aria-pressed={mineOnly} onClick={() => setMineOnly(true)}>{role === 'admin' ? 'Needs approval' : 'Needs your input'} ({awaitingCount})</button>
              </div>
              {viewSwitch}
            </div>
            {role === 'admin' && mineOnly && (
              <ListBulkDecide items={shown} track={isMat ? 'material' : 'fg'} picked={picked} setPicked={setPicked} pickable={pickable} />
            )}
            {sheetViews(sortCards(shown))}
            <div className="sc-fg-sheet-foot"><span>{shown.length} of {costs.length} products shown</span><span>Rates in ₹ per piece</span></div>
          </section>

          <div className="sc-fg-context">
            <div><h3>Two cost owners, one finished price</h3><p>Fabric Cost comes from the Fabric Cost master, owned by the fabric team. CMTP is built by the costing team. Final Cost combines both with the Rules Master margin.</p></div>
            <div><h3>After approval</h3><p>The accepted Job, FOB, and E-FOB rates become the live standard for the Buying Plan. A new proposal starts a revision; first PO issuance freezes the record.</p></div>
          </div>
          {standards && <StandardFieldsPanel standards={standards} editable={editable} />}

        </div>
      )}

      {/* Add popup, both tracks. */}
      {addOpen && editable && (
        <div className="sc-fg-add-layer" role="presentation" onKeyDown={(e) => { if (e.key === 'Escape') setAddOpen(false); }}>
          <button type="button" className="sc-fg-scrim" onClick={() => setAddOpen(false)} aria-label="Close" />
          <div className="sc-fg-add-dialog sc-add-dialog" role="dialog" aria-modal="true" aria-labelledby="sc-fg-add-title">
            <div className="sc-fg-card-head">
              <h2 id="sc-fg-add-title">{isMat ? 'Add Material to Input Standard Cost' : 'Add Product to Input Standard Cost'}</h2>
              <button type="button" className="sc-fg-close" ref={addCloseRef} onClick={() => setAddOpen(false)} aria-label="Close"><X size={18} /></button>
            </div>
            {addForm}
          </div>
        </div>
      )}
    </>
  );
}

/** Document-once standard fields — the same across all products. */
function StandardFieldsPanel({
  standards,
  editable,
}: {
  standards: CostStandards;
  editable: boolean;
}) {
  const [fabric, setFabric] = useState(standards.fabric_cost?.toString() ?? '');
  const [dyeing, setDyeing] = useState(standards.dyeing_cost?.toString() ?? '');
  const [shrink, setShrink] = useState(standards.shrinkage_pct?.toString() ?? '');
  // Margin now lives in Rules Master; we keep the stored value only to re-persist it
  // unchanged (no data loss) — it is no longer editable from this panel.
  const [margin] = useState(standards.margin_pct?.toString() ?? '');
  const [terms, setTerms] = useState(standards.payment_terms ?? '');
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  function save() {
    const fd = new FormData();
    fd.set('fabric_cost', fabric);
    fd.set('dyeing_cost', dyeing);
    fd.set('shrinkage_pct', shrink);
    fd.set('margin_pct', margin);
    fd.set('payment_terms', terms);
    start(async () => {
      const res = await saveCostStandards(fd);
      setMsg(res.ok ? 'Saved.' : res.error);
      if (res.ok) reloadWithToast(res.message ?? 'Saved.');
    });
  }

  return (
    <details className="wf-standards-panel" open={false}>
      <summary>Standard fields — documented once, same across all products</summary>
      {msg && <Notice tone="ok">{msg}</Notice>}
      <div className="wf-form-grid">
        <Field label="Fabric cost"><input type="number" min={0} value={fabric} disabled={!editable} onChange={(e) => setFabric(e.target.value)} /></Field>
        <Field label="Dyeing cost"><input type="number" min={0} value={dyeing} disabled={!editable} onChange={(e) => setDyeing(e.target.value)} /></Field>
        <Field label="Shrinkage %"><input type="number" min={0} value={shrink} disabled={!editable} onChange={(e) => setShrink(e.target.value)} /></Field>
        <Field label="Margin %" hint="Set in Rules Master"><input value="Rules Master" disabled readOnly /></Field>
        <Field label="Payment terms"><input value={terms} disabled={!editable} placeholder="e.g. 30 days" onChange={(e) => setTerms(e.target.value)} /></Field>
        {editable && (
          <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" onClick={save} disabled={busy}>
            <Save size={13} /> {busy ? 'Saving…' : 'Save standard fields'}
          </button>
        )}
      </div>
    </details>
  );
}

/**
 * EFOB Fabric Cost (spec §6) — the monthly fixed rate the company sets for carrying
 * commodity risk on EFOB POs. Its own benchmark, separate from the fabric-cost sheet.
 */
function EfobFabricCostPanel({
  rows,
  fabricCodes,
  editable,
}: {
  rows: EfobFabricCost[];
  fabricCodes: string[];
  editable: boolean;
}) {
  const [fabricCode, setFabricCode] = useState('');
  const [month, setMonth] = useState('');
  const [rate, setRate] = useState('');
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Legacy free-typed fabric codes on existing rows still show in the picker.
  const options = useMemo(() => {
    const set = new Set(fabricCodes);
    for (const r of rows) if (r.fabric_code) set.add(r.fabric_code);
    return [...set].sort();
  }, [fabricCodes, rows]);

  function save() {
    setMsg(null);
    setErr(null);
    if (!fabricCode) return setErr('Pick a fabric — the EFOB rate is per fabric.');
    if (!month) return setErr('Pick a month.');
    if (rate === '') return setErr('Enter the rate.');
    const fd = new FormData();
    fd.set('fabric_code', fabricCode);
    fd.set('month', month);
    fd.set('rate', rate);
    start(async () => {
      const res = await saveEfobFabricCost(fd);
      if (res.ok) reloadWithToast(res.message ?? 'Saved.');
      else setErr(res.error);
    });
  }

  return (
    <details className="wf-standards-panel">
      <summary>
        EFOB Fabric Cost — the monthly rate per fabric for EFOB POs
        {rows.length > 0 && (
          <span className="wf-subtle"> · {rows.length} fabric-month rate{rows.length === 1 ? '' : 's'} set</span>
        )}
      </summary>
      <p className="wf-subtle">
        Set the EFOB fabric rate for <strong>each individual fabric</strong>, per month — it is not
        one blended rate for all fabrics.
      </p>
      {msg && <Notice tone="ok">{msg}</Notice>}
      {err && <Notice tone="error">{err}</Notice>}
      {editable && (
        <div className="wf-form-grid">
          <Field label="Fabric">
            <select value={fabricCode} onChange={(e) => setFabricCode(e.target.value)}>
              <option value="">— fabric —</option>
              {options.map((f) => (<option key={f} value={f}>{f}</option>))}
            </select>
          </Field>
          <Field label="Month"><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></Field>
          <Field label="EFOB fabric rate"><input type="number" min={0} value={rate} onChange={(e) => setRate(e.target.value)} /></Field>
          <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" onClick={save} disabled={busy}>
            <Save size={13} /> {busy ? 'Saving…' : 'Set rate'}
          </button>
        </div>
      )}
      {rows.length > 0 && (
        <table className="wf-grid wf-cost-lines">
          <thead><tr><th>Fabric <HeaderInfo label="Fabric" /></th><th>Month <HeaderInfo label="Month" /></th><th className="num">Rate <HeaderInfo label="Rate" /></th><th>Set by <HeaderInfo label="Set by" /></th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.fabric_code}-${r.month}`}>
                <td className="mono">{r.fabric_code}</td>
                <td>{r.month.slice(0, 7)}</td>
                <td className="num">{r.rate != null ? `₹${r.rate}` : '—'}</td>
                <td className="wf-subtle">{r.updated_by ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!rows.length && <p className="wf-subtle">No EFOB fabric rate set yet.</p>}
    </details>
  );
}

export function CostRow({
  cost,
  role,
  track,
  temp,
  name,
  canRemove = true,
}: {
  cost: StandardCost;
  role: SdRole;
  track: 'fg' | 'material';
  /** Offer "Remove from list" here (off for a product not in EasyEcom: it has Delete product). */
  canRemove?: boolean;
  /** Product name shown beside the code. */
  name?: string;
  /** Set when this product is a temporary (not-yet-in-EasyEcom) product. */
  temp?: TempProductInfo;
}) {
  const isMat = track === 'material';
  const labels = RATE_LABELS[track];
  // Material lists Billing first, as its sheet does.
  const keys: RateKey[] = isMat ? ['fob', 'job', 'efob'] : ['job', 'fob', 'efob'];
  const stage = cost.neg_stage;
  const stageKey = stage ?? '';

  const [rates, setRates] = useState<Record<RateKey, string>>({
    job: cost.job_cost?.toString() ?? '',
    fob: cost.fob_cost?.toString() ?? '',
    efob: cost.efob_cost?.toString() ?? '',
  });
  const [proposed, setProposed] = useState('');
  const [targets, setTargets] = useState<Partial<Record<RateKey, string>>>({});
  const [noteMode, setNoteMode] = useState<'renegotiate' | 'reject' | null>(null);
  const [note, setNote] = useState('');
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const canManageList = canEdit(role, 'draft') && canRemove;
  const isTemp = temp?.status === 'active';

  // Soft-delete: remove from the list but keep every field + the history; re-adding
  // the code restores it. Never edits the cost itself, so allowed even when frozen.
  function remove() {
    setErr(null);
    const fd = new FormData();
    fd.set('product_code', cost.product_code);
    fd.set('track', track);
    fd.set('hidden', 'true');
    start(async () => {
      const res = await setStandardCostHidden(fd);
      if (res.ok) reloadWithToast(res.message ?? 'Saved.');
      else setErr(res.error);
    });
  }

  // Rates are fillable both when the team proposes (so a proposal can name its PO
  // type) and when it later submits the actual vendor rate.
  const rateEditable = (canPropose(role, stage) || canSubmitRate(role, stage)) && !cost.frozen;
  const targetEditable = canSetTarget(role, stage) && !cost.frozen;
  const showExpected = (canPropose(role, stage) && !cost.frozen) || cost.proposed_cost != null;
  const rateRow = stage === 'rate_submitted' ? 'Vendor rate' : stage === 'signed_off' ? 'Standard' : 'Proposed';
  const typedTarget = keys.some((k) => cost[`target_${k}` as const] != null);
  const legacyTarget = !typedTarget && cost.target_cost != null;
  const rateFields = { job_cost: rates.job, fob_cost: rates.fob, efob_cost: rates.efob };

  function act(action: (fd: FormData) => Promise<ActionResult>, extra: Record<string, string>) {
    setErr(null);
    const fd = new FormData();
    fd.set('track', track);
    fd.set('id', String(cost.id));
    Object.entries(extra).forEach(([k, v]) => fd.set(k, v));
    start(async () => {
      const res = await action(fd);
      if (res.ok) reloadWithToast(res.message ?? 'Saved.');
      else setErr(res.error);
    });
  }

  return (
    <div className="sc-entry">
      <div className="sc-entry-main">
      <div className="sc-entry-head">
        <span className="wf-cost-code mono">
          {cost.product_code}
          {isTemp && (
            <span className="wf-temp-badge" title={temp?.name ? `Temporary product — ${temp.name}` : 'Temporary product — link it when it exists in EasyEcom'}>
              TEMP{temp?.name ? ` · ${temp.name}` : ''}
            </span>
          )}
          {cost.frozen && (
            <small className="wf-subtle">
              <Lock size={11} /> frozen
            </small>
          )}
        </span>
        {name && <small className="wf-cost-name" title={name}>{name}</small>}
      </div>

      {/* One row for the rates, one for the target, under the same rate-type columns. */}
      <div className="table-scroll">
        <table className="sc-entry-grid">
          <thead>
            <tr>
              <th aria-label="Row" />
              {keys.map((k) => (
                <th key={k} className="num">{labels[k]}</th>
              ))}
              {showExpected && <th className="num">Expected <small>(optional)</small></th>}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">{rateRow}</th>
              {keys.map((k) => (
                <td key={k} className="num input-col">
                  {rateEditable ? (
                    <input
                      type="number"
                      min={0}
                      aria-label={`${labels[k]} rate`}
                      value={rates[k]}
                      onChange={(e) => setRates((r) => ({ ...r, [k]: e.target.value }))}
                    />
                  ) : (
                    disp(cost[`${k}_cost` as const])
                  )}
                </td>
              ))}
              {showExpected && (
                <td className="num input-col">
                  {canPropose(role, stage) && !cost.frozen ? (
                    <input
                      type="number"
                      min={0}
                      aria-label="Expected cost (optional)"
                      placeholder={cost.proposed_cost != null ? String(cost.proposed_cost) : ''}
                      value={proposed}
                      onChange={(e) => setProposed(e.target.value)}
                    />
                  ) : (
                    disp(cost.proposed_cost)
                  )}
                </td>
              )}
            </tr>
            <tr className="sc-entry-target">
              <th scope="row">Target</th>
              {targetEditable ? (
                keys.map((k) => (
                  <td key={k} className="num input-col">
                    <input
                      type="number"
                      min={0}
                      aria-label={`${labels[k]} target`}
                      placeholder={cost[`target_${k}` as const] != null ? String(cost[`target_${k}` as const]) : '₹'}
                      disabled={busy}
                      value={targets[k] ?? ''}
                      onChange={(e) => setTargets((t) => ({ ...t, [k]: e.target.value }))}
                    />
                  </td>
                ))
              ) : legacyTarget ? (
                // Set before targets were per type: which rate it was for was never recorded.
                <td className="num" colSpan={keys.length}>
                  {disp(cost.target_cost)} <small className="wf-subtle">overall (rate type not recorded)</small>
                </td>
              ) : (
                keys.map((k) => (
                  <td key={k} className="num">{disp(cost[`target_${k}` as const] ?? null)}</td>
                ))
              )}
              {showExpected && <td />}
            </tr>
          </tbody>
        </table>
      </div>
      </div>

      <aside className="sc-entry-side" aria-label="Status and actions">
        <div className="sc-entry-stage">
          <span className={`wf-status tone-${COST_STAGE_TONE[stageKey]}`}>{costStageText(stageKey, cost)}</span>
          <small className="wf-subtle">{nextActor(stage)}</small>
        </div>
        {stage === 'rejected' && cost.rejection_notes && <p className="wf-subtle sc-entry-note">Rejected / Discarded: {cost.rejection_notes}</p>}
      {stage === 'renegotiate' && cost.negotiation_notes && <p className="wf-subtle sc-entry-note">Rework / Reassign: {cost.negotiation_notes}</p>}
        <div className="sc-entry-actions">
        {err && <small className="wf-line-error">{err}</small>}

        {canPropose(role, stage) && !cost.frozen && (
          <button
            type="button"
            className="wf-btn wf-btn-primary wf-btn-sm"
            disabled={busy}
            title={`Fill the ${labels.job} / ${labels.fob} / ${labels.efob} rate(s) that apply, then Propose. The expected figure is optional.`}
            onClick={() => act(proposeCost, { proposed_cost: proposed, ...rateFields })}
          >
            Propose
          </button>
        )}

        {canSetTarget(role, stage) && (
          <>
            {canAcceptProposal(role, stage) && (
              <button
                type="button"
                className="wf-btn wf-btn-primary wf-btn-sm"
                disabled={busy}
                title="Approve the proposed rates as-is — they become the standard cost"
                onClick={() => act(acceptProposedCost, {})}
              >
                Approve
              </button>
            )}
            <CostEditApprove cost={cost} track={track} role={role} small />
            <button
              type="button"
              className="wf-btn wf-btn-ghost wf-btn-sm"
              disabled={busy || !Object.keys(targetFields(targets)).length}
              title="Fill the target under each rate type in the Target row"
              onClick={() => act(setTargetCost, targetFields(targets))}
            >
              Set target
            </button>
            {canRejectCost(role, stage) && stage === 'proposed' && (
              <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => setNoteMode('reject')}>
                Reject / Discard
              </button>
            )}
          </>
        )}

        {canSubmitRate(role, stage) && (
          <button
            type="button"
            className="wf-btn wf-btn-primary wf-btn-sm"
            disabled={busy}
            onClick={() => act(submitActualRate, rateFields)}
          >
            <Save size={13} /> Submit rate
          </button>
        )}

        {canSignOff(role, stage) && (
          <>
            {isMat ? (
              <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={busy} onClick={() => act(signOffCost, {})}>
                Approve
              </button>
            ) : canConfirmFabric(role, stage, !!cost.fabric_confirmed_at) ? (
              <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={busy} onClick={() => act(confirmFabricRate, {})}>
                1 · Confirm fabric rate
              </button>
            ) : canConfirmCm(role, stage, !!cost.fabric_confirmed_at, !!cost.cm_confirmed_at) ? (
              <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={busy} onClick={() => act(confirmCmRate, {})}>
                2 · Confirm CMTP → approve
              </button>
            ) : null}
            {!isMat && cost.fabric_confirmed_at && !cost.cm_confirmed_at && <span className="wf-tag-approved">fabric ✓</span>}
            {canRenegotiate(role, stage) && (
              <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => setNoteMode('renegotiate')}>
                Rework / Reassign
              </button>
            )}
            {canRejectCost(role, stage) && (
              <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => setNoteMode('reject')}>
                Reject / Discard
              </button>
            )}
          </>
        )}

        {noteMode && (
          <span className="wf-issue-row">
            <input className="wf-mini-input" placeholder={`${noteMode} reason`} value={note} onChange={(e) => setNote(e.target.value)} />
            <button
              type="button"
              className="wf-btn wf-btn-primary wf-btn-sm"
              disabled={busy || !note.trim()}
              onClick={() => act(noteMode === 'reject' ? rejectCost : renegotiateCost, { note })}
            >
              Confirm
            </button>
            <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => { setNoteMode(null); setNote(''); }}>
              Cancel
            </button>
          </span>
        )}
      </div>
        {canManageList && (
          <button
            type="button"
            className="wf-btn wf-btn-ghost wf-btn-sm sc-entry-remove"
            disabled={busy}
            title="Hide it from the Standard Cost list — data & history kept; add it again to restore"
            onClick={async () => {
              const ok = await confirmDelete({
                title: `Remove ${cost.product_code} from the Standard Cost list?`,
                body: 'It is hidden from the list; its cost, cost sheet and history are kept. Add it again from Add Product to Input Standard Cost to restore it.',
                confirmLabel: 'Remove from list',
              });
              if (ok) remove();
            }}
          >
            {busy ? 'Removing…' : 'Remove from list'}
          </button>
        )}
      </aside>
    </div>
  );
}

const SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'] as const;
const numv = (s: string) => Number(s) || 0;

/** An unsaved further fabric on the cost sheet: which fabric, its unit, and consumption per size. */
type ExtraFabricDraft = { key: number; fabricCode: string; uom: FabricUom; cons: Record<string, string> };

/** The unit picker shared by every fabric block: metres (the master's own unit) or kilograms. */
/**
 * A size run as three rows under one set of size columns: the sizes, the consumption the team
 * fills, and the fabric cost computed from it (finished-fabric rate × consumption).
 */
function SizeRunTable({
  label,
  sizes,
  uom,
  cons,
  onCons,
  cost,
  costLabel,
  editable,
}: {
  label: string;
  sizes: string[];
  uom: string;
  cons: Record<string, string>;
  onCons: (size: string, value: string) => void;
  cost: (size: string) => number | null;
  costLabel: string;
  editable: boolean;
}) {
  return (
    <div className="table-scroll">
      <table className="wf-sizerun" aria-label={label}>
        <tbody>
          <tr className="wf-sizerun-sizes">
            <th scope="row">Size</th>
            {sizes.map((size) => <th key={size} scope="col">{size}</th>)}
          </tr>
          <tr className="wf-sizerun-input">
            <th scope="row">
              Consumption <small>({uom}) · team fills</small>
            </th>
            {sizes.map((size) => (
              <td key={size}>
                <input
                  className="wf-cell-input"
                  type="number"
                  min={0}
                  step="0.01"
                  aria-label={`${size} consumption`}
                  value={cons[size] ?? ''}
                  disabled={!editable}
                  onChange={(e) => onCons(size, e.target.value)}
                />
              </td>
            ))}
          </tr>
          <tr className="wf-sizerun-calc">
            <th scope="row">
              {costLabel} <small>calculated</small>
            </th>
            {sizes.map((size) => (
              <td key={size} className="wf-cell-calc">{disp(cost(size))}</td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function UomSelect({ value, disabled, onChange }: { value: FabricUom; disabled: boolean; onChange: (v: FabricUom) => void }) {
  return (
    <label className="field wf-field">
      <span>
        Consumed in
        <small>how this fabric is bought and consumed — the rate and consumption below read in this unit</small>
      </span>
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value === 'kg' ? 'kg' : 'mtr')}>
        <option value="mtr">Metres (INR/mtr)</option>
        <option value="kg">Kilograms (INR/kg)</option>
      </select>
    </label>
  );
}

// FINAL PRICE buildup (matches the live cost sheet): MARGIN adds a % on the garment
// cost. REJ/OH were removed (2026-09-08); the margin % comes from Rules Master.
const r2 = (n: number) => Math.round(n * 100) / 100;
function buildFinal(garment: number, marginPct: number) {
  const margin = garment * marginPct;
  return { margin, final: garment + margin };
}

/**
 * The expandable cost record — the two linked standards that concatenate into the
 * final cost, each independently owned:
 *   • Fabric Cost — referenced read-only from the Fabric Cost master (the fabric team);
 *     per-size fabric cost = finished-fabric rate × consumption(size).
 *   • CMTP — the CMTP breakdown tab (the costing team).
 * Final Cost = Fabric + CMTP → REJ / OH / MARGIN → FINAL PRICE, all computed and
 * never directly editable.
 */
export function CostDetail({
  cost,
  lines,
  cmtp,
  cmtpSubitems,
  fabricBase,
  fabricCodes,
  history,
  revisions,
  masterFabric,
  editable,
  marginPct,
  extraFabrics = [],
  documents,
  trimHistory,
}: {
  cost: StandardCost;
  lines: StandardCostLine[];
  cmtp: CmtpComponent[];
  cmtpSubitems: Record<string, string[]>;
  fabricBase: Record<string, FabricBuildup>;
  fabricCodes: string[];
  history: StandardCostRateHistory[];
  revisions: CmtpRevision[];
  masterFabric: { fabricCode: string | null; multi: boolean } | null;
  editable: boolean;
  marginPct: number;
  /** Second, third … fabrics on a multi-fabric product, one row per size. */
  extraFabrics?: StandardCostExtraFabric[];
  /** The CAD plan library (product page only) — shown as the Documents tab. */
  documents?: React.ReactNode;
  /** Trim History (product page only) — every trim value change, its own tab after Rate History. */
  trimHistory?: React.ReactNode;
}) {
  const [view, setView] = useState<'cmtp' | 'fabric' | 'documents' | 'final' | 'history' | 'trims'>('cmtp');
  // Default the fabric from Product Master when the sheet hasn't set one and the
  // product maps to a single fabric; multi-fabric products stay blank for manual pick.
  const autoFabric = masterFabric && !masterFabric.multi ? masterFabric.fabricCode ?? '' : '';
  const [fabricCode, setFabricCode] = useState(cost.fabric_code ?? autoFabric);
  const [fabricUom, setFabricUom] = useState<FabricUom>(cost.fabric_uom === 'kg' ? 'kg' : 'mtr');
  const fabricFromMaster = !cost.fabric_code && !!autoFabric && fabricCode === autoFabric;
  const [consBySize, setConsBySize] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    for (const l of lines) {
      if (l.size && l.consumption != null) m[l.size.toUpperCase()] = String(l.consumption);
    }
    return m;
  });
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  // A garment cut from two fabrics: the first fabric is the record above; every further
  // fabric is its own block with its own per-size consumption, and the size's fabric cost
  // is the sum. Kept as drafts (fabric + consumption per size) until saved.
  const [extras, setExtras] = useState<ExtraFabricDraft[]>(() => {
    const byCode = new Map<string, ExtraFabricDraft>();
    let key = 0;
    for (const e of extraFabrics) {
      let d = byCode.get(e.fabric_code);
      if (!d) {
        d = { key: key++, fabricCode: e.fabric_code, uom: e.uom === 'kg' ? 'kg' : 'mtr', cons: {} };
        byCode.set(e.fabric_code, d);
      }
      if (e.size && e.consumption != null) d.cons[e.size.toUpperCase()] = String(e.consumption);
    }
    return [...byCode.values()];
  });
  const nextExtraKey = useRef(1000);

  const fab = fabricCode ? fabricBase[fabricCode] : undefined;
  const fabricRate = fab?.finished ?? null;
  const cmtpTotal = cost.cm_cost; // FINAL CMTP owned by the CMTP tab
  const multiFabric = extras.length > 0;

  // Per-size buildup: fabric = Σ over fabrics (rate × consumption); garment = fabric + CMTP;
  // then the FINAL PRICE chain. A size counts as filled when ANY fabric has a consumption
  // for it; its fabric cost is unknown while any fabric it uses has no finished rate.
  const rows = SIZES.map((size) => {
    const cons = consBySize[size] ?? '';
    const firstHas = cons !== '';
    const first = firstHas ? (fabricRate != null ? r2(fabricRate * numv(cons)) : null) : 0;
    const parts = extras.map((e) => {
      const c = e.cons[size] ?? '';
      const rate = e.fabricCode ? fabricBase[e.fabricCode]?.finished ?? null : null;
      return {
        key: e.key,
        fabricCode: e.fabricCode,
        cons: c,
        has: c !== '',
        cost: c !== '' ? (rate != null ? r2(rate * numv(c)) : null) : 0,
      };
    });
    const has = firstHas || parts.some((p) => p.has);
    const fabric =
      !has || first == null || parts.some((p) => p.cost == null)
        ? null
        : r2(first + parts.reduce((s, p) => s + (p.cost ?? 0), 0));
    const garment = fabric != null && cmtpTotal != null ? r2(fabric + cmtpTotal) : null;
    const f = garment != null ? buildFinal(garment, marginPct) : null;
    return {
      size,
      cons,
      has,
      firstHas,
      first: firstHas ? first : null,
      parts,
      fabric,
      garment,
      margin: f ? r2(f.margin) : null,
      final: f ? r2(f.final) : null,
    };
  });
  const filled = rows.filter((r) => r.has);
  const poAvgFinal =
    filled.length && filled.every((r) => r.final != null)
      ? r2(filled.reduce((s, r) => s + (r.final ?? 0), 0) / filled.length)
      : null;

  function setCons(size: string, value: string) {
    setConsBySize((cur) => ({ ...cur, [size]: value }));
  }
  function addExtra() {
    setExtras((cur) => [...cur, { key: nextExtraKey.current++, fabricCode: '', uom: 'mtr', cons: {} }]);
  }
  function setExtraUom(key: number, uom: FabricUom) {
    setExtras((cur) => cur.map((e) => (e.key === key ? { ...e, uom } : e)));
  }
  function removeExtra(key: number) {
    setExtras((cur) => cur.filter((e) => e.key !== key));
  }
  function setExtraCode(key: number, value: string) {
    setExtras((cur) => cur.map((e) => (e.key === key ? { ...e, fabricCode: value } : e)));
  }
  function setExtraCons(key: number, size: string, value: string) {
    setExtras((cur) => cur.map((e) => (e.key === key ? { ...e, cons: { ...e.cons, [size]: value } } : e)));
  }
  // A fabric can appear once on a product: the options for one block leave out the first
  // fabric and every other block's pick (its own current pick stays selectable).
  function extraOptions(own: string) {
    const taken = new Set([fabricCode, ...extras.map((e) => e.fabricCode)].filter((c) => c && c !== own));
    const base = fabricCodes.filter((c) => !taken.has(c));
    return own && !base.includes(own) ? [own, ...base] : base;
  }

  // Both the Fabric and Final tabs persist the same record (fabric link, per-size
  // consumption and the computed PO-average final price). The CAD / RFP links are saved
  // from the Documents tab.
  function save() {
    setErr(null);
    const header = new FormData();
    header.set('product_code', cost.product_code);
    header.set('fabric_code', fabricCode);
    header.set('fabric_uom', fabricUom);
    if (poAvgFinal != null) header.set('total_po_avg_cost', String(poAvgFinal));

    const detail = new FormData();
    detail.set('product_code', cost.product_code);
    detail.set(
      'lines',
      JSON.stringify(
        filled.map((r) => ({
          colour: '',
          size: r.size,
          consumption: r.cons,
          fabric_cost: r.fabric != null ? String(r.fabric) : '',
          total_cost: r.garment != null ? String(r.garment) : '',
        })),
      ),
    );
    // The further fabrics, each with its own consumption per size. A block with no fabric
    // picked is scratch and is dropped.
    detail.set(
      'extra_fabrics',
      JSON.stringify(
        extras
          .filter((e) => e.fabricCode)
          .map((e, i) => ({
            fabric_code: e.fabricCode,
            position: i + 1,
            uom: e.uom,
            sizes: rows.flatMap((r) => {
              const p = r.parts.find((x) => x.key === e.key);
              return p && p.has
                ? [{ size: r.size, consumption: p.cons, fabric_cost: p.cost != null ? String(p.cost) : '' }]
                : [];
            }),
          })),
      ),
    );

    start(async () => {
      const h = await saveStandardCost(header);
      if (!h.ok) return setErr(h.error);
      const d = await saveStandardCostLines(detail);
      if (!d.ok) return setErr(d.error);
      reloadWithToast(d.message ?? 'Saved.');
    });
  }

  return (
    <div className="wf-cost-detail">
      {err && <Notice tone="error">{err}</Notice>}

      <div className="wf-cost-detail-head">
        <div className="segment wf-segment">
          <button type="button" className={view === 'cmtp' ? 'active' : ''} onClick={() => setView('cmtp')}>CMTP</button>
          <button type="button" className={view === 'fabric' ? 'active' : ''} onClick={() => setView('fabric')}>Fabric Cost</button>
          {documents && (
            <button type="button" className={view === 'documents' ? 'active' : ''} onClick={() => setView('documents')}>Documents</button>
          )}
          <button type="button" className={view === 'final' ? 'active' : ''} onClick={() => setView('final')}>Final Cost</button>
          <button type="button" className={view === 'history' ? 'active' : ''} onClick={() => setView('history')}>
            Rate History{history.length > 0 ? ` (${history.length})` : ''}
          </button>
          {trimHistory && (
            <button type="button" className={view === 'trims' ? 'active' : ''} onClick={() => setView('trims')}>Trim History</button>
          )}
        </div>
        <span className="wf-subtle wf-two-entity-note">
          Final = Fabric + CMTP (computed). Two owners: Fabric — the Fabric Cost master · CMTP — the costing team.
        </span>
      </div>

      {view === 'cmtp' ? (
        <CmtpBreakdown cost={cost} cmtp={cmtp} subitems={cmtpSubitems} editable={editable} />
      ) : view === 'fabric' ? (
        <div className="wf-fabric-view">
          <div className="wf-form-grid">
            <label className="field wf-field">
              <span>
                {multiFabric ? 'Fabric 1' : 'Fabric'}
                <small>
                  {fabricFromMaster
                    ? 'defaulted from Product Master — change if needed'
                    : masterFabric?.multi
                      ? 'multi-fabric product — pick the fabric manually, then add the other fabric below'
                      : multiFabric
                        ? 'the main fabric this product is cut from'
                        : 'the fabric this product uses'}
                </small>
              </span>
              <select value={fabricCode} disabled={!editable} onChange={(e) => setFabricCode(e.target.value)}>
                <option value="">—</option>
                {/* Ensure the current value (e.g. a Product-Master fabric not in the
                    costed list yet) is always a selectable option. */}
                {(fabricCode && !fabricCodes.includes(fabricCode) ? [fabricCode, ...fabricCodes] : fabricCodes).map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            </label>
            <UomSelect value={fabricUom} disabled={!editable} onChange={setFabricUom} />
          </div>

          <div className="wf-cost-param">
            <span className="wf-cost-param-head">Fabric Cost — owned by the Fabric Cost master</span>
            <dl className="wf-doc-meta">
              <div><dt>Grey rate</dt><dd className="wf-cell-input">{disp(fab?.grey ?? null)}</dd></div>
              <div><dt>Processing</dt><dd className="wf-cell-input">{disp(fab?.processing ?? null)}</dd></div>
              <div><dt>Finished fabric (INR/{fabricUom})</dt><dd className="wf-cell-calc">{disp(fab?.finished ?? null)}</dd></div>
            </dl>
            <a className="wf-btn wf-btn-ghost wf-btn-sm" href="/fabric-cost">Edit on Fabric Cost →</a>
          </div>

          {/* The size run as three rows: the sizes, the consumption the team fills, and the
              fabric cost computed from it. */}
          <SizeRunTable
            label="Consumption and fabric cost by size"
            sizes={rows.map((r) => r.size)}
            uom={fabricUom}
            cons={Object.fromEntries(rows.map((r) => [r.size, r.cons]))}
            onCons={setCons}
            cost={(size) => {
              const r = rows.find((x) => x.size === size);
              return r ? (multiFabric ? r.first : r.fabric) : null;
            }}
            costLabel={multiFabric ? 'Fabric 1 cost' : 'Fabric cost'}
            editable={editable}
          />
          <p className="wf-subtle wf-legend">
            <span className="wf-legend-input">input</span>
            <span className="wf-legend-calc">computed</span>
            — fabric cost = finished-fabric rate × consumption, both in the unit picked (metres or kg). The rate is owned by the Fabric Cost master.
            {fabricRate == null && ' Pick a fabric with a finished rate to compute.'}
          </p>

          {/* Further fabrics. A garment cut from two fabrics carries each one's consumption
              separately; the size's fabric cost in Final Cost is the sum of all of them. */}
          {(multiFabric || editable) && (
            <div className="wf-extra-fabrics">
              {extras.map((e, idx) => {
                const efab = e.fabricCode ? fabricBase[e.fabricCode] : undefined;
                const erate = efab?.finished ?? null;
                return (
                  <div className="wf-cost-param wf-extra-fabric" key={e.key}>
                    <div className="wf-extra-fabric-head">
                      <span className="wf-cost-param-head">Fabric {idx + 2}</span>
                      {editable && (
                        <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => removeExtra(e.key)}>
                          <Trash2 size={13} /> Remove
                        </button>
                      )}
                    </div>
                    <div className="wf-form-grid">
                      <label className="field wf-field">
                        <span>
                          Fabric
                          <small>the other fabric this product is cut from</small>
                        </span>
                        <select value={e.fabricCode} disabled={!editable} onChange={(ev) => setExtraCode(e.key, ev.target.value)}>
                          <option value="">—</option>
                          {extraOptions(e.fabricCode).map((f) => (
                            <option key={f} value={f}>{f}</option>
                          ))}
                        </select>
                      </label>
                      <UomSelect value={e.uom} disabled={!editable} onChange={(v) => setExtraUom(e.key, v)} />
                    </div>
                    <dl className="wf-doc-meta">
                      <div><dt>Grey rate</dt><dd className="wf-cell-input">{disp(efab?.grey ?? null)}</dd></div>
                      <div><dt>Processing</dt><dd className="wf-cell-input">{disp(efab?.processing ?? null)}</dd></div>
                      <div><dt>Finished fabric (INR/{e.uom})</dt><dd className="wf-cell-calc">{disp(erate)}</dd></div>
                    </dl>
                    <SizeRunTable
                      label={`Consumption and cost by size — fabric ${idx + 2}`}
                      sizes={[...SIZES]}
                      uom={e.uom}
                      cons={e.cons}
                      onCons={(size, v) => setExtraCons(e.key, size, v)}
                      cost={(size) => {
                        const c = e.cons[size] ?? '';
                        return c !== '' && erate != null ? r2(erate * numv(c)) : null;
                      }}
                      costLabel={`Fabric ${idx + 2} cost`}
                      editable={editable}
                    />
                    {e.fabricCode && erate == null && (
                      <p className="wf-subtle wf-cost-param-note">
                        No finished rate on the Fabric Cost master for this fabric yet — its cost cannot be computed until the fabric team fills it there.
                      </p>
                    )}
                  </div>
                );
              })}
              {editable && (
                <div>
                  <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={addExtra}>
                    <Plus size={13} /> Add another fabric
                  </button>
                </div>
              )}
              {multiFabric && filled.length > 0 && (
                <div className="wf-cost-param">
                  <span className="wf-cost-param-head">Fabric cost by size — all fabrics together</span>
                  <div className="table-scroll">
                    <table className="wf-sizerun">
                      <tbody>
                        <tr className="wf-sizerun-sizes">
                          <th scope="row">Size</th>
                          {filled.map((r) => <th key={r.size} scope="col">{r.size}</th>)}
                        </tr>
                        <tr>
                          <th scope="row">Fabric 1</th>
                          {filled.map((r) => <td key={r.size}>{disp(r.first)}</td>)}
                        </tr>
                        {extras.map((e, i) => (
                          <tr key={e.key}>
                            <th scope="row">Fabric {i + 2}</th>
                            {filled.map((r) => {
                              const p = r.parts[i];
                              return <td key={r.size}>{disp(p && p.has ? p.cost : null)}</td>;
                            })}
                          </tr>
                        ))}
                        <tr className="wf-sizerun-calc">
                          <th scope="row">Total fabric cost</th>
                          {filled.map((r) => <td key={r.size} className="wf-cell-calc">{disp(r.fabric)}</td>)}
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {editable && (
            <div className="wf-cost-detail-foot">
              <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" onClick={save} disabled={busy}>
                <Save size={13} /> {busy ? 'Saving…' : 'Save fabric cost'}
              </button>
            </div>
          )}
        </div>
      ) : view === 'documents' && documents ? (
        <div className="wf-documents-view">{documents}</div>
      ) : view === 'final' ? (
        <div className="wf-final-view">
          <div className="table-scroll">
            <table className="wf-grid wf-cost-lines">
              <thead>
                <tr>
                  <th>Size <HeaderInfo label="Size" /></th>
                  {multiFabric && (
                    <>
                      <th className="num wf-cell-calc">Fabric 1{fabricCode ? ` · ${fabricCode}` : ''}</th>
                      {extras.map((e, i) => (
                        <th className="num wf-cell-calc" key={e.key}>Fabric {i + 2}{e.fabricCode ? ` · ${e.fabricCode}` : ''}</th>
                      ))}
                    </>
                  )}
                  <th className="num wf-cell-calc">{multiFabric ? 'Fabric total' : 'Fabric'} <HeaderInfo label="Fabric" /></th>
                  <th className="num wf-cell-calc">CMTP <HeaderInfo label="CMTP" /></th>
                  <th className="num wf-cell-calc">Garment <HeaderInfo label="Garment" /></th>
                  <th className="num wf-cell-calc">Margin <HeaderInfo label="Margin" /></th>
                  <th className="num wf-cell-calc">Final price <HeaderInfo label="Final price" /></th>
                </tr>
              </thead>
              <tbody>
                {filled.map((r) => (
                  <tr key={r.size}>
                    <td className="strong">{r.size}</td>
                    {multiFabric && (
                      <>
                        <td className="num wf-cell-calc">{disp(r.first)}</td>
                        {r.parts.map((p) => (
                          <td className="num wf-cell-calc" key={p.key}>{disp(p.has ? p.cost : null)}</td>
                        ))}
                      </>
                    )}
                    <td className="num wf-cell-calc">{disp(r.fabric)}</td>
                    <td className="num wf-cell-calc">{disp(cmtpTotal)}</td>
                    <td className="num wf-cell-calc">{disp(r.garment)}</td>
                    <td className="num wf-cell-calc">{disp(r.margin)}</td>
                    <td className="num strong wf-cell-calc">{disp(r.final)}</td>
                  </tr>
                ))}
                {!filled.length && (
                  <tr><td colSpan={6 + (multiFabric ? extras.length + 1 : 0)} className="wf-empty-cell">Fill fabric consumption (Fabric Cost tab) + CMTP to compute the final price.</td></tr>
                )}
              </tbody>
              {poAvgFinal != null && (
                <tfoot><tr><td colSpan={5 + (multiFabric ? extras.length + 1 : 0)}>PO AVG final price</td><td className="num strong wf-cell-calc">{poAvgFinal}</td></tr></tfoot>
              )}
            </table>
          </div>
          <p className="wf-subtle">
            Final price = Garment (Fabric + CMTP) + Margin {r2(marginPct * 100)}% (set in Rules Master).
            {multiFabric && ' · Fabric total = every fabric the garment is cut from, each at its own rate × consumption.'}
            {cmtpTotal == null && ' · CMTP not filled yet — fill the CMTP tab.'}
          </p>

          {/* CAD and RFP links live on the Documents tab now (user, 2026-10-09). */}

          {editable && (
            <div className="wf-cost-detail-foot">
              <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" onClick={save} disabled={busy}>
                <Save size={13} /> {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          )}
        </div>
      ) : view === 'trims' && trimHistory ? (
        trimHistory
      ) : (
        <RateHistoryPanel history={history} revisions={revisions} />
      )}
    </div>
  );
}

/**
 * Accepted-rate history for a product: every job / FOB / E-FOB rate that was
 * signed off, newest first, with the date and who accepted it. The top row is
 * the LIVE rate the Buying Plan values from (until a new proposal is accepted).
 */
export function RateHistoryPanel({
  history,
  revisions = [],
  hideRevisions = false,
  rateLabels,
}: {
  history: StandardCostRateHistory[];
  revisions?: CmtpRevision[];
  /** Material track has no CMTP breakdown, so it hides the line-revision log. */
  hideRevisions?: boolean;
  /** Column headers for the three rate slots (job / fob / efob). Material relabels them. */
  rateLabels?: { job: string; fob: string; efob: string };
}) {
  const lbl = rateLabels ?? { job: 'Job', fob: 'FOB', efob: 'E-FOB' };
  const when = (iso: string) =>
    new Date(iso).toLocaleString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  const amt = (v: number | null) => (v == null ? '—' : String(v));
  return (
    <div className="wf-history-view">
      <p className="wf-subtle">
        Every accepted rate over time — a cost can be re-proposed and re-accepted. The
        top (latest) row is the <strong>live standard cost</strong> the Buying Plan values
        from; a plan freezes its rate when submitted for approval.
      </p>
      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wf-grid">
            <thead>
              <tr>
                <th>Accepted on <HeaderInfo label="Accepted on" /></th>
                <th className="num">{lbl.job}</th>
                <th className="num">{lbl.fob}</th>
                <th className="num">{lbl.efob}</th>
                <th>By <HeaderInfo label="By" /></th>
                <th>Note <HeaderInfo label="Note" /></th>
              </tr>
            </thead>
            <tbody>
              {history.map((h, i) => (
                <tr key={h.id} className={i === 0 ? 'wf-row-current' : undefined}>
                  <td>
                    {when(h.accepted_at)}
                    {i === 0 && <span className="wf-tag-approved" style={{ marginLeft: 6 }}>current</span>}
                  </td>
                  <td className="num">{disp(h.job_cost)}</td>
                  <td className="num">{disp(h.fob_cost)}</td>
                  <td className="num">{disp(h.efob_cost)}</td>
                  <td className="wf-subtle">{h.accepted_by ?? '—'}</td>
                  <td className="wf-subtle">{h.note ?? '—'}</td>
                </tr>
              ))}
              {!history.length && (
                <tr><td colSpan={6} className="wf-empty-cell">No accepted rate yet — this product has not been approved.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Item 2 — line-item CMTP revision log: every single-line change with its
          mandatory reason (old → new), so a karigar-rate or trim-rate move is
          auditable without a whole-sheet re-approval. Material has no CMTP, so it hides this. */}
      {!hideRevisions && (
        <>
          <p className="wf-subtle" style={{ marginTop: 18 }}>
            <strong>CMTP line revisions</strong> — individual cost-line changes, newest first, each
            with the reason it was revised.
          </p>
          <div className="table-panel wf-grid-panel">
            <div className="table-scroll">
              <table className="wf-grid">
                <thead>
                  <tr>
                    <th>Revised on <HeaderInfo label="Revised on" /></th>
                    <th>Line <HeaderInfo label="Line" /></th>
                    <th className="num">Old <HeaderInfo label="Old" /></th>
                    <th className="num">New <HeaderInfo label="New" /></th>
                    <th>By <HeaderInfo label="By" /></th>
                    <th>Reason <HeaderInfo label="Reason" /></th>
                  </tr>
                </thead>
                <tbody>
                  {revisions.map((rv) => (
                    <tr key={rv.id}>
                      <td>{when(rv.revised_at)}</td>
                      <td>{rv.category}{rv.label ? ` · ${rv.label}` : ''}</td>
                      <td className="num">{amt(rv.old_amount)}</td>
                      <td className="num">{amt(rv.new_amount)}</td>
                      <td className="wf-subtle">{rv.revised_by ?? '—'}</td>
                      <td className="wf-subtle">{rv.reason}</td>
                    </tr>
                  ))}
                  {!revisions.length && (
                    <tr><td colSpan={6} className="wf-empty-cell">No line revisions yet — the CMTP breakdown has not been changed since it was first entered.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

type CmtpRow = { uid: number; category: string; label: string; amount: string };

// Monotonic client-only key source for CMTP rows (stable across add/remove).
let cmtpUidSeq = 0;
const nextCmtpUid = () => (cmtpUidSeq += 1);

/**
 * CMTP cost breakdown — the CM cost built from category heads (§1 of the spec), as one table.
 * Every head is a section and every sub-item the master holds for it is already a row, so the
 * team types amounts straight in (no picking from a dropdown first). A row can be removed, a
 * new sub-item added under a head (it joins the master), and a whole head added. Only rows
 * with an amount are cost lines: they are what is saved and what the total adds up.
 */
function CmtpBreakdown({
  cost,
  cmtp,
  subitems,
  editable,
}: {
  cost: StandardCost;
  cmtp: CmtpComponent[];
  subitems: Record<string, string[]>;
  editable: boolean;
}) {
  // Local, extendable copy of the sub-item master so a newly-added name shows at once.
  const [subs, setSubs] = useState<Record<string, string[]>>(subitems);
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [newSub, setNewSub] = useState('');
  const [subBusy, startSub] = useTransition();

  // The saved lines, then every master sub-item of each head that has no line yet, blank.
  const seed = (heads: string[], master: Record<string, string[]>): CmtpRow[] => {
    const out: CmtpRow[] = [];
    for (const cat of heads) {
      const saved = cmtp.filter((c) => c.category === cat);
      for (const name of master[cat] ?? []) {
        const hits = saved.filter((c) => (c.label ?? '') === name);
        if (hits.length) {
          for (const c of hits) out.push({ uid: nextCmtpUid(), category: cat, label: name, amount: c.amount != null ? String(c.amount) : '' });
        } else {
          out.push({ uid: nextCmtpUid(), category: cat, label: name, amount: '' });
        }
      }
      // Saved lines whose sub-item is not (or no longer) in the master keep their place.
      for (const c of saved) {
        if (!(master[cat] ?? []).includes(c.label ?? '')) {
          out.push({ uid: nextCmtpUid(), category: cat, label: c.label ?? '', amount: c.amount != null ? String(c.amount) : '' });
        }
      }
    }
    return out;
  };
  const initialHeads = (() => {
    const order: string[] = [...CMTP_MANDATORY];
    for (const c of cmtp) if (!order.includes(c.category)) order.push(c.category);
    return order;
  })();
  const [heads, setHeads] = useState<string[]>(initialHeads);
  const [rows, setRows] = useState<CmtpRow[]>(() => seed(initialHeads, subitems));
  const [newHead, setNewHead] = useState('');
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function addSubitem(cat: string) {
    const name = newSub.trim();
    if (!name) return;
    // Already in the master for this head: just give it a row (again, if it was removed).
    if ((subs[cat] ?? []).includes(name)) {
      setRows((cur) => [...cur, { uid: nextCmtpUid(), category: cat, label: name, amount: '' }]);
      setNewSub('');
      setAddingFor(null);
      return;
    }
    const fd = new FormData();
    fd.set('category', cat);
    fd.set('name', name);
    startSub(async () => {
      const res = await addCmtpSubitem(fd);
      if (res.ok) {
        setSubs((cur) => {
          const list = cur[cat] ?? [];
          return list.includes(name) ? cur : { ...cur, [cat]: [...list, name].sort() };
        });
        setRows((cur) => [...cur, { uid: nextCmtpUid(), category: cat, label: name, amount: '' }]);
        setNewSub('');
        setAddingFor(null);
      } else setErr(toastError(res.error));
    });
  }

  // Item 2 — a revision reason is mandatory when an EXISTING breakdown's amounts change (not
  // on first entry). Only lines with an amount count, on both sides, so the blank pre-listed
  // rows never read as a change.
  const [reason, setReason] = useState('');
  const hadData = cmtp.some((c) => c.amount != null);
  // Keys carry an occurrence index so a duplicated head+sub-item counts as a second line
  // (mirrors the server diff) — otherwise a duplicate slips through as "unchanged".
  const keyed = (list: { category: string; label: string | null; amount: string }[]) => {
    const seen = new Map<string, number>();
    const m = new Map<string, string>();
    for (const c of list) {
      const base = `${c.category} :: ${c.label ?? ''}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      m.set(n ? `${base} #${n + 1}` : base, c.amount);
    }
    return m;
  };
  const initialAmts = useMemo(
    () =>
      keyed(
        cmtp
          .filter((c) => c.amount != null)
          .map((c) => ({ category: c.category, label: c.label, amount: String(c.amount) })),
      ),
    [cmtp],
  );
  const filled = rows.filter((r) => r.amount.trim() !== '');
  const isRevision = useMemo(() => {
    if (!hadData) return false;
    const now = keyed(filled.map((r) => ({ category: r.category, label: r.label, amount: r.amount })));
    if (now.size !== initialAmts.size) return true;
    for (const [k, v] of now) {
      const old = initialAmts.get(k);
      if (old === undefined) return true;
      if (Math.abs((numv(v) || 0) - (numv(old) || 0)) >= 0.005) return true;
    }
    return false;
  }, [filled, initialAmts, hadData]);

  const total = filled.reduce((sum, r) => sum + (numv(r.amount) || 0), 0);

  const removeRow = (u: number) => setRows((cur) => cur.filter((r) => r.uid !== u));
  const patchAmount = (u: number, value: string) =>
    setRows((cur) => cur.map((r) => (r.uid === u ? { ...r, amount: value } : r)));

  function addHead() {
    const c = newHead.trim();
    setNewHead('');
    if (!c || heads.includes(c)) return;
    setHeads((cur) => [...cur, c]);
    // A head the master already knows comes with its sub-items listed.
    setRows((cur) => [
      ...cur,
      ...(subs[c] ?? []).map((name) => ({ uid: nextCmtpUid(), category: c, label: name, amount: '' })),
    ]);
  }

  function save() {
    setErr(null);
    if (isRevision && !reason.trim()) {
      setErr('Enter a reason for this revision — it is logged against the changed line(s) in the rate history.');
      return;
    }
    const fd = new FormData();
    fd.set('product_code', cost.product_code);
    // Only lines with an amount are cost lines; blank pre-listed rows are not saved.
    fd.set('components', JSON.stringify(filled.map((r) => ({ category: r.category, label: r.label, amount: r.amount }))));
    if (isRevision) fd.set('revision_reason', reason.trim());
    start(async () => {
      const res = await saveCmtpComponents(fd);
      if (res.ok) {
        setReason('');
        reloadWithToast(res.message ?? 'Saved.');
      } else setErr(res.error);
    });
  }

  const fmtAmt = (v: number) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(v);

  // Pack the head cards into columns, each going under the shortest column so far, in head
  // order. A plain grid made every row as tall as its tallest card, leaving big gaps under the
  // one-line heads (Cutting, Packaging, Brand Trims). Column count follows the panel width.
  const headsRef = useRef<HTMLDivElement>(null);
  const [colCount, setColCount] = useState(4);
  useEffect(() => {
    const el = headsRef.current;
    if (!el) return;
    const measure = () => setColCount(Math.max(1, Math.floor((el.clientWidth + 10) / (300 + 10))));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const packed = useMemo(() => {
    const n = Math.min(colCount, Math.max(1, heads.length));
    const cols: string[][] = Array.from({ length: n }, () => []);
    const height = Array(n).fill(0);
    for (const cat of heads) {
      const lines = rows.filter((r) => r.category === cat && (editable || r.amount.trim() !== '')).length;
      // Header + "Add sub-item" weigh about two lines.
      const h = Math.max(lines, 1) + 2;
      const i = height.indexOf(Math.min(...height));
      cols[i].push(cat);
      height[i] += h;
    }
    return cols;
  }, [heads, rows, editable, colCount]);

  return (
    <div className="wf-cmtp">
      {err && <Notice tone="error">{err}</Notice>}
      <p className="wf-subtle">
        CMTP cost is built from these heads — the total below is the product&rsquo;s FINAL CMTP.
        Every sub-item is listed under its head: fill the amounts that apply and leave the rest
        blank (blank lines are not saved). Remove a line you do not need, or add a sub-item or a
        whole head the product needs (e.g. buttoning under Product Trims for shirts).
      </p>

      {/* Heads tile across the full panel width, one card each. Every sub-item the master
          holds for a head is already a line in its card: type the amount straight in. */}
      <div className="wf-cmtp-heads" ref={headsRef} style={{ gridTemplateColumns: `repeat(${packed.length}, minmax(0, 1fr))` }}>
        {packed.map((column, ci) => (
          <div key={ci} className="wf-cmtp-col">
        {column.map((cat) => {
          const head = CMTP_HEADS.find((h) => h.key === cat);
          const mandatory = CMTP_MANDATORY.includes(cat);
          const all = rows.filter((r) => r.category === cat);
          // Read-only shows the cost lines only; editing shows every line to fill.
          const catRows = editable ? all : all.filter((r) => r.amount.trim() !== '');
          const sub = all.reduce((sum, r) => sum + (numv(r.amount) || 0), 0);
          return (
            <div key={cat} className="wf-cmtp-head">
              <div className="wf-cmtp-head-row">
                <span className="wf-cmtp-head-name">
                  {head?.label ?? cat}
                  {mandatory && <small className="wf-subtle"> · required</small>}
                </span>
                <span className="wf-cmtp-sub wf-cell-calc">{sub ? fmtAmt(sub) : '—'}</span>
              </div>
              {catRows.map((r) => (
                <div key={r.uid} className={`wf-cmtp-line${r.amount.trim() !== '' ? ' is-filled' : ''}`}>
                  <span className="wf-cmtp-label wf-cmtp-label-text" title={r.label}>
                    {r.label || <span className="wf-subtle">(no sub-item)</span>}
                  </span>
                  {editable ? (
                    <input
                      className="wf-cmtp-amt"
                      type="number"
                      min={0}
                      placeholder="amount"
                      aria-label={`${head?.label ?? cat}: ${r.label || 'amount'}`}
                      value={r.amount}
                      onChange={(e) => patchAmount(r.uid, e.target.value)}
                    />
                  ) : (
                    <span className="wf-cmtp-amt wf-cmtp-amt-text">{fmtAmt(numv(r.amount) || 0)}</span>
                  )}
                  {editable && (
                    <button
                      type="button"
                      className="wf-icon-btn"
                      aria-label={`Remove ${r.label || 'line'}`}
                      title="Remove this line"
                      onClick={() => removeRow(r.uid)}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              ))}
              {!catRows.length && (
                <small className="wf-subtle">{editable ? 'No sub-items listed — add one below.' : 'Nothing recorded.'}</small>
              )}
              {editable && (
                <div className="wf-cmtp-add">
                  {addingFor === cat ? (
                    <span className="wf-cmtp-newsub">
                      <input
                        placeholder="Sub-item name"
                        value={newSub}
                        disabled={subBusy}
                        autoFocus
                        onChange={(e) => setNewSub(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); addSubitem(cat); }
                          if (e.key === 'Escape') { setAddingFor(null); setNewSub(''); }
                        }}
                      />
                      <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={subBusy || !newSub.trim()} onClick={() => addSubitem(cat)}>
                        {subBusy ? 'Adding…' : 'Add'}
                      </button>
                      <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={subBusy} onClick={() => { setAddingFor(null); setNewSub(''); }}>
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button type="button" className="wf-chip-btn" onClick={() => { setAddingFor(cat); setNewSub(''); }}>
                      <Plus size={12} /> Add sub-item
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
          </div>
        ))}
      </div>

      {editable && (
        <div className="wf-cmtp-newhead">
          <input placeholder="Add a head (e.g. Embroidery)" value={newHead} onChange={(e) => setNewHead(e.target.value)} />
          <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={!newHead.trim()} onClick={addHead}>
            <Plus size={12} /> Add head
          </button>
        </div>
      )}

      <div className="wf-cmtp-total">
        <span>FINAL CMTP cost</span>
        <strong className="wf-cell-calc">{total ? fmtAmt(total) : '—'}</strong>
      </div>

      {editable && isRevision && (
        <label className="field wf-field wf-cmtp-reason">
          <span>
            Reason for this revision <small>required — a line amount changed; logged to the rate history</small>
          </span>
          <input
            type="text"
            placeholder="e.g. karigar rate increased; XYZ dyeing rate revised"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
      )}

      {editable && (
        <div className="wf-cost-detail-foot">
          <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" onClick={save} disabled={busy}>
            <Save size={13} /> {busy ? 'Saving…' : 'Save CMTP breakdown'}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * "Needs approval" view, admin: decide proposals in groups. Tick the cards to act on (or
 * select all in view), then accept them as-is or reject them with one reason. Each still
 * runs the single-row action, so guards and history hold and a failure is named by id.
 * Rows awaiting sign-off are decided on their own page, where fabric and CMTP are
 * confirmed in order.
 */
function ListBulkDecide({
  items,
  track,
  picked,
  setPicked,
  pickable,
}: {
  items: StandardCost[];
  track: 'fg' | 'material';
  picked: Set<number>;
  setPicked: (s: Set<number>) => void;
  pickable: (c: StandardCost) => boolean;
}) {
  const [mode, setMode] = useState<'' | 'reject'>('');
  const [note, setNote] = useState('');
  const [pending, start] = useTransition();
  const candidates = items.filter(pickable);
  const chosen = candidates.filter((c) => picked.has(c.id));
  const signOffs = items.filter((c) => c.neg_stage === 'rate_submitted').length;
  const noRate = items.filter((c) => c.neg_stage === 'proposed' && !pickable(c)).length;
  if (!candidates.length && !signOffs && !noRate) return null;
  const allPicked = candidates.length > 0 && chosen.length === candidates.length;

  function decide(decision: 'accept' | 'reject') {
    const fd = new FormData();
    fd.set('decision', decision);
    fd.set('ids', chosen.map((c) => `${track === 'material' ? 'm' : 'f'}${c.id}`).join(','));
    fd.set('note', note);
    start(async () => {
      const res = await decideCostsBulk(fd);
      if (!res.ok) toastError(res.error);
      else reloadWithToast(res.message ?? 'Done.');
    });
  }

  return (
    <div className="wf-queue-card wf-queue-card-wide sc-decision" style={{ margin: '12px 0' }}>
      <div className="wf-queue-head">
        <div>
          <h3>
            {candidates.length} proposal(s) waiting for your decision
            {signOffs ? ` · ${signOffs} actual rate(s) waiting for approval` : ''}
          </h3>
          <p className="wf-subtle">
            Tick the cards you want to decide together — a bar appears at the bottom to accept them as-is (the
            proposed rate becomes the standard cost) or reject them with one reason. Open Cost Details to set a target or decide one on its own.
            {noRate ? ` ${noRate} proposal(s) name no rate and need a target, not an acceptance.` : ''}
            {signOffs ? ' Those are approved on the product page (fabric rate first, then CMTP).' : ''}
          </p>
        </div>
        {candidates.length > 0 && (
          <button
            type="button"
            className="wf-btn wf-btn-ghost wf-btn-sm"
            onClick={() => setPicked(allPicked ? new Set() : new Set(candidates.map((c) => c.id)))}
          >
            {allPicked ? 'Untick all' : `Tick all to decide (${candidates.length})`}
          </button>
        )}
      </div>
      {chosen.length > 0 && (
        <div className="bp-bulk-bar" role="region" aria-label="Decide the ticked proposals">
          <span className="bp-bulk-count">
            <b>{chosen.length}</b> proposal{chosen.length === 1 ? '' : 's'} ticked
          </span>
          {mode === 'reject' ? (
            <>
              <input
                autoFocus
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Remark for Reject / Discard (required) — recorded on every ticked proposal"
                aria-label="Reason to reject the ticked proposals"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && note.trim()) decide('reject');
                  if (e.key === 'Escape') setMode('');
                }}
              />
              <button type="button" className="bp-bulk-btn strong" disabled={pending || !note.trim()} onClick={() => decide('reject')}>
                {pending ? 'Working…' : `Reject / Discard ${chosen.length}`}
              </button>
              <button type="button" className="bp-bulk-btn" disabled={pending} onClick={() => { setMode(''); setNote(''); }}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button type="button" className="bp-bulk-btn strong" disabled={pending} onClick={() => decide('accept')}>
                <Check size={13} /> {pending ? 'Working…' : `Approve ${chosen.length}`}
              </button>
              <button type="button" className="bp-bulk-btn" disabled={pending} onClick={() => setMode('reject')}>
                <X size={13} /> Reject / Discard
              </button>
              <button type="button" className="bp-bulk-btn" disabled={pending} onClick={() => setPicked(new Set())}>
                Clear
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
