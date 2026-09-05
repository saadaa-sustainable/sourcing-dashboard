'use client';

import { useMemo, useState, useTransition } from 'react';
import { reloadWithToast } from '@/lib/toast';
import { useColumnSort } from '@/lib/use-column-sort';
import { Plus, Save } from 'lucide-react';
import { addFabric, updateFabric } from '@/lib/forms/actions';
import { Field, Notice } from '@/components/forms/form-layout';
import { InfoDot } from '@/components/info-dot';
import type { FabricMaster } from '@/lib/forms/types';

// Composition input fields (from the fabric team's quality-report format). The code
// itself is entered by hand — never generated — and duplicate codes are blocked.
const FIELDS = [
  { key: 'composition', label: 'Composition', hint: 'e.g. 100% Cotton' },
  { key: 'warp_count', label: 'Warp count', hint: 'warp yarn count' },
  { key: 'weft_count', label: 'Weft count', hint: 'weft yarn count' },
  { key: 'third_thread', label: 'Third thread / blend', hint: 'third thread or blend type' },
  { key: 'weave', label: 'Weave', hint: 'e.g. Poplin, Twill' },
  { key: 'gsm', label: 'GSM', hint: 'grams / m²' },
  { key: 'raw_material_color', label: 'Raw material / colour', hint: '' },
  { key: 'fabric_name', label: 'Name', hint: 'optional label for the Buying Plan list' },
] as const;

type FieldKey = (typeof FIELDS)[number]['key'];
type Draft = Record<FieldKey, string> & { fabric_code: string };

const blank = (): Draft => ({
  fabric_code: '',
  composition: '',
  warp_count: '',
  weft_count: '',
  third_thread: '',
  weave: '',
  gsm: '',
  raw_material_color: '',
  fabric_name: '',
});

const valOf = (f: FabricMaster, k: FieldKey) => {
  const v = f[k];
  return v == null ? '' : String(v);
};

