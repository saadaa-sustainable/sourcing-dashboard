'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Lock, Pencil, X } from 'lucide-react';
import { COST_STAGE_LABEL, COST_STAGE_TONE, nextActor } from '@/lib/forms/cost';
import { canEdit } from '@/lib/forms/approval';
import { CostRow, CostDetail } from '../standard-cost-client';
import type {
  CmtpComponent,
  ProductCatalogItem,
  SdRole,
  StandardCost,
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
  role,
  marginPct,
}: {
  cost: StandardCost;
  productName: string | null;
  lines: StandardCostLine[];
  cmtp: CmtpComponent[];
  cmtpSubitems: Record<string, string[]>;
  fabricBase: Record<string, FabricBuildup>;
  fabricCodes: string[];
  history: StandardCostRateHistory[];
  revisions: CmtpRevision[];
  masterFabric: { fabricCode: string | null; multi: boolean } | null;
  temp?: TempProductInfo;
  catalog: ProductCatalogItem[];
  role: SdRole;
  marginPct: number;
}) {
  const [editing, setEditing] = useState(false);
  const stageKey = cost.neg_stage ?? '';
  const latest = history[0] ?? null;
  const updatedOn = longDate(latest?.accepted_at ?? cost.updated_at);
  const rateEditable = !cost.frozen && canEdit(role, 'draft');

  return (
    <div className="sc-page">
      <div className="sc-page-bar">
        <Link href="/standard-cost" className="sc-page-back">
          <ArrowLeft size={15} /> All products
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
          <h1>{productName || temp?.name || 'Product name unavailable'}</h1>
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

      <section className="sc-page-rates" aria-label="Current rates">
        {[
          { label: 'Job rate', value: cost.job_cost },
          { label: 'FOB rate', value: cost.fob_cost },
          { label: 'E-FOB rate', value: cost.efob_cost },
          { label: 'Proposed', value: cost.proposed_cost },
          { label: 'Target', value: cost.target_cost },
        ].map((r) => (
          <div className="sc-page-rate" key={r.label}>
            <span>{r.label}</span>
            <strong>{money(r.value)}</strong>
          </div>
        ))}
      </section>

      {editing && (
        <section className="sc-page-edit" aria-label="Change the cost">
          <div className="sc-page-edit-head">
            <h2>Change the cost</h2>
            <p className="wf-subtle">
              Fill the rate(s) that apply and propose. The product then follows its usual path:
              Mahesh accepts the proposal or sets a target, the team returns with the actual
              vendor rate, and sign-off makes it the standard the Buying Plan values from.
            </p>
          </div>
          <div className="table-scroll">
            <table className="wf-grid wf-cost-sheet">
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="num">Proposed</th>
                  <th className="num">Target</th>
                  <th className="num input-col">Job rate</th>
                  <th className="num input-col">FOB rate</th>
                  <th className="num input-col">E-FOB rate</th>
                  <th>Stage</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                <CostRow
                  cost={cost}
                  role={role}
                  track="fg"
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
          editable={rateEditable}
          marginPct={marginPct}
        />
      </section>
    </div>
  );
}
