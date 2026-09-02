'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { SlidersHorizontal, Check } from 'lucide-react';
import { saveAnalyticsRule } from '@/lib/forms/actions';
import type { AnalyticsRuleRow, SdRole } from '@/lib/forms/types';

// How the flat rule list is grouped for the editor — same buckets the cards
// that reference them belong to. Any key not listed falls into "Other".
const GROUPS: { title: string; blurb: string; keys: string[] }[] = [
  {
    title: 'Dashboard analytics',
    blurb: 'Risk, utilization and concentration bands used by the main-dashboard cards.',
    keys: [
      'capital_risk_quantile',
      'vendor_concentration_alert',
      'utilization_under_pct',
      'utilization_over_pct',
      'reliability_window_days',
    ],
  },
  {
    title: 'PO lifecycle',
    blurb: 'Closure SLA and the PO-type lead times that drive the Buying Plan time-buckets.',
    keys: ['closure_sla_days', 'lead_days_job', 'lead_days_efob', 'lead_days_fob'],
  },
  {
    title: 'IPDOQ & Replenishment',
    blurb: 'The OOS-day fallback, the floor on the daily rate, and the ABC/D class cut-offs.',
    keys: [
      'oos_day_threshold',
      'ipdoq_floor',
      'product_class_a_above',
      'product_class_b_min',
      'product_class_c_min',
    ],
  },
  {
    title: 'Data & sync',
    blurb: 'When a synced feed is considered stale on the Sync Health card.',
    keys: ['sync_stale_hours'],
  },
];

const when = (v: string | null) =>
  v ? new Date(v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : null;

function RuleRow({ rule, canEdit }: { rule: AnalyticsRuleRow; canEdit: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState(String(rule.value));
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const dirty = value.trim() !== String(rule.value);

  function save() {
    setError(null);
    setSaved(false);
    const fd = new FormData();
    fd.set('rule_key', rule.rule_key);
    fd.set('value', value.trim());
    start(async () => {
      const r = await saveAnalyticsRule(fd);
      if (r.ok) {
        setSaved(true);
        router.refresh();
      } else {
        setError(r.error);
      }
    });
  }

  return (
    <div className="wf-rule-row">
      <div className="wf-rule-meta">
        <span className="wf-rule-label">{rule.label}</span>
        {rule.description && <span className="wf-rule-desc">{rule.description}</span>}
        <span className="wf-rule-key">
          <code>{rule.rule_key}</code>
          {rule.updated_by && (
            <span className="wf-subtle"> · last set by {rule.updated_by}{when(rule.updated_at) ? ` on ${when(rule.updated_at)}` : ''}</span>
          )}
        </span>
      </div>
      <div className="wf-rule-edit">
        {canEdit ? (
          <>
            <input
              type="text"
              inputMode="decimal"
              className="wf-rule-input"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setSaved(false);
              }}
              aria-label={`Value for ${rule.label}`}
            />
            <button
              type="button"
              className="wf-btn wf-btn-primary wf-rule-save"
              onClick={save}
              disabled={pending || !dirty}
            >
              {pending ? 'Saving…' : saved && !dirty ? (
                <>
                  <Check size={13} /> Saved
                </>
              ) : (
                'Save'
              )}
            </button>
          </>
        ) : (
          <strong className="wf-rule-value">{rule.value}</strong>
        )}
      </div>
      {error && <p className="wf-rule-error">{error}</p>}
    </div>
  );
}

export function RulesMasterClient({ rules, role }: { rules: AnalyticsRuleRow[]; role: SdRole }) {
  const canEdit = role === 'admin';
  const byKey = useMemo(() => new Map(rules.map((r) => [r.rule_key, r])), [rules]);
  const grouped = GROUPS.map((g) => ({
    ...g,
    rows: g.keys.map((k) => byKey.get(k)).filter(Boolean) as AnalyticsRuleRow[],
  })).filter((g) => g.rows.length);
  const placed = new Set(GROUPS.flatMap((g) => g.keys));
  const other = rules.filter((r) => !placed.has(r.rule_key));

  return (
    <div className="wf-rules-master">
      <div className="wf-rules-intro">
        <SlidersHorizontal size={15} strokeWidth={2} />
        <p>
          These are the numbers the dashboard&rsquo;s info (i) tips call &ldquo;editable in Rules
          Master&rdquo;. {canEdit ? 'Change a value and Save — it applies on the next page load.' : 'Only an admin can change them.'}
        </p>
      </div>

      {grouped.map((g) => (
        <section key={g.title} className="panel wf-rule-group">
          <div className="wf-rule-group-head">
            <h3>{g.title}</h3>
            <p className="wf-subtle">{g.blurb}</p>
          </div>
          <div className="wf-rule-list">
            {g.rows.map((r) => (
              <RuleRow key={r.rule_key} rule={r} canEdit={canEdit} />
            ))}
          </div>
        </section>
      ))}

      {other.length > 0 && (
        <section className="panel wf-rule-group">
          <div className="wf-rule-group-head">
            <h3>Other</h3>
            <p className="wf-subtle">Rules not yet assigned to a group.</p>
          </div>
          <div className="wf-rule-list">
            {other.map((r) => (
              <RuleRow key={r.rule_key} rule={r} canEdit={canEdit} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