export function FabricMasterClient({
  fabrics,
  editable,
}: {
  fabrics: FabricMaster[];
  editable: boolean;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [filter, setFilter] = useState('');
  const [draft, setDraft] = useState<Draft>(blank());

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q
      ? fabrics.filter((f) =>
          `${f.fabric_code} ${f.composition ?? ''} ${f.fabric_name ?? ''}`
            .toLowerCase()
            .includes(q),
        )
      : fabrics;
  }, [fabrics, filter]);
  const sort = useColumnSort<(typeof fabrics)[number]>();

  function add() {
    setError(null);
    setMessage(null);
    if (!draft.fabric_code.trim()) {
      setError('Enter a fabric code.');
      return;
    }
    const fd = new FormData();
    fd.set('fabric_code', draft.fabric_code.trim());
    FIELDS.forEach(({ key }) => fd.set(key, draft[key]));
    fd.set('is_active', 'true');
    start(async () => {
      const result = await addFabric(fd);
      if (result.ok) {
        setMessage(result.message ?? 'Added.');
        reloadWithToast();
      } else {
        setError(result.error);
      }
    });
  }

  function saveRow(fd: FormData) {
    setError(null);
    setMessage(null);
    start(async () => {
      const result = await updateFabric(fd);
      if (result.ok) {
        setMessage(result.message ?? 'Saved.');
        reloadWithToast();
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <>
      <Notice tone="info">
        Fabric codes are entered <strong>by hand</strong> — the same nominal composition
        can differ by weave/GSM and needs its own code. A code that already exists is{' '}
        <strong>blocked</strong> on save. The Buying Plan material track picks its fabrics
        from this master.
      </Notice>

      {message && <Notice tone="ok">{message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      {editable && (
        <div className="panel wf-form-panel">
          <div className="panel-title">
            <h3>
              Add a fabric
              <InfoDot text="Register a new fabric with its construction (composition, counts, weave, GSM). The fabric code must be unique." />
            </h3>
          </div>
          <div className="wf-form-grid">
            <Field label="Fabric code" hint="Unique — blocked if it already exists">
              <input
                value={draft.fabric_code}
                placeholder="e.g. FAB-COT-POP-120"
                onChange={(e) => setDraft({ ...draft, fabric_code: e.target.value })}
              />
            </Field>
            {FIELDS.map(({ key, label, hint }) => (
              <Field key={key} label={label} hint={hint || undefined}>
                <input
                  type={key === 'gsm' ? 'number' : 'text'}
                  min={key === 'gsm' ? 0 : undefined}
                  value={draft[key]}
                  onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                />
              </Field>
            ))}
            <button
              type="button"
              className="wf-btn wf-btn-primary"
              onClick={add}
              disabled={pending}
            >
              <Plus size={15} /> Add fabric
            </button>
          </div>
        </div>
      )}

      <div className="wf-toolbar">
        <input
          className="wf-search"
          placeholder="Filter code / composition / name…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="wf-subtle">{shown.length} shown</span>
      </div>

      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wide-table wf-grid">
            <thead>
              <tr>
                <th {...sort.th('fabric_code', (f) => f.fabric_code)}>Fabric code {sort.ind('fabric_code')}</th>
                {FIELDS.map(({ key, label }) => (
                  <th
                    key={key}
                    className={key === 'gsm' ? 'num' : undefined}
                    {...sort.th(key, (f) => (f as Record<string, unknown>)[key] as string | number | null | undefined)}
                  >
                    {label} {sort.ind(key)}
                  </th>
                ))}
                <th {...sort.th('active', (f) => (f.is_active ? 1 : 0))}>Active {sort.ind('active')}</th>
                {editable && <th aria-label="Save" />}
              </tr>
            </thead>
            <tbody>
              {sort.apply(shown).map((fabric) => (
                <FabricRow
                  key={fabric.fabric_code}
                  fabric={fabric}
                  editable={editable}
                  pending={pending}
                  onSave={saveRow}
                />
              ))}
              {!shown.length && (
                <tr>
                  <td colSpan={editable ? FIELDS.length + 3 : FIELDS.length + 2} className="wf-empty-cell">
                    No fabrics yet — add one above.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function FabricRow({
  fabric,
  editable,
  pending,
  onSave,
}: {
  fabric: FabricMaster;
  editable: boolean;
  pending: boolean;
  onSave: (fd: FormData) => void;
}) {
  const [fields, setFields] = useState<Record<FieldKey, string>>(() => {
    const init = {} as Record<FieldKey, string>;
    FIELDS.forEach(({ key }) => (init[key] = valOf(fabric, key)));
    return init;
  });
  const [active, setActive] = useState(fabric.is_active);
  const dirty =
    active !== fabric.is_active ||
    FIELDS.some(({ key }) => fields[key] !== valOf(fabric, key));

  function set(key: FieldKey, value: string) {
    setFields((cur) => ({ ...cur, [key]: value }));
  }

  function save() {
    const fd = new FormData();
    fd.set('fabric_code', fabric.fabric_code);
    FIELDS.forEach(({ key }) => fd.set(key, fields[key]));
    fd.set('is_active', String(active));
    onSave(fd);
  }

  if (!editable) {
    return (
      <tr>
        <td className="mono">{fabric.fabric_code}</td>
        {FIELDS.map(({ key }) => (
          <td key={key} className={key === 'gsm' ? 'num' : undefined}>
            {valOf(fabric, key) || '—'}
          </td>
        ))}
        <td>{fabric.is_active ? 'Yes' : 'No'}</td>
      </tr>
    );
  }

  return (
    <tr>
      <td className="mono">{fabric.fabric_code}</td>
      {FIELDS.map(({ key }) => (
        <td key={key} className={key === 'gsm' ? 'num input-col' : 'input-col'}>
          <input
            type={key === 'gsm' ? 'number' : 'text'}
            min={key === 'gsm' ? 0 : undefined}
            value={fields[key]}
            onChange={(e) => set(key, e.target.value)}
          />
        </td>
      ))}
      <td>
        <input
          type="checkbox"
          checked={active}
          onChange={(e) => setActive(e.target.checked)}
        />
      </td>
      <td>
        <button
          type="button"
          className="wf-btn wf-btn-ghost wf-btn-sm"
          disabled={!dirty || pending}
          onClick={save}
        >
          <Save size={14} /> Save
        </button>
      </td>
    </tr>
  );
}
