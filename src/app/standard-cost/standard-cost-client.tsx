'use client';

import { Fragment, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { HeaderInfo } from '@/components/header-info';
import { reloadWithToast, toastError } from '@/lib/toast';
import { ChevronDown, Download, Lock, Plus, Search, Save, Trash2, X } from 'lucide-react';
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
  mergeTempProduct,
  type ActionResult,
} from '@/lib/forms/actions';
import {
  CMTP_HEADS,
  CMTP_MANDATORY,
  COST_STAGE_LABEL,
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
} from '@/lib/forms/cost';
import { canEdit } from '@/lib/forms/approval';
import { Field, Notice } from '@/components/forms/form-layout';
import { ProductPicker } from '@/components/forms/product-picker';
import type {
  CmtpComponent,
  CostStandards,
  EfobFabricCost,
  ProductCatalogItem,
  SdRole,
  StandardCost,
  StandardCostLine,
  StandardCostRateHistory,
} from '@/lib/forms/types';
import type { CmtpRevision } from '@/lib/standard-cost-revisions.server';
import type { TempProductInfo } from '@/lib/temp-product.server';
import { useColumnSort } from '@/lib/use-column-sort';

const disp = (v: number | null) => (v == null ? '—' : String(v));

/** Read-only fabric buildup referenced from the Fabric Cost master. */
type FabricBuildup = { grey: number | null; processing: number | null; finished: number | null };

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
  const addCloseRef = useRef<HTMLButtonElement>(null);
  const [newCode, setNewCode] = useState('');
  const [tempName, setTempName] = useState('');

  const signedOff = costs.filter((c) => c.neg_stage === 'signed_off' || c.status === 'approved').length;
  const undocumented = costs.filter((c) => !c.documented && c.neg_stage == null).length;
  const productNames = useMemo(
    () => new Map(catalog.map((item) => [item.product_code.toUpperCase(), item.product_name ?? ''])),
    [catalog],
  );

  // Rows waiting on the signed-in user's side of the negotiation.
  const [mineOnly, setMineOnly] = useState(false);
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
      if (!isMat && stageFilter !== 'all' && (c.neg_stage ?? 'not_started') !== stageFilter) return false;
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
      ['Product code', 'Product name', 'Stage', 'Proposed', 'Target', 'Job', 'FOB', 'E-FOB', 'Next step'],
      (isMat ? sort.apply(shown) : sortCards(shown)).map((c) => [
        c.product_code,
        productNames.get(c.product_code.toUpperCase()) ?? '',
        COST_STAGE_LABEL[c.neg_stage ?? ''] ?? c.neg_stage ?? 'Not started',
        c.proposed_cost,
        c.target_cost,
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
  function addTemp() {
    const name = tempName.trim();
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

  const addForm = editable ? (
    <div className="wf-form-panel">
      {isMat ? (
        <div className="wf-form-grid">
          <Field label={`Add a ${codeLabel.toLowerCase()}`} hint="seeds a row you can then propose">
            <input value={newCode} placeholder="e.g. TRM07" onChange={(e) => setNewCode(e.target.value)} />
          </Field>
          <button type="button" className="wf-btn wf-btn-primary" onClick={() => addCode(newCode)} disabled={pending}>
            <Plus size={15} /> Add to sheet
          </button>
        </div>
      ) : (
        <div className="wf-form-grid">
          <Field label="Add a product" hint="search by code or name — from the product master">
            <ProductPicker
              items={catalog}
              exclude={existingCodes}
              onPick={(code) => addCode(code)}
              disabled={pending}
              placeholder="Search product code or name…"
            />
          </Field>
          <Field label="…or a new product not in EasyEcom yet" hint="gets a temporary ID (TMP-…) you can merge later">
            <div className="wf-temp-add">
              <input
                value={tempName}
                placeholder="New product name"
                onChange={(e) => setTempName(e.target.value)}
              />
              <button
                type="button"
                className="wf-btn wf-btn-ghost wf-btn-sm"
                disabled={pending || !tempName.trim()}
                onClick={addTemp}
              >
                <Plus size={13} /> Create temporary
              </button>
            </div>
          </Field>
        </div>
      )}
    </div>
  ) : null;

  return (
    <>
      <Notice tone="info">
        Cost is <strong>negotiated</strong>, not just approved: team{' '}
        <strong>proposes</strong> (fill the {jobLabel} / {fobLabel} / {efobLabel} rate that
        applies) → Mahesh <strong>accepts the proposal as-is</strong>, <strong>rejects</strong> it, or
        sets a <strong>target</strong> → team returns with the <strong>actual vendor rate</strong> →
        Mahesh <strong>signs off</strong>, and that becomes the Standard Cost the Buying Plan values
        from. {signedOff} of {costs.length} {isMat ? 'materials' : 'products'} are signed off.
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

      {isMat && addForm}

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
        <span className="wf-subtle">{shown.length} shown</span>
      </div>

      {/* Material codes get the same cards as Finished Goods: code, what the material is,
          the three rates, then Cost Details. Rate entry happens on the code's own page. */}
      <div className="table-panel wf-grid-panel">
        <div className="sc-cards">
          {sortCards(shown).map((cost) => {
            const stageKey = cost.neg_stage ?? '';
            const latest = rateHistory[cost.product_code]?.[0] ?? null;
            const updated = shortDate(latest?.accepted_at ?? cost.updated_at);
            return (
              <article className="sc-card" key={cost.product_code}>
                <div className="sc-card-head">
                  <span className="mono sc-card-code">{cost.product_code}</span>
                  <span className={`wf-status tone-${COST_STAGE_TONE[stageKey] ?? 'purple'}`}>
                    {COST_STAGE_LABEL[stageKey] ?? 'Not started'}
                  </span>
                </div>
                <h3 className="sc-card-name">
                  {materialNames[cost.product_code.toUpperCase()] || (
                    <span className="wf-subtle">Not in the material master</span>
                  )}
                </h3>
                <div className="sc-card-rates">
                  <div><span>{fobLabel}</span><strong>{rateDisplay(cost.fob_cost)}</strong></div>
                  <div><span>{jobLabel}</span><strong>{rateDisplay(cost.job_cost)}</strong></div>
                  <div><span>{efobLabel}</span><strong>{rateDisplay(cost.efob_cost)}</strong></div>
                </div>
                <div className="sc-card-foot">
                  <Link className="wf-btn wf-btn-ghost wf-btn-sm sc-card-btn" href={`/standard-cost/${encodeURIComponent(cost.product_code)}?track=material`}>
                    Cost Details
                  </Link>
                  <small className="wf-subtle">
                    {updated ? `Cost updated ${updated}` : 'No cost recorded yet'}
                  </small>
                </div>
                <div className="sc-card-tags">
                  {cost.frozen && <span className="sc-card-frozen"><Lock size={11} /> Frozen</span>}
                </div>
              </article>
            );
          })}
          {!shown.length && (
            <p className="wf-empty-cell sc-cards-empty">No {codeLabel.toLowerCase()}s match these filters.</p>
          )}
        </div>
      </div>
        </>
      ) : (
        <div className="sc-fg">
          <div className="sc-fg-metrics" aria-label="Finished Goods cost overview">
            <div className="sc-fg-metric"><span>Products tracked</span><strong>{costs.length}</strong><small>Finished Goods cost records</small></div>
            <div className="sc-fg-metric"><span>Signed off</span><strong>{signedOff}</strong><small>Accepted standard rates</small></div>
            <div className="sc-fg-metric"><span>Needs my action</span><strong>{awaitingCount}</strong><small>{role === 'admin' ? 'Proposals and submitted rates' : 'Targets and revisions'}</small></div>
            <div className="sc-fg-metric"><span>Not documented</span><strong>{undocumented}</strong><small>Cost sheet to complete</small></div>
          </div>

          <section className="sc-fg-sheet" aria-label="Finished Goods cost sheet">
            <div className="sc-fg-sheet-head">
              <div><h2>Finished Goods cost sheet</h2><p>One card per product. Open Cost Details to see the full record and change a rate.</p></div>
              <div className="sc-fg-head-actions">
                <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={exportFinishedGoods}>
                  <Download size={14} /> Export CSV
                </button>
                {editable && <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" onClick={() => setAddOpen(true)}><Plus size={14} /> Add product</button>}
              </div>
            </div>
            <div className="sc-fg-toolbar">
              <label className="sc-fg-search"><Search size={15} aria-hidden="true" /><input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search product code or name" aria-label="Search product code or name" /></label>
              <select aria-label="Filter by stage" value={stageFilter} onChange={(e) => setStageFilter(e.target.value)}>
                <option value="all">All stages</option>
                <option value="not_started">Not started</option>
                <option value="proposed">Proposed</option>
                <option value="target_set">Target set</option>
                <option value="rate_submitted">Rate submitted</option>
                <option value="signed_off">Signed off</option>
                <option value="renegotiate">Renegotiate</option>
                <option value="rejected">Rejected</option>
              </select>
              <select
                aria-label="Sort products"
                value={cardSort}
                onChange={(e) => setCardSort(e.target.value as typeof cardSort)}
              >
                <option value="code">Sort: Product code</option>
                <option value="updated">Sort: Recently updated</option>
                <option value="stage">Sort: Stage</option>
                <option value="job">Sort: Job rate (high first)</option>
                <option value="fob">Sort: FOB rate (high first)</option>
                <option value="efob">Sort: E-FOB rate (high first)</option>
              </select>
              <div className="segment fb-seg" aria-label="Quick filter">
                <button type="button" className={!mineOnly ? 'active' : ''} aria-pressed={!mineOnly} onClick={() => setMineOnly(false)}>All products</button>
                <button type="button" className={mineOnly ? 'active' : ''} aria-pressed={mineOnly} onClick={() => setMineOnly(true)}>{role === 'admin' ? 'Needs approval' : 'Needs your input'} ({awaitingCount})</button>
              </div>
            </div>
            {/* One card per product: code, name, then the three rates side by side, the
                Cost Details link, and when the current cost was last accepted. Rate entry
                and the negotiation steps live on the product's own page, which is where a
                cost is actually worked out — the sheet is for scanning. */}
            <div className="sc-cards">
              {sortCards(shown).map((cost) => {
                const stageKey = cost.neg_stage ?? '';
                const latest = rateHistory[cost.product_code]?.[0] ?? null;
                const updated = shortDate(latest?.accepted_at ?? cost.updated_at);
                const temp = tempProducts[cost.product_code];
                return (
                  <article className="sc-card" key={cost.product_code}>
                    <div className="sc-card-head">
                      <span className="mono sc-card-code">{cost.product_code}</span>
                      <span className={`wf-status tone-${COST_STAGE_TONE[stageKey] ?? 'purple'}`}>
                        {COST_STAGE_LABEL[stageKey] ?? 'Not started'}
                      </span>
                    </div>
                    <h3 className="sc-card-name">
                      {productNames.get(cost.product_code.toUpperCase()) || temp?.name || (
                        <span className="wf-subtle">Product name unavailable</span>
                      )}
                    </h3>
                    <div className="sc-card-rates">
                      <div><span>Job</span><strong>{rateDisplay(cost.job_cost)}</strong></div>
                      <div><span>FOB</span><strong>{rateDisplay(cost.fob_cost)}</strong></div>
                      <div><span>E-FOB</span><strong>{rateDisplay(cost.efob_cost)}</strong></div>
                    </div>
                    <div className="sc-card-foot">
                      <Link className="wf-btn wf-btn-ghost wf-btn-sm sc-card-btn" href={`/standard-cost/${encodeURIComponent(cost.product_code)}`}>
                        Cost Details
                      </Link>
                      <small className="wf-subtle">
                        {updated ? `Cost updated ${updated}` : 'No cost recorded yet'}
                      </small>
                    </div>
                    <div className="sc-card-tags">
                      {temp?.status === 'active' && <span className="wf-temp-badge">TEMP</span>}
                      {cost.frozen && <span className="sc-card-frozen"><Lock size={11} /> Frozen</span>}
                      {!cost.documented && cost.neg_stage == null && (
                        <span className="wf-gap-tag">Undocumented</span>
                      )}
                    </div>
                  </article>
                );
              })}
              {!shown.length && (
                <p className="wf-empty-cell sc-cards-empty">No products match these filters.</p>
              )}
            </div>
            <div className="sc-fg-sheet-foot"><span>{shown.length} of {costs.length} products shown</span><span>Rates in ₹ per piece</span></div>
          </section>

          <div className="sc-fg-context">
            <div><h3>Two cost owners, one finished price</h3><p>Fabric Cost comes from Vikram ji&apos;s master. CMTP is built by Nimisha / Durganshu. Final Cost combines both with the Rules Master margin.</p></div>
            <div><h3>After sign-off</h3><p>The accepted Job, FOB, and E-FOB rates become the live standard for the Buying Plan. A new proposal starts a revision; first PO issuance freezes the record.</p></div>
          </div>
          {standards && <StandardFieldsPanel standards={standards} editable={editable} />}

          {addOpen && editable && (
            <div className="sc-fg-add-layer" role="presentation" onKeyDown={(e) => { if (e.key === 'Escape') setAddOpen(false); }}>
              <button type="button" className="sc-fg-scrim" onClick={() => setAddOpen(false)} aria-label="Close add product" />
              <div className="sc-fg-add-dialog" role="dialog" aria-modal="true" aria-labelledby="sc-fg-add-title">
                <div className="sc-fg-card-head"><h2 id="sc-fg-add-title">Add a product</h2><button type="button" className="sc-fg-close" ref={addCloseRef} onClick={() => setAddOpen(false)} aria-label="Close add product"><X size={18} /></button></div>
                <p>Choose an existing Product Master code or create a temporary product for an item not yet in EasyEcom.</p>
                {addForm}
              </div>
            </div>
          )}
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
  expanded,
  onToggle,
  temp,
  mergeCandidates = [],
  name,
}: {
  cost: StandardCost;
  role: SdRole;
  track: 'fg' | 'material';
  expanded?: boolean;
  onToggle?: () => void;
  /** Product name shown under the code (Finished Goods grid). */
  name?: string;
  /** Set when this product is a temporary (not-yet-in-EasyEcom) product. */
  temp?: TempProductInfo;
  /** Real product codes a temp can be merged into (admin). */
  mergeCandidates?: ProductCatalogItem[];
}) {
  const isMat = track === 'material';
  const jobLabel = isMat ? 'FOB Fabric' : 'Job';
  const fobLabel = isMat ? 'Billing' : 'FOB';
  const efobLabel = isMat ? 'Standard Fabric' : 'E-FOB';
  const stage = cost.neg_stage;
  const stageKey = stage ?? '';

  const [job, setJob] = useState(cost.job_cost?.toString() ?? '');
  const [fob, setFob] = useState(cost.fob_cost?.toString() ?? '');
  const [efob, setEfob] = useState(cost.efob_cost?.toString() ?? '');
  const [proposed, setProposed] = useState('');
  const [target, setTarget] = useState('');
  const [noteMode, setNoteMode] = useState<'renegotiate' | 'reject' | null>(null);
  const [note, setNote] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const canManageList = canEdit(role, 'draft');
  const isTemp = temp?.status === 'active';

  function mergeInto(realCode: string) {
    setErr(null);
    const fd = new FormData();
    fd.set('temp_code', cost.product_code);
    fd.set('real_code', realCode);
    start(async () => {
      const res = await mergeTempProduct(fd);
      if (res.ok) reloadWithToast(res.message);
      else {
        setErr(res.error);
        setMergeOpen(false);
      }
    });
  }

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
      else {
        setErr(res.error);
        setConfirmRemove(false);
      }
    });
  }

  // Rates are fillable both when the team proposes (so a proposal can name its PO
  // type) and when it later submits the actual vendor rate.
  const rateEditable = (canPropose(role, stage) || canSubmitRate(role, stage)) && !cost.frozen;

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

  const rateCell = (value: string, set: (v: string) => void) =>
    rateEditable ? (
      <input type="number" min={0} value={value} onChange={(e) => set(e.target.value)} />
    ) : (
      <span>{value === '' ? '—' : value}</span>
    );

  return (
    <tr className={expanded ? 'wf-cost-row-open' : undefined}>
      <td className="mono">
        <span className="wf-cost-code">
          {cost.product_code}
          {isTemp && (
            <span className="wf-temp-badge" title={temp?.name ? `Temporary product — ${temp.name}` : 'Temporary product — merge when it exists in EasyEcom'}>
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
        {/* Keep the four-tab detail trigger directly beneath the product name. */}
        {onToggle && (
          <button
            type="button"
            className="wf-cost-base-btn"
            aria-expanded={!!expanded}
            onClick={onToggle}
          >
            <svg className="wf-cost-base-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7h16M4 12h11M4 17h6" />
            </svg>
            <span>Cost Details</span>
            <ChevronDown className="wf-cost-base-chevron" size={14} aria-hidden="true" />
          </button>
        )}
        {!isMat && !cost.documented && stage == null && (
          <span className="wf-gap-tag">Undocumented — data gap</span>
        )}
      </td>
      <td className="num">{disp(cost.proposed_cost)}</td>
      <td className="num">{disp(cost.target_cost)}</td>
      {isMat ? (
        <>
          {/* Billing (fob_cost) · FOB Fabric (job_cost) · Standard Fabric (efob_cost) */}
          <td className="num input-col">{rateCell(fob, setFob)}</td>
          <td className="num input-col">{rateCell(job, setJob)}</td>
          <td className="num input-col">{rateCell(efob, setEfob)}</td>
        </>
      ) : (
        <>
          <td className="num input-col">{rateCell(job, setJob)}</td>
          <td className="num input-col">{rateCell(fob, setFob)}</td>
          <td className="num input-col">{rateCell(efob, setEfob)}</td>
        </>
      )}
      <td>
        <span className={`wf-status tone-${COST_STAGE_TONE[stageKey]}`}>
          {COST_STAGE_LABEL[stageKey]}
        </span>
        <small className="wf-subtle">{nextActor(stage)}</small>
        {stage === 'rejected' && cost.rejection_notes && (
          <small className="wf-subtle">{cost.rejection_notes}</small>
        )}
        {stage === 'renegotiate' && cost.negotiation_notes && (
          <small className="wf-subtle">{cost.negotiation_notes}</small>
        )}
      </td>
      <td>
        <div className="wf-cost-actions">
          {err && <small className="wf-line-error">{err}</small>}

          {isTemp && role === 'admin' && (
            mergeOpen ? (
              <span className="wf-issue-row wf-issue-row-wrap">
                <small className="wf-subtle">Merge into the real product now in EasyEcom:</small>
                <ProductPicker
                  items={mergeCandidates}
                  onPick={(code) => mergeInto(code)}
                  disabled={busy}
                  placeholder="Search the real product code…"
                />
                <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={busy} onClick={() => setMergeOpen(false)}>
                  Cancel
                </button>
              </span>
            ) : (
              <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={busy} onClick={() => setMergeOpen(true)}>
                Merge…
              </button>
            )
          )}

          {canManageList && (
            confirmRemove ? (
              <span className="wf-issue-row">
                <small className="wf-subtle">Remove from list? Data &amp; history are kept.</small>
                <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={busy} onClick={remove}>
                  {busy ? 'Removing…' : 'Remove'}
                </button>
                <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={busy} onClick={() => setConfirmRemove(false)}>
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="wf-icon-btn"
                aria-label="Remove from list (data kept — search and add again to restore)"
                title="Remove from list — data & history kept; add it again to restore"
                onClick={() => setConfirmRemove(true)}
              >
                <Trash2 size={13} />
              </button>
            )
          )}

          {canPropose(role, stage) && !cost.frozen && (
            <div className="wf-issue-row wf-issue-row-wrap">
              <input
                className="wf-mini-input"
                type="number"
                min={0}
                placeholder="expected (optional)"
                value={proposed}
                onChange={(e) => setProposed(e.target.value)}
              />
              <button
                type="button"
                className="wf-btn wf-btn-primary wf-btn-sm"
                disabled={busy}
                title={`Fill the ${jobLabel} / ${fobLabel} / ${efobLabel} rate(s) that apply on this row, then Propose. The expected figure is optional.`}
                onClick={() =>
                  act(proposeCost, {
                    proposed_cost: proposed,
                    job_cost: job,
                    fob_cost: fob,
                    efob_cost: efob,
                  })
                }
              >
                Propose
              </button>
            </div>
          )}

          {canSetTarget(role, stage) && (
            <div className="wf-issue-row wf-issue-row-wrap">
              {canAcceptProposal(role, stage) && (
                <button
                  type="button"
                  className="wf-btn wf-btn-primary wf-btn-sm"
                  disabled={busy}
                  title="Approve the proposed rates as-is — they become the standard cost"
                  onClick={() => act(acceptProposedCost, {})}
                >
                  Accept proposal
                </button>
              )}
              <input
                className="wf-mini-input"
                type="number"
                min={0}
                placeholder="target"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              />
              <button
                type="button"
                className="wf-btn wf-btn-ghost wf-btn-sm"
                disabled={busy}
                onClick={() => act(setTargetCost, { target_cost: target })}
              >
                Set target
              </button>
              <button
                type="button"
                className="wf-btn wf-btn-ghost wf-btn-sm"
                onClick={() => setNoteMode('reject')}
              >
                Reject
              </button>
            </div>
          )}

          {canSubmitRate(role, stage) && (
            <button
              type="button"
              className="wf-btn wf-btn-primary wf-btn-sm"
              disabled={busy}
              onClick={() =>
                act(submitActualRate, {
                  job_cost: job,
                  fob_cost: fob,
                  efob_cost: efob,
                })
              }
            >
              <Save size={13} /> Submit rate
            </button>
          )}

          {canSignOff(role, stage) && (
            <div className="wf-issue-row">
              {isMat ? (
                <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={busy} onClick={() => act(signOffCost, {})}>
                  Sign off
                </button>
              ) : canConfirmFabric(role, stage, !!cost.fabric_confirmed_at) ? (
                <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={busy} onClick={() => act(confirmFabricRate, {})}>
                  1 · Confirm fabric rate
                </button>
              ) : canConfirmCm(role, stage, !!cost.fabric_confirmed_at, !!cost.cm_confirmed_at) ? (
                <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={busy} onClick={() => act(confirmCmRate, {})}>
                  2 · Confirm CMTP → sign off
                </button>
              ) : null}
              {!isMat && cost.fabric_confirmed_at && !cost.cm_confirmed_at && (
                <span className="wf-tag-approved">fabric ✓</span>
              )}
              {canRenegotiate(role, stage) && (
                <button
                  type="button"
                  className="wf-btn wf-btn-ghost wf-btn-sm"
                  onClick={() => setNoteMode('renegotiate')}
                >
                  Renegotiate
                </button>
              )}
              {canRejectCost(role, stage) && (
                <button
                  type="button"
                  className="wf-btn wf-btn-ghost wf-btn-sm"
                  onClick={() => setNoteMode('reject')}
                >
                  Reject
                </button>
              )}
            </div>
          )}

          {noteMode && (
            <div className="wf-issue-row">
              <input
                className="wf-mini-input"
                placeholder={`${noteMode} reason`}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <button
                type="button"
                className="wf-btn wf-btn-primary wf-btn-sm"
                disabled={busy || !note.trim()}
                onClick={() =>
                  act(noteMode === 'reject' ? rejectCost : renegotiateCost, { note })
                }
              >
                Confirm
              </button>
              <button
                type="button"
                className="wf-btn wf-btn-ghost wf-btn-sm"
                onClick={() => {
                  setNoteMode(null);
                  setNote('');
                }}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

const SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'] as const;
const numv = (s: string) => Number(s) || 0;

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
 *   • Fabric Cost — referenced read-only from the Fabric Cost master (Vikram ji);
 *     per-size fabric cost = finished-fabric rate × consumption(size).
 *   • CMTP — the CMTP breakdown tab (Nimisha / Durganshu).
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
}) {
  const [view, setView] = useState<'cmtp' | 'fabric' | 'final' | 'history'>('cmtp');
  // Default the fabric from Product Master when the sheet hasn't set one and the
  // product maps to a single fabric; multi-fabric products stay blank for manual pick.
  const autoFabric = masterFabric && !masterFabric.multi ? masterFabric.fabricCode ?? '' : '';
  const [fabricCode, setFabricCode] = useState(cost.fabric_code ?? autoFabric);
  const fabricFromMaster = !cost.fabric_code && !!autoFabric && fabricCode === autoFabric;
  const [consBySize, setConsBySize] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    for (const l of lines) {
      if (l.size && l.consumption != null) m[l.size.toUpperCase()] = String(l.consumption);
    }
    return m;
  });
  const [cad, setCad] = useState(cost.cad_link ?? '');
  const [rfp, setRfp] = useState(cost.rfp_link ?? '');
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const fab = fabricCode ? fabricBase[fabricCode] : undefined;
  const fabricRate = fab?.finished ?? null;
  const cmtpTotal = cost.cm_cost; // FINAL CMTP owned by the CMTP tab

  // Per-size buildup: fabric = rate × consumption; garment = fabric + CMTP; then
  // the FINAL PRICE chain.
  const rows = SIZES.map((size) => {
    const cons = consBySize[size] ?? '';
    const has = cons !== '';
    const fabric = has && fabricRate != null ? r2(fabricRate * numv(cons)) : null;
    const garment = fabric != null && cmtpTotal != null ? r2(fabric + cmtpTotal) : null;
    const f = garment != null ? buildFinal(garment, marginPct) : null;
    return {
      size,
      cons,
      has,
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

  // Both the Fabric and Final tabs persist the same record (fabric link, per-size
  // consumption, doc links, and the computed PO-average final price).
  function save() {
    setErr(null);
    const header = new FormData();
    header.set('product_code', cost.product_code);
    header.set('fabric_code', fabricCode);
    header.set('cad_link', cad);
    header.set('rfp_link', rfp);
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
          <button type="button" className={view === 'final' ? 'active' : ''} onClick={() => setView('final')}>Final Cost</button>
          <button type="button" className={view === 'history' ? 'active' : ''} onClick={() => setView('history')}>
            Rate History{history.length > 0 ? ` (${history.length})` : ''}
          </button>
        </div>
        <span className="wf-subtle wf-two-entity-note">
          Final = Fabric + CMTP (computed). Two owners: Fabric — Vikram ji · CMTP — Nimisha / Durganshu.
        </span>
      </div>

      {view === 'cmtp' ? (
        <CmtpBreakdown cost={cost} cmtp={cmtp} subitems={cmtpSubitems} editable={editable} />
      ) : view === 'fabric' ? (
        <div className="wf-fabric-view">
          <div className="wf-form-grid">
            <label className="field wf-field">
              <span>
                Fabric
                <small>
                  {fabricFromMaster
                    ? 'defaulted from Product Master — change if needed'
                    : masterFabric?.multi
                      ? 'multi-fabric product — pick the fabric manually'
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
          </div>

          <div className="wf-cost-param">
            <span className="wf-cost-param-head">Fabric Cost — owned by the Fabric Cost master (Vikram ji)</span>
            <dl className="wf-doc-meta">
              <div><dt>Grey rate</dt><dd className="wf-cell-input">{disp(fab?.grey ?? null)}</dd></div>
              <div><dt>Processing</dt><dd className="wf-cell-input">{disp(fab?.processing ?? null)}</dd></div>
              <div><dt>Finished fabric (INR/mtr)</dt><dd className="wf-cell-calc">{disp(fab?.finished ?? null)}</dd></div>
            </dl>
            <a className="wf-btn wf-btn-ghost wf-btn-sm" href="/fabric-cost">Edit on Fabric Cost →</a>
          </div>

          {/* Three columns stretched across a wide panel left huge empty gaps between the
              size and its consumption, and pushed nine sizes into a tall scroll. One tile per
              size instead: the sizes sit side by side and the whole size run is visible. */}
          <div className="wf-size-grid" role="group" aria-label="Consumption and fabric cost by size">
            {rows.map((r) => (
              <div className="wf-size-tile" key={r.size}>
                <span className="wf-size-name">{r.size}</span>
                <label className="wf-size-field">
                  <span>Consumption (mtr)</span>
                  <input
                    className="wf-cell-input"
                    type="number"
                    min={0}
                    step="0.01"
                    value={r.cons}
                    disabled={!editable}
                    onChange={(e) => setCons(r.size, e.target.value)}
                  />
                </label>
                <div className="wf-size-calc">
                  <span>Fabric cost*</span>
                  <strong className="wf-cell-calc">{disp(r.fabric)}</strong>
                </div>
              </div>
            ))}
          </div>
          <p className="wf-subtle wf-legend">
            <span className="wf-legend-input">input</span>
            <span className="wf-legend-calc">computed</span>
            — fabric cost = finished-fabric rate × consumption. The rate is owned by the Fabric Cost master.
            {fabricRate == null && ' Pick a fabric with a finished rate to compute.'}
          </p>

          {editable && (
            <div className="wf-cost-detail-foot">
              <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" onClick={save} disabled={busy}>
                <Save size={13} /> {busy ? 'Saving…' : 'Save fabric cost'}
              </button>
            </div>
          )}
        </div>
      ) : view === 'final' ? (
        <div className="wf-final-view">
          <div className="table-scroll">
            <table className="wf-grid wf-cost-lines">
              <thead>
                <tr>
                  <th>Size <HeaderInfo label="Size" /></th>
                  <th className="num wf-cell-calc">Fabric <HeaderInfo label="Fabric" /></th>
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
                    <td className="num wf-cell-calc">{disp(r.fabric)}</td>
                    <td className="num wf-cell-calc">{disp(cmtpTotal)}</td>
                    <td className="num wf-cell-calc">{disp(r.garment)}</td>
                    <td className="num wf-cell-calc">{disp(r.margin)}</td>
                    <td className="num strong wf-cell-calc">{disp(r.final)}</td>
                  </tr>
                ))}
                {!filled.length && (
                  <tr><td colSpan={6} className="wf-empty-cell">Fill fabric consumption (Fabric Cost tab) + CMTP to compute the final price.</td></tr>
                )}
              </tbody>
              {poAvgFinal != null && (
                <tfoot><tr><td colSpan={5}>PO AVG final price</td><td className="num strong wf-cell-calc">{poAvgFinal}</td></tr></tfoot>
              )}
            </table>
          </div>
          <p className="wf-subtle">
            Final price = Garment (Fabric + CMTP) + Margin {r2(marginPct * 100)}% (set in Rules Master).
            {cmtpTotal == null && ' · CMTP not filled yet — fill the CMTP tab.'}
          </p>

          <div className="wf-form-grid">
            <Field label="CAD link"><input value={cad} disabled={!editable} placeholder="https://…" onChange={(e) => setCad(e.target.value)} /></Field>
            <Field label="RFP link"><input value={rfp} disabled={!editable} placeholder="https://…" onChange={(e) => setRfp(e.target.value)} /></Field>
          </div>

          {editable && (
            <div className="wf-cost-detail-foot">
              <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" onClick={save} disabled={busy}>
                <Save size={13} /> {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          )}
        </div>
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
                <tr><td colSpan={6} className="wf-empty-cell">No accepted rate yet — this product has not been signed off.</td></tr>
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
 * CMTP cost breakdown — the CM cost built from category heads (§1 of the spec).
 * The 6 core heads always render; the team adds line items (sub-tabs) under any
 * head, and can add custom heads ad hoc. The sum of all amounts is the CM cost,
 * saved onto the product's standard-cost row.
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
  // Local, extendable copy of the sub-item master so a newly-added name appears
  // in every dropdown for its head immediately (the server revalidates too).
  const [subs, setSubs] = useState<Record<string, string[]>>(subitems);
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [newSub, setNewSub] = useState('');
  const [subBusy, startSub] = useTransition();

  // Options for a head's dropdown: the master list, plus the row's own legacy
  // free-typed value if it predates the master (so it still shows and can be kept).
  const optionsFor = (cat: string, current: string) => {
    const list = subs[cat] ?? [];
    return current && !list.includes(current) ? [current, ...list] : list;
  };

  function addSubitem(cat: string) {
    const name = newSub.trim();
    if (!name) return;
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
        setNewSub('');
        setAddingFor(null);
      }
    });
  }
  const [rows, setRows] = useState<CmtpRow[]>(() =>
    cmtp.length
      ? cmtp.map((c) => ({
          uid: nextCmtpUid(),
          category: c.category,
          label: c.label ?? '',
          amount: c.amount != null ? String(c.amount) : '',
        }))
      : // No breakdown yet — seed the mandatory heads with one blank line each.
        CMTP_HEADS.map((h) => ({ uid: nextCmtpUid(), category: h.key, label: '', amount: '' })),
  );
  const [newHead, setNewHead] = useState('');
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  // Item 2 — a revision reason is mandatory when an EXISTING breakdown's amounts
  // change (not on first entry). Snapshot the amounts as loaded, keyed by head+sub.
  const [reason, setReason] = useState('');
  const hadData = cmtp.length > 0;
  // Keys carry an occurrence index so a duplicated head+sub-item counts as a
  // second line (mirrors the server diff) — otherwise a duplicate slips through
  // as "unchanged" while doubling the CM total.
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
    () => keyed(cmtp.map((c) => ({ category: c.category, label: c.label, amount: c.amount != null ? String(c.amount) : '' }))),
    [cmtp],
  );
  const isRevision = useMemo(() => {
    if (!hadData) return false;
    const now = keyed(
      rows.filter((r) => r.category && (r.label || r.amount)).map((r) => ({ category: r.category, label: r.label, amount: r.amount })),
    );
    if (now.size !== initialAmts.size) return true;
    for (const [k, v] of now) {
      const old = initialAmts.get(k);
      if (old === undefined) return true;
      if (Math.abs((numv(v) || 0) - (numv(old) || 0)) >= 0.005) return true;
    }
    return false;
  }, [rows, initialAmts, hadData]);

  // Head order: the 6 mandatory heads first, then any custom heads present.
  const categories = useMemo(() => {
    const order = [...CMTP_MANDATORY];
    for (const r of rows) if (!order.includes(r.category)) order.push(r.category);
    return order;
  }, [rows]);

  const total = rows.reduce((s, r) => s + (numv(r.amount) || 0), 0);

  const addRow = (category: string, label = '') =>
    setRows((cur) => [...cur, { uid: nextCmtpUid(), category, label, amount: '' }]);
  const removeRow = (u: number) => setRows((cur) => cur.filter((r) => r.uid !== u));
  const patchRow = (u: number, key: 'label' | 'amount', value: string) =>
    setRows((cur) => cur.map((r) => (r.uid === u ? { ...r, [key]: value } : r)));

  function addHead() {
    const c = newHead.trim();
    if (c && !rows.some((r) => r.category === c)) addRow(c);
    setNewHead('');
  }

  function save() {
    setErr(null);
    if (isRevision && !reason.trim()) {
      setErr('Enter a reason for this revision — it is logged against the changed line(s) in the rate history.');
      return;
    }
    const fd = new FormData();
    fd.set('product_code', cost.product_code);
    fd.set(
      'components',
      JSON.stringify(rows.map((r) => ({ category: r.category, label: r.label, amount: r.amount }))),
    );
    if (isRevision) fd.set('revision_reason', reason.trim());
    start(async () => {
      const res = await saveCmtpComponents(fd);
      if (res.ok) {
        setReason('');
        reloadWithToast(res.message ?? 'Saved.');
      } else setErr(res.error);
    });
  }

  return (
    <div className="wf-cmtp">
      {err && <Notice tone="error">{err}</Notice>}
      <p className="wf-subtle">
        CMTP cost is built from these heads — the total below is the product&rsquo;s FINAL CMTP. The
        core heads are mandatory; add lines under a head, or a whole head, as the product needs
        (e.g. buttoning under Product Trims for shirts).
      </p>

      {/* Heads tile across the full panel width. Stacked in one narrow column they left
          the right half of the screen empty and pushed Finishing below the fold. */}
      <div className="wf-cmtp-heads">
      {categories.map((cat) => {
        const head = CMTP_HEADS.find((h) => h.key === cat);
        const catRows = rows.filter((r) => r.category === cat);
        const sub = catRows.reduce((s, r) => s + (numv(r.amount) || 0), 0);
        const mandatory = CMTP_MANDATORY.includes(cat);
        return (
          <div key={cat} className="wf-cmtp-head">
            <div className="wf-cmtp-head-row">
              <span className="wf-cmtp-head-name">
                {head?.label ?? cat}
                {mandatory && <small className="wf-subtle"> · required</small>}
              </span>
              <span className="wf-cmtp-sub wf-cell-calc">{sub || '—'}</span>
            </div>
            {catRows.map((r) => (
              <div key={r.uid} className="wf-cmtp-line">
                {/* Sub-item is picked from the managed master (per head), not
                    free-typed — so the same sub-item can't get two spellings. */}
                <select
                  className="wf-cmtp-label"
                  value={r.label}
                  disabled={!editable}
                  onChange={(e) => patchRow(r.uid, 'label', e.target.value)}
                >
                  <option value="">— sub-item —</option>
                  {optionsFor(cat, r.label).map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <input
                  className="wf-cmtp-amt"
                  type="number"
                  min={0}
                  placeholder="amount"
                  value={r.amount}
                  disabled={!editable}
                  onChange={(e) => patchRow(r.uid, 'amount', e.target.value)}
                />
                {editable && (
                  <button
                    type="button"
                    className="wf-icon-btn"
                    aria-label="Remove line"
                    onClick={() => removeRow(r.uid)}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            ))}
            {editable && (
              <div className="wf-cmtp-add">
                <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => addRow(cat)}>
                  <Plus size={12} /> Add line
                </button>
                {addingFor === cat ? (
                  <span className="wf-cmtp-newsub">
                    <input
                      placeholder="New sub-item name"
                      value={newSub}
                      disabled={subBusy}
                      autoFocus
                      onChange={(e) => setNewSub(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); addSubitem(cat); }
                        if (e.key === 'Escape') { setAddingFor(null); setNewSub(''); }
                      }}
                    />
                    <button
                      type="button"
                      className="wf-btn wf-btn-primary wf-btn-sm"
                      disabled={subBusy || !newSub.trim()}
                      onClick={() => addSubitem(cat)}
                    >
                      {subBusy ? 'Adding…' : 'Add to master'}
                    </button>
                    <button
                      type="button"
                      className="wf-btn wf-btn-ghost wf-btn-sm"
                      disabled={subBusy}
                      onClick={() => { setAddingFor(null); setNewSub(''); }}
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="wf-chip-btn"
                    onClick={() => { setAddingFor(cat); setNewSub(''); }}
                  >
                    <Plus size={12} /> New sub-item
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
      </div>

      {editable && (
        <div className="wf-cmtp-newhead">
          <input
            placeholder="Add a head (e.g. Embroidery)"
            value={newHead}
            onChange={(e) => setNewHead(e.target.value)}
          />
          <button
            type="button"
            className="wf-btn wf-btn-ghost wf-btn-sm"
            disabled={!newHead.trim()}
            onClick={addHead}
          >
            <Plus size={12} /> Add head
          </button>
        </div>
      )}

      <div className="wf-cmtp-total">
        <span>FINAL CMTP cost</span>
        <strong className="wf-cell-calc">{total || '—'}</strong>
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
