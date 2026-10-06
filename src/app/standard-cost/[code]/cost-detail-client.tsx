'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { HeaderInfo } from '@/components/header-info';
import Link from 'next/link';
import { ArrowLeft, Link2, Lock, Pencil, Trash2, X } from 'lucide-react';
import { ProductPicker } from '@/components/forms/product-picker';
import { deleteUnlinkedProduct, linkProductToEasyEcom, setTargetCost } from '@/lib/forms/actions';
import { emitToast, reloadWithToast, toastError } from '@/lib/toast';
import { COST_STAGE_LABEL, COST_STAGE_TONE, RATE_LABELS, canSetTarget, nextActor, type RateKey as PriceKey } from '@/lib/forms/cost';
import { targetFields } from '@/components/forms/target-inputs';
import { canEdit } from '@/lib/forms/approval';
import { CostRow, CostDetail, RateHistoryPanel } from '../standard-cost-client';
import { CostDecisionBar } from '@/components/forms/cost-decision-bar';
import type {
  CmtpComponent,
  ProductCatalogItem,
  SdRole,
  StandardCost,
  StandardCostExtraFabric,
  StandardCostLine,
  StandardCostRateHistory,
} from '@/lib/forms/types';
import type { TempProductInfo } from '@/lib/temp-product.server';
import type { CmtpRevision } from '@/lib/standard-cost-revisions.server';

/** Mirrors the fabric buildup shape the cost sheet passes down. */
type FabricBuildup = { grey: number | null; processing: number | null; finished: number | null };

const money = (v: number | null) =>
  v == null ? '—' : `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(v)}`;

const longDate = (iso: string | null) =>
  !iso
    ? null
    : new Date(iso).toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'Asia/Kolkata',
      });

/**
 * Full record for one product. Reached from the "Cost Details" button on a card, so it is a
 * real page with its own URL — the back button works and the link can be shared.
 *
 * Editing is deliberately behind a button. The page is read first: what the rates are, when
 * they were last accepted, what the cost is built from. "Edit cost" reveals the SAME
 * negotiation row the sheet uses, so propose → target → actual rate → sign-off runs through
 * the existing approval process untouched.
 */
