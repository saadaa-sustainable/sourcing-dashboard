'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles, Pencil, AlertTriangle } from 'lucide-react';
import { setNpdBudget } from '@/lib/forms/actions';
import type { NpdBudget, SdRole } from '@/lib/forms/types';

const money = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

/**
 * NPD monthly budget: Sourcing (admin) sets a flat cap; NPD consumes it via
 * approved NPD purchase orders. Everyone sees consumption read-only; only an
 * admin gets the inline cap editor. An unset cap is shown as such — never a
 * fake zero-budget bar.
 */
export function NpdBudgetCard({
  budget,
  role,
}: {
  budget: NpdBudget;
  role: SdRole;
}) {
  const router = useRouter();
  const isAdmin = role === 'admin';
  const [editing, setEditing] = useState(false);
  const [cap, setCap] = useState(budget.cap != null ? String(budget.cap) : '');
  const [note, setNote] = useState(budget.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const hasCap = budget.cap != null;
  const remaining = hasCap ? budget.cap! - budget.spent : null;
  const pct = hasCap && budget.cap! > 0 ? Math.min(100, (budget.spent / budget.cap!) * 100) : 0;
  const over = hasCap && remaining! < 0;
  const near = hasCap && !over && pct >= 85;

  function save() {
    setError(null);
    const fd = new FormData();
    fd.set('month', budget.month);
    fd.set('cap', cap);
    fd.set('note', note);
    start(async () => {
      const r = await setNpdBudget(fd);
      if (r.ok) {
        setEditing(false);
        router.refresh();
      } else {
        setError(r.error);
      }
    });
  }

  return (
    <div className="panel wf-npd-budget">
      <div className="wf-npd-head">
        <span className="wf-npd-title">
          <Sparkles size={14} strokeWidth={2} /> NPD budget — this month
        </span>
        {isAdmin && !editing && (
          <button type="button" className="wf-btn wf-btn-ghost wf-npd-edit" onClick={() => setEditing(true)}>
            <Pencil size={12} /> {hasCap ? 'Edit cap' : 'Set cap'}
          </button>
        )}
      </div>

      {editing ? (
        <div className="wf-npd-edit-form">
          <label>
            Monthly cap (₹)
            <input
              type="text"
              inputMode="numeric"
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              placeholder="e.g. 2500000"
              autoFocus
            />
          </label>
          <label>
            Note (optional)
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Basis for this cap"
            />
          </label>
          <div className="wf-npd-edit-actions">
            <button type="button" className="wf-btn wf-btn-primary" onClick={save} disabled={pending}>
              {pending ? 'Saving…' : 'Save cap'}
            </button>
            <button
              type="button"
              className="wf-btn wf-btn-ghost"
              onClick={() => {
                setEditing(false);
                setCap(budget.cap != null ? String(budget.cap) : '');
                setNote(budget.note ?? '');
                setError(null);
              }}
              disabled={pending}
            >
              Cancel
            </button>
          </div>
          {error && <p className="wf-npd-error">{error}</p>}
        </div>
      ) : hasCap ? (
        <>
          <div className="wf-npd-figures">
            <div>
              <span className="wf-npd-label">Cap</span>
              <strong>{money.format(budget.cap!)}</strong>
            </div>
            <div>
              <span className="wf-npd-label">Committed</span>
              <strong>{money.format(budget.spent)}</strong>
              <small>{budget.spentCount} approved PO{budget.spentCount === 1 ? '' : 's'}</small>
            </div>
            <div>
              <span className="wf-npd-label">{over ? 'Over by' : 'Remaining'}</span>
              <strong className={over ? 'wf-npd-over' : near ? 'wf-npd-near' : 'wf-npd-ok'}>
                {money.format(Math.abs(remaining!))}
              </strong>
            </div>
          </div>
          <div className="wf-npd-bar">
            <div
              className={`wf-npd-bar-fill ${over ? 'over' : near ? 'near' : 'ok'}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="wf-npd-foot">
            <span>{pct.toFixed(0)}% committed</span>
            {budget.pendingCount > 0 && (
              <span>
                + {money.format(budget.pending)} in approval ({budget.pendingCount})
              </span>
            )}
            {budget.updatedBy && (
              <span className="wf-subtle">Cap set by {budget.updatedBy}</span>
            )}
          </div>
          {budget.missingRate > 0 && (
            <p className="wf-npd-warn">
              <AlertTriangle size={12} /> {budget.missingRate} approved NPD PO
              {budget.missingRate === 1 ? ' has' : 's have'} no rate — committed spend is understated.
            </p>
          )}
        </>
      ) : (
        <div className="wf-npd-unset">
          <p>
            No NPD cap set for this month yet.
            {budget.spentCount + budget.pendingCount > 0 && (
              <>
                {' '}NPD activity so far: {money.format(budget.spent)} committed
                {budget.pendingCount > 0 ? `, ${money.format(budget.pending)} in approval` : ''}.
              </>
            )}
          </p>
          {!isAdmin && <p className="wf-subtle">An admin sets the cap from Sourcing.</p>}
        </div>
      )}
    </div>
  );
}
