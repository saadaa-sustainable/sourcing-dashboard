'use client';

import { useMemo, useState, useTransition } from 'react';
import { Check } from 'lucide-react';
import { setFeatureStatus } from '@/lib/feature-status-actions';
import { FeatureBadge } from '@/components/feature-badge';
import { Notice } from '@/components/forms/form-layout';
import { VIEW_GROUPS } from '@/lib/views';
import type { FeatureStatusValue } from '@/lib/feature-status';

export type FeatureRow = {
  key: string;
  label: string;
  group: string;
  status: FeatureStatusValue;
  note: string;
};

const STATUS_OPTS: { value: FeatureStatusValue; label: string }[] = [
  { value: 'live', label: 'Live' },
  { value: 'testing', label: 'In Testing' },
  { value: 'soon', label: 'Coming Soon' },
];

export function FeatureStatusClient({ rows }: { rows: FeatureRow[] }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const byGroup = useMemo(() => {
    const m = new Map<string, FeatureRow[]>();
    for (const r of rows) (m.get(r.group) ?? m.set(r.group, []).get(r.group)!)!.push(r);
    return m;
  }, [rows]);

  return (
    <>
      {msg && <Notice tone="ok">{msg}</Notice>}
      {err && <Notice tone="error">{err}</Notice>}
      <p className="wf-subtle">
        &ldquo;Live&rdquo; is the default and shows no badge. Set &ldquo;In Testing&rdquo; or
        &ldquo;Coming Soon&rdquo; to flag a feature that is visible but not yet fully trusted.
      </p>
      {VIEW_GROUPS.filter((g) => byGroup.has(g)).map((group) => (
        <div key={group} className="table-panel wf-grid-panel" style={{ marginBottom: 16 }}>
          <div className="table-meta"><span>{group}</span></div>
          <div className="table-scroll">
            <table className="wf-grid">
              <thead>
                <tr>
                  <th>Feature</th>
                  <th>Status</th>
                  <th>Note (optional)</th>
                  <th>Preview</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {(byGroup.get(group) ?? []).map((r) => (
                  <FeatureStatusRow key={r.key} row={r} onMsg={setMsg} onErr={setErr} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </>
  );
}

function FeatureStatusRow({
  row,
  onMsg,
  onErr,
}: {
  row: FeatureRow;
  onMsg: (m: string) => void;
  onErr: (e: string) => void;
}) {
  const [status, setStatus] = useState<FeatureStatusValue>(row.status);
  const [note, setNote] = useState(row.note);
  const [busy, start] = useTransition();

  const dirty = status !== row.status || note !== row.note;

  function save() {
    const fd = new FormData();
    fd.set('feature_key', row.key);
    fd.set('status', status);
    fd.set('note', note);
    start(async () => {
      const res = await setFeatureStatus(fd);
      if (res.ok) onMsg(res.message ?? 'Saved.');
      else onErr(res.error);
    });
  }

  return (
    <tr>
      <td>
        <strong>{row.label}</strong>
        <small className="wf-subtle" style={{ display: 'block' }}>{row.key}</small>
      </td>
      <td>
        <select value={status} onChange={(e) => setStatus(e.target.value as FeatureStatusValue)}>
          {STATUS_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </td>
      <td>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. numbers still being validated" />
      </td>
      <td><FeatureBadge status={status} /></td>
      <td>
        <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={busy || !dirty} onClick={save}>
          {busy ? 'Saving…' : <><Check size={12} /> Save</>}
        </button>
      </td>
    </tr>
  );
}