export function StandardCostDetailClient({
  cost,
  productName,
  lines,
  cmtp,
  cmtpSubitems,
  fabricBase,
  fabricCodes,
  history,
  revisions,
  masterFabric,
  temp,
  catalog,
  costByCode = {},
  linkedFrom = [],
  role,
  marginPct,
  track = 'fg',
  extraFabrics = [],
}: {
  cost: StandardCost;
  productName: string | null;
  lines: StandardCostLine[];
  extraFabrics?: StandardCostExtraFabric[];
  cmtp: CmtpComponent[];
  cmtpSubitems: Record<string, string[]>;
  fabricBase: Record<string, FabricBuildup>;
  fabricCodes: string[];
  history: StandardCostRateHistory[];
  revisions: CmtpRevision[];
  masterFabric: { fabricCode: string | null; multi: boolean } | null;
  temp?: TempProductInfo;
  catalog: ProductCatalogItem[];
  /** Every costed product's rates, so linking into one that already has a cost can offer a merge. */
  costByCode?: Record<string, CostSummary>;
  /** Codes that were linked INTO this EasyEcom product earlier (offers "Change linked product"). */
  linkedFrom?: string[];
  role: SdRole;
  marginPct: number;
  track?: 'fg' | 'material';
}) {
  const [editing, setEditing] = useState(false);
  const stageKey = cost.neg_stage ?? '';
  const latest = history[0] ?? null;
  const updatedOn = longDate(latest?.accepted_at ?? cost.updated_at);
  const rateEditable = !cost.frozen && canEdit(role, 'draft');
  // Nothing on this page is editable until "Edit cost" is pressed. Reading a cost record and
  // changing one are different jobs, and a page full of live inputs invites the accidental
  // edit. The role/frozen check still applies on top: pressing the button cannot grant rights.
  const canChange = editing && rateEditable;
  const isMat = track === 'material';
  // Material relabels the three rate slots; the underlying columns are the same.
  const rateLabels = isMat
    ? { job: 'FOB Fabric', fob: 'Billing', efob: 'Standard Fabric' }
    : { job: 'Job', fob: 'FOB', efob: 'E-FOB' };
  const backHref = isMat ? '/standard-cost?track=material' : '/standard-cost';

  return (
    <div className="sc-page">
      <div className="sc-page-bar">
        <Link href={backHref} className="sc-page-back">
          <ArrowLeft size={15} /> {isMat ? 'All materials' : 'All products'}
        </Link>
        <span className={`wf-status tone-${COST_STAGE_TONE[stageKey] ?? 'purple'}`}>
          {COST_STAGE_LABEL[stageKey] ?? 'Not started'}
        </span>
        {cost.frozen && (
          <span className="sc-page-frozen">
            <Lock size={12} /> Frozen{cost.frozen_at ? ` · ${longDate(cost.frozen_at)}` : ''}
          </span>
        )}
      </div>

      <header className="sc-page-head">
        <div className="sc-page-title">
          <span className="mono sc-page-code">{cost.product_code}</span>
          <h1>
            {productName ||
              temp?.name ||
              (isMat ? 'Not in the material master' : 'Product name unavailable')}
          </h1>
          <p className="wf-subtle">
            {nextActor(cost.neg_stage)}
            {updatedOn ? ` · Current cost updated ${updatedOn}` : ''}
          </p>
        </div>
        <button
          type="button"
          className={`wf-btn ${editing ? 'wf-btn-ghost' : 'wf-btn-primary'}`}
          onClick={() => setEditing((v) => !v)}
          title={
            rateEditable
              ? 'Change the rates and move the product through its approval process'
              : 'Open the negotiation controls — some actions need a different role or an unfrozen product'
          }
        >
          {editing ? <X size={15} /> : <Pencil size={15} />}
          {editing ? 'Close editing' : 'Edit cost'}
        </button>
      </header>

      {!isMat && !catalog.some((p) => p.product_code.toUpperCase() === cost.product_code.toUpperCase()) ? (
        <LinkPanel
          cost={cost}
          mode="unlinked"
          role={role}
          candidates={catalog}
          costByCode={costByCode}
          tempName={temp?.name ?? null}
          linkedFrom={[]}
        />
      ) : !isMat && linkedFrom.length > 0 && role === 'admin' ? (
        <LinkPanel
          cost={cost}
          mode="relink"
          role={role}
          candidates={catalog}
          costByCode={costByCode}
          tempName={null}
          linkedFrom={linkedFrom}
        />
      ) : null}

      <PriceGrid cost={cost} role={role} track={isMat ? 'material' : 'fg'} money={money} />

      {/* The approver decides here, without opening the editor. Renders nothing when the
          signed-in role has no decision to make at this stage. */}
      <CostDecisionBar cost={cost} role={role} track={isMat ? 'material' : 'fg'} targetInGrid />

      {editing && (
        <section className="sc-page-edit" aria-label="Change the cost">
          <div className="sc-page-edit-head">
            <h2>Change the cost</h2>
            <p className="wf-subtle">
              Fill the rate(s) that apply and propose. The product then follows its usual path:
              the approver accepts the proposal or sets a target, the team returns with the actual
              vendor rate, and sign-off makes it the standard the Buying Plan values from.
            </p>
          </div>
          <div className="table-scroll">
            <table className="wf-grid wf-cost-sheet">
              <thead>
                <tr>
                  <th>Product <HeaderInfo label="Product" /></th>
                  <th className="num">Proposed <HeaderInfo label="Proposed" /></th>
                  <th className="num">Target <HeaderInfo label="Target" /></th>
                  {isMat ? (
                    <>
                      <th className="num input-col">{rateLabels.fob} rate <HeaderInfo label="rate" /></th>
                      <th className="num input-col">{rateLabels.job} rate <HeaderInfo label="rate" /></th>
                    </>
                  ) : (
                    <>
                      <th className="num input-col">{rateLabels.job} rate <HeaderInfo label="rate" /></th>
                      <th className="num input-col">{rateLabels.fob} rate <HeaderInfo label="rate" /></th>
                    </>
                  )}
                  <th className="num input-col">{rateLabels.efob} rate <HeaderInfo label="rate" /></th>
                  <th>Stage <HeaderInfo label="Stage" /></th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                <CostRow
                  cost={cost}
                  role={role}
                  track={track}
                  temp={temp}
                  name={productName || undefined}
                />
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="sc-page-detail" aria-label="Cost record">
        <p className="sc-page-mode">
          {canChange
            ? isMat
              ? 'Editing — propose a rate above. Material rates have no cost sheet to fill in.'
              : 'Editing — change the cost sheet below, then save. Rate changes go through approval.'
            : editing && !rateEditable
              ? cost.frozen
                ? 'Read only — this product is frozen because a PO has been issued against it.'
                : 'Read only — your role cannot change this cost.'
              : isMat
                ? 'Read only. Press Edit cost to propose a new rate.'
                : 'Read only. Press Edit cost to change the cost sheet.'}
        </p>
        {isMat ? (
          <div className="wf-cost-detail">
            <RateHistoryPanel history={history} hideRevisions rateLabels={rateLabels} />
          </div>
        ) : (
        <CostDetail
          cost={cost}
          lines={lines}
          cmtp={cmtp}
          cmtpSubitems={cmtpSubitems}
          fabricBase={fabricBase}
          fabricCodes={fabricCodes}
          history={history}
          revisions={revisions}
          masterFabric={masterFabric}
          editable={canChange}
          marginPct={marginPct}
          extraFabrics={extraFabrics}
        />
        )}
      </section>
    </div>
  );
}

/** The cost figures the merge panel compares, for a product that already has a cost. */
export type CostSummary = {
  job_cost: number | null;
  fob_cost: number | null;
  efob_cost: number | null;
  neg_stage: string | null;
  frozen: boolean;
};

const RATE_FIELDS = [
  { key: 'job_cost', label: 'Job' },
  { key: 'fob_cost', label: 'FOB' },
  { key: 'efob_cost', label: 'E-FOB' },
] as const;
type RateKey = (typeof RATE_FIELDS)[number]['key'];

const rateText = (v: number | null) => (v == null ? '' : String(Number(v)));

/**
 * Link this product's cost to an EasyEcom product. Three cases, one flow:
 *  - a product not in EasyEcom (TMP-xxxx) is linked to its EasyEcom code;
 *  - a product linked earlier is re-linked to a different EasyEcom code (to fix a wrong link);
 *  - when the EasyEcom product already has its own cost, the two are MERGED: both sets of rates
 *    side by side, the admin picks a side or types a value per rate and chooses whose cost
 *    sheet stays. The chosen rates become the accepted standard.
 * Delete is offered only for a product not in EasyEcom. Everything is checked again in the
 * database (sd_link_product / sd_delete_unlinked_product).
 */
function LinkPanel({
  cost,
  mode,
  role,
  candidates,
  costByCode,
  tempName,
  linkedFrom,
}: {
  cost: StandardCost;
  /** 'unlinked' = not in EasyEcom; 'relink' = an EasyEcom product that was linked into. */
  mode: 'unlinked' | 'relink';
  role: SdRole;
  candidates: ProductCatalogItem[];
  costByCode: Record<string, CostSummary>;
  tempName: string | null;
  linkedFrom: string[];
}) {
  const router = useRouter();
  const code = cost.product_code;
  const [step, setStep] = useState<'idle' | 'pick' | 'merge' | 'delete'>('idle');
  const [target, setTarget] = useState<string | null>(null);
  const [rates, setRates] = useState<Record<RateKey, string>>({ job_cost: '', fob_cost: '', efob_cost: '' });
  const [sheet, setSheet] = useState<'to' | 'from'>('to');
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const isAdmin = role === 'admin';
  const canDelete = mode === 'unlinked' && canEdit(role, 'draft');
  const other = target ? costByCode[target.toUpperCase()] ?? null : null;
  const pool = candidates.filter((p) => p.product_code.toUpperCase() !== code.toUpperCase());

  function choose(realCode: string) {
    setErr(null);
    const up = realCode.toUpperCase();
    setTarget(up);
    const existing = costByCode[up];
    if (existing) {
      // Start from the EasyEcom product's own rates; the admin switches or types per rate.
      setRates({
        job_cost: rateText(existing.job_cost),
        fob_cost: rateText(existing.fob_cost),
        efob_cost: rateText(existing.efob_cost),
      });
      setSheet('to');
      setStep('merge');
    } else {
      submit(up, null);
    }
  }

  function submit(realCode: string, merge: Record<string, unknown> | null) {
    setErr(null);
    const fd = new FormData();
    fd.set('product_code', code);
    fd.set('real_code', realCode);
    if (merge) fd.set('merge', JSON.stringify(merge));
    start(async () => {
      const res = await linkProductToEasyEcom(fd);
      if (!res.ok) return setErr(toastError(res.error));
      emitToast(res.message ?? 'Linked.');
      router.replace(`/standard-cost/${encodeURIComponent(realCode)}`);
      router.refresh();
    });
  }

  function remove() {
    setErr(null);
    const fd = new FormData();
    fd.set('product_code', code);
    start(async () => {
      const res = await deleteUnlinkedProduct(fd);
      if (!res.ok) {
        setStep('idle');
        return setErr(toastError(res.error));
      }
      emitToast(res.message ?? 'Deleted.');
      router.replace('/standard-cost');
      router.refresh();
    });
  }

  if (!isAdmin && !canDelete) return null;

  return (
    <section className={`sc-unlinked${mode === 'relink' ? ' is-relink' : ''}`} aria-label="Link to EasyEcom">
      <div className="sc-unlinked-row">
        <div className="sc-unlinked-text">
          {mode === 'unlinked' ? (
            <>
              <strong>Not in EasyEcom yet{tempName ? ` · ${tempName}` : ''}</strong>
              <p className="wf-subtle">
                {code} is a temporary product. When it is created in EasyEcom, link it here: its cost,
                cost sheet, buying-plan lines and POs move to the EasyEcom code. If it was added by
                mistake, delete it.
              </p>
            </>
          ) : (
            <>
              <strong>Linked from {linkedFrom.join(', ')}</strong>
              <p className="wf-subtle">
                If this was the wrong EasyEcom product, link it to the right one: the cost, cost
                sheet, plan lines and POs under {code} move there.
              </p>
            </>
          )}
          {err && <small className="wf-line-error">{err}</small>}
        </div>
        <div className="sc-unlinked-actions">
          {step === 'pick' ? (
            <div className="sc-unlinked-link">
              <ProductPicker
                items={pool}
                onPick={choose}
                disabled={busy}
                allowFreeText={false}
                placeholder="Search the EasyEcom product code or name…"
              />
              <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={busy} onClick={() => setStep('idle')}>
                Cancel
              </button>
            </div>
          ) : step === 'delete' ? (
            <div className="sc-unlinked-confirm">
              <span>Delete {code} and its cost sheet?</span>
              <button type="button" className="wf-btn wf-btn-danger wf-btn-sm" disabled={busy} onClick={remove}>
                {busy ? 'Deleting…' : 'Delete'}
              </button>
              <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={busy} onClick={() => setStep('idle')}>
                Cancel
              </button>
            </div>
          ) : step === 'idle' ? (
            <>
              {isAdmin && (
                <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={busy} onClick={() => setStep('pick')}>
                  <Link2 size={14} /> {mode === 'unlinked' ? 'Link to EasyEcom product' : 'Change linked product'}
                </button>
              )}
              {canDelete && (
                <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={busy} onClick={() => setStep('delete')}>
                  <Trash2 size={14} /> Delete product
                </button>
              )}
            </>
          ) : null}
        </div>
      </div>

      {step === 'merge' && target && other && (
        <div className="sc-merge">
          <p className="sc-merge-lead">
            <strong>{target}</strong> already has its own cost. Choose the rates to keep: pick a side
            or type a value. What you save becomes the accepted standard for {target}.
          </p>
          {other.frozen && (
            <p className="wf-line-error">
              {target} is frozen by an issued PO, so its rates cannot change. Keep its rates to merge.
            </p>
          )}
          <div className="table-scroll">
            <table className="wf-grid sc-merge-table">
              <thead>
                <tr>
                  <th>Rate</th>
                  <th className="num">{code}</th>
                  <th className="num">{target}</th>
                  <th className="num">Keep</th>
                </tr>
              </thead>
              <tbody>
                {RATE_FIELDS.map((f) => {
                  const mine = rateText(cost[f.key]);
                  const theirs = rateText(other[f.key]);
                  return (
                    <tr key={f.key}>
                      <td>{f.label}</td>
                      <td className="num">
                        <button
                          type="button"
                          className={`sc-merge-pick${rates[f.key] === mine ? ' is-on' : ''}`}
                          disabled={other.frozen}
                          onClick={() => setRates((r) => ({ ...r, [f.key]: mine }))}
                        >
                          {mine === '' ? '—' : `₹${mine}`}
                        </button>
                      </td>
                      <td className="num">
                        <button
                          type="button"
                          className={`sc-merge-pick${rates[f.key] === theirs ? ' is-on' : ''}`}
                          disabled={other.frozen}
                          onClick={() => setRates((r) => ({ ...r, [f.key]: theirs }))}
                        >
                          {theirs === '' ? '—' : `₹${theirs}`}
                        </button>
                      </td>
                      <td className="num input-col">
                        <input
                          type="number"
                          min={0}
                          aria-label={`${f.label} rate to keep`}
                          value={rates[f.key]}
                          disabled={other.frozen}
                          onChange={(e) => setRates((r) => ({ ...r, [f.key]: e.target.value }))}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <fieldset className="sc-merge-sheet">
            <legend>Cost sheet to keep (colour / size lines, CMTP, extra fabric)</legend>
            <label>
              <input type="radio" name="sc-merge-sheet" checked={sheet === 'to'} onChange={() => setSheet('to')} /> From {target}
            </label>
            <label>
              <input type="radio" name="sc-merge-sheet" checked={sheet === 'from'} onChange={() => setSheet('from')} /> From {code}
            </label>
          </fieldset>
          <div className="sc-merge-actions">
            <button
              type="button"
              className="wf-btn wf-btn-primary wf-btn-sm"
              disabled={busy}
              onClick={() => submit(target, { ...rates, sheet })}
            >
              {busy ? 'Merging…' : `Merge into ${target}`}
            </button>
            <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={busy} onClick={() => setStep('idle')}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * The price, as two rows under the rate types (Job / FOB / E-FOB, or the material names):
 * what the team proposed (or submitted, or what was signed off) and the approver's target.
 * When it is the approver's turn, the target row is where the target is typed, one box per
 * rate type, with a single Set target.
 */
function PriceGrid({
  cost,
  role,
  track,
  money,
}: {
  cost: StandardCost;
  role: SdRole;
  track: 'fg' | 'material';
  money: (v: number | null) => string;
}) {
  const labels = RATE_LABELS[track];
  // Material lists Billing first, as its sheet does.
  const keys: PriceKey[] = track === 'material' ? ['fob', 'job', 'efob'] : ['job', 'fob', 'efob'];
  const stage = cost.neg_stage ?? null;
  const rateRow =
    stage === 'rate_submitted' ? 'Vendor rate' : stage === 'signed_off' ? 'Standard' : 'Proposed';
  const typed = keys.some((k) => cost[`target_${k}` as const] != null);
  const legacy = !typed && cost.target_cost != null;
  const canSet = canSetTarget(role, stage) && !cost.frozen;
  const [targets, setTargets] = useState<Partial<Record<PriceKey, string>>>({});
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const fields = targetFields(targets);

  function setTarget() {
    setErr(null);
    const fd = new FormData();
    fd.set('track', track);
    fd.set('id', String(cost.id));
    Object.entries(fields).forEach(([k, v]) => fd.set(k, v));
    start(async () => {
      const res = await setTargetCost(fd);
      if (res.ok) {
        setTargets({});
        reloadWithToast(res.message ?? 'Target set.');
      } else setErr(toastError(res.error));
    });
  }

  return (
    <section className="sc-price" aria-label="Price">
      <div className="table-scroll">
        <table className="sc-price-grid">
          <thead>
            <tr>
              <th aria-label="Row" />
              {keys.map((k) => (
                <th key={k} className="num">{labels[k]}</th>
              ))}
              {canSet && <th aria-label="Action" />}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">
                {rateRow}
                {cost.proposed_cost != null && <small>expected {money(cost.proposed_cost)}</small>}
              </th>
              {keys.map((k) => (
                <td key={k} className="num">{money(cost[`${k}_cost` as const])}</td>
              ))}
              {canSet && <td />}
            </tr>
            <tr className="sc-price-target">
              <th scope="row">Target</th>
              {canSet ? (
                <>
                  {keys.map((k) => (
                    <td key={k} className="num input-col">
                      <input
                        type="number"
                        min={0}
                        placeholder={cost[`target_${k}` as const] != null ? String(cost[`target_${k}` as const]) : '₹'}
                        aria-label={`${labels[k]} target`}
                        disabled={busy}
                        value={targets[k] ?? ''}
                        onChange={(e) => setTargets((t) => ({ ...t, [k]: e.target.value }))}
                      />
                    </td>
                  ))}
                  <td>
                    <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={busy || !Object.keys(fields).length} onClick={setTarget}>
                      {busy ? 'Setting…' : 'Set target'}
                    </button>
                  </td>
                </>
              ) : legacy ? (
                // Set before targets were per type: which rate it was for was never recorded.
                <td className="num" colSpan={keys.length}>
                  {money(cost.target_cost)} <small className="wf-subtle">overall (rate type not recorded)</small>
                </td>
              ) : (
                keys.map((k) => (
                  <td key={k} className="num">{money(cost[`target_${k}` as const] ?? null)}</td>
                ))
              )}
            </tr>
          </tbody>
        </table>
      </div>
      {err && <small className="wf-line-error">{err}</small>}
    </section>
  );
}
