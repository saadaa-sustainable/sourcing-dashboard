'use client';

import { RATE_LABELS, targetKeysFor, type RateKey } from '@/lib/forms/cost';

/**
 * Target inputs, one per rate type the proposal named (Job / FOB / E-FOB, or the material
 * names), each labelled and showing the proposed rate it answers. Returns the typed values;
 * the caller sends them as target_job / target_fob / target_efob.
 */
export function TargetInputs({
  cost,
  track,
  value,
  onChange,
  disabled = false,
}: {
  cost: { job_cost: number | null; fob_cost: number | null; efob_cost: number | null };
  track: 'fg' | 'material';
  value: Partial<Record<RateKey, string>>;
  onChange: (next: Partial<Record<RateKey, string>>) => void;
  disabled?: boolean;
}) {
  const labels = RATE_LABELS[track];
  return (
    <span className="wf-target-inputs">
      {targetKeysFor(cost).map((k) => {
        const proposed = cost[`${k}_cost` as const];
        return (
          <label key={k} className="wf-target-input">
            <span>
              {labels[k]} target
              {proposed != null && <small> · proposed ₹{Number(proposed)}</small>}
            </span>
            <input
              className="wf-mini-input"
              type="number"
              min={0}
              placeholder="₹"
              disabled={disabled}
              value={value[k] ?? ''}
              onChange={(e) => onChange({ ...value, [k]: e.target.value })}
            />
          </label>
        );
      })}
    </span>
  );
}

/** FormData fields for a target set through TargetInputs. */
export function targetFields(value: Partial<Record<RateKey, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) if (v != null && v.trim() !== '') out[`target_${k}`] = v.trim();
  return out;
}
