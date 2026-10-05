'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { HeaderInfo } from '@/components/header-info';
import Link from 'next/link';
import { ArrowLeft, Link2, Lock, Pencil, Trash2, X } from 'lucide-react';
import { ProductPicker } from '@/components/forms/product-picker';
import { deleteUnlinkedProduct, linkProductToEasyEcom } from '@/lib/forms/actions';
import { emitToast, toastError } from '@/lib/toast';
import { COST_STAGE_LABEL, COST_STAGE_TONE, nextActor } from '@/lib/forms/cost';
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
  linkCandidates = [],
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
  /** EasyEcom products with no Standard Cost of their own — what an unlinked product can be linked to. */
  linkCandidates?: ProductCatalogItem[];
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

      {!isMat && !catalog.some((p) => p.product_code.toUpperCase() === cost.product_code.toUpperCase()) && (
        <UnlinkedProductPanel code={cost.product_code} role={role} candidates={linkCandidates} temp={!!temp} />
      )}

      <section className="sc-page-rates" aria-label="Current rates">
        {[
          ...(isMat
            ? [
                { label: `${rateLabels.fob} rate`, value: cost.fob_cost },
                { label: `${rateLabels.job} rate`, value: cost.job_cost },
              ]
            : [
                { label: `${rateLabels.job} rate`, value: cost.job_cost },
                { label: `${rateLabels.fob} rate`, value: cost.fob_cost },
              ]),
          { label: `${rateLabels.efob} rate`, value: cost.efob_cost },
          { label: 'Proposed', value: cost.proposed_cost },
          { label: 'Target', value: cost.target_cost },
        ].map((r) => (
          <div className="sc-page-rate" key={r.label}>
            <span>{r.label}</span>
            <strong>{money(r.value)}</strong>
          </div>
        ))}
      </section>

      {/* The approver decides here, without opening the editor. Renders nothing when the
          signed-in role has no decision to make at this stage. */}
      <CostDecisionBar cost={cost} role={role} track={isMat ? 'material' : 'fg'} />

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
                  mergeCandidates={catalog}
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

/**
 * Shown on a product that is not in EasyEcom (a typed code such as "ABCD", or a TMP-xxxx
 * temporary product): link it to its EasyEcom product once that exists, or delete it. Both run
 * in the database in one step and are checked there (link: admin; delete: team or admin,
 * refused while a PO or plan line still uses it).
 */
function UnlinkedProductPanel({
  code,
  role,
  candidates,
  temp,
}: {
  code: string;
  role: SdRole;
  candidates: ProductCatalogItem[];
  temp: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<'idle' | 'link' | 'delete'>('idle');
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const canLink = role === 'admin';
  const canDelete = canEdit(role, 'draft');

  function link(realCode: string) {
    setErr(null);
    const fd = new FormData();
    fd.set('product_code', code);
    fd.set('real_code', realCode);
    start(async () => {
      const res = await linkProductToEasyEcom(fd);
      if (!res.ok) return setErr(toastError(res.error));
      emitToast(res.message ?? 'Linked.');
      router.replace(`/standard-cost/${encodeURIComponent(realCode.toUpperCase())}`);
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
        setMode('idle');
        return setErr(toastError(res.error));
      }
      emitToast(res.message ?? 'Deleted.');
      router.replace('/standard-cost');
      router.refresh();
    });
  }

  return (
    <section className="sc-unlinked" aria-label="Product not in EasyEcom">
      <div className="sc-unlinked-text">
        <strong>{temp ? 'Temporary product, not in EasyEcom yet' : 'Not an EasyEcom product'}</strong>
        <p className="wf-subtle">
          {code} is not in the product master. When the product is created in EasyEcom, link it here:
          its cost, cost sheet, buying-plan lines and POs move to the EasyEcom code. If it was added by
          mistake, delete it.
        </p>
        {err && <small className="wf-line-error">{err}</small>}
      </div>
      <div className="sc-unlinked-actions">
        {mode === 'link' ? (
          <div className="sc-unlinked-link">
            <ProductPicker
              items={candidates}
              onPick={link}
              disabled={busy}
              allowFreeText={false}
              placeholder="Search the EasyEcom product code or name…"
            />
            <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={busy} onClick={() => setMode('idle')}>
              Cancel
            </button>
          </div>
        ) : mode === 'delete' ? (
          <div className="sc-unlinked-confirm">
            <span>Delete {code} and its cost sheet?</span>
            <button type="button" className="wf-btn wf-btn-danger wf-btn-sm" disabled={busy} onClick={remove}>
              {busy ? 'Deleting…' : 'Delete'}
            </button>
            <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={busy} onClick={() => setMode('idle')}>
              Cancel
            </button>
          </div>
        ) : (
          <>
            {canLink && (
              <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={busy} onClick={() => setMode('link')}>
                <Link2 size={14} /> Link to EasyEcom product
              </button>
            )}
            {canDelete && (
              <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={busy} onClick={() => setMode('delete')}>
                <Trash2 size={14} /> Delete product
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
