'use client';

import { useMemo, useState, useTransition } from 'react';
import { Plus, Save } from 'lucide-react';
import {
  addColour,
  addMaterial,
  setColourActive,
  updateMaterial,
} from '@/lib/forms/actions';
import { Field, Notice } from '@/components/forms/form-layout';
import type { Colour, MaterialMaster, MaterialType } from '@/lib/forms/types';

const TYPES: { key: MaterialType; label: string }[] = [
  { key: 'raw', label: 'Raw material' },
  { key: 'dyed', label: 'Dyed / finished' },
  { key: 'trim', label: 'Trims' },
];
const UOMS = ['metres', 'kg', 'pcs', 'rolls', 'sets'];
const TYPE_LABEL: Record<MaterialType, string> = {
  raw: 'Raw material',
  dyed: 'Dyed / finished',
  trim: 'Trim',
};

function suggestedCode(type: MaterialType, base: string, colour: string) {
  if (type !== 'dyed' || !base.trim() || !colour.trim()) return '';
  return `${base.trim().toUpperCase()}-${colour.trim().slice(0, 3).toUpperCase()}`;
}

export function MaterialMasterClient({
  materials,
  colours,
  fabricCodes,
  initialType = 'raw',
  editable,
}: {
  materials: MaterialMaster[];
  colours: Colour[];
  fabricCodes: string[];
  initialType?: MaterialType;
  editable: boolean;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // Preselect the type the Buying Plan deep-linked to (?type=raw|dyed|trim).
  const [type, setType] = useState<MaterialType>(initialType);
  const [filter, setFilter] = useState('');

  // Add-form draft
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [base, setBase] = useState('');
  const [colour, setColour] = useState('');
  const [uom, setUom] = useState('');
  const [newColour, setNewColour] = useState('');

  const activeColours = colours.filter((c) => c.is_active).map((c) => c.colour);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return materials
      .filter((m) => m.material_type === type)
      .filter((m) =>
        q
          ? `${m.material_code} ${m.name ?? ''} ${m.colour ?? ''}`.toLowerCase().includes(q)
          : true,
      );
  }, [materials, type, filter]);

  function run(action: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    setError(null);
    setMessage(null);
    start(async () => {
      const result = await action();
      if (result.ok) {
        setMessage(result.message ?? 'Saved.');
        window.location.reload();
      } else {
        setError(result.error ?? 'Something went wrong.');
      }
    });
  }

  function add() {
    const suggested = suggestedCode(type, base, colour);
    const finalCode = (code.trim() || suggested).toUpperCase();
    if (!finalCode) {
      setError('Enter a material code.');
      return;
    }
    if (type === 'dyed' && (!base.trim() || !colour.trim())) {
      setError('A dyed fabric needs both a base fabric and a colour.');
      return;
    }
    const fd = new FormData();
    fd.set('material_code', finalCode);
    fd.set('material_type', type);
    fd.set('name', name);
    fd.set('default_uom', uom);
    if (type === 'dyed') {
      fd.set('base_fabric_code', base.trim().toUpperCase());
      fd.set('colour', colour);
    }
    fd.set('is_active', 'true');
    run(() => addMaterial(fd));
  }

  const codePlaceholder =
    type === 'dyed' ? suggestedCode(type, base, colour) || 'pick base + colour' : 'e.g. TRM07';

  return (
    <>
      <Notice tone="info">
        The single code list the Buying Plan material track picks from. Pick a{' '}
        <strong>type</strong> — Raw materials carry their specs in Fabric Master; a{' '}
        <strong>Dyed</strong> code is a grey fabric + a colour; <strong>Trims</strong> are a
        simple code + name.
      </Notice>

      {message && <Notice tone="ok">{message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      <div className="wf-toolbar">
        <div className="segment wf-segment">
          {TYPES.map((t) => (
            <button
              key={t.key}
              type="button"
              className={type === t.key ? 'active' : ''}
              onClick={() => setType(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {editable && (
        <div className="panel wf-form-panel">
          <div className="panel-title">
            <h3>Add a {TYPE_LABEL[type].toLowerCase()} code</h3>
          </div>
          <div className="wf-form-grid">
            <Field label="Material code" hint="Unique — blocked if it already exists">
              <input
                value={code}
                placeholder={codePlaceholder}
                onChange={(e) => setCode(e.target.value)}
              />
            </Field>
            <Field label="Name" hint="optional label for the Buying Plan list">
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            {type === 'dyed' && (
              <>
                <Field label="Base grey fabric" hint="the raw fabric it is dyed from">
                  <input
                    list="fabric-codes"
                    value={base}
                    placeholder="fabric code"
                    onChange={(e) => setBase(e.target.value)}
                  />
                </Field>
                <Field label="Colour" hint="managed list below">
                  <select value={colour} onChange={(e) => setColour(e.target.value)}>
                    <option value="">Select colour…</option>
                    {activeColours.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </Field>
              </>
            )}
            <Field label="Default UOM" hint="optional">
              <select value={uom} onChange={(e) => setUom(e.target.value)}>
                <option value="">—</option>
                {UOMS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </Field>
            <button
              type="button"
              className="wf-btn wf-btn-primary"
              onClick={add}
              disabled={pending}
            >
              <Plus size={15} /> Add {TYPE_LABEL[type].toLowerCase()}
            </button>
          </div>
          <datalist id="fabric-codes">
            {fabricCodes.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </div>
      )}

      <div className="wf-toolbar">
        <input
          className="wf-search"
          placeholder="Filter code / name / colour…"
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
                <th>Material code</th>
                <th>Name</th>
                {type === 'dyed' && <th>Base fabric</th>}
                {type === 'dyed' && <th>Colour</th>}
                <th>UOM</th>
                <th>Active</th>
                {editable && <th aria-label="Save" />}
              </tr>
            </thead>
            <tbody>
              {shown.map((m) => (
                <MaterialRow
                  key={m.material_code}
                  material={m}
                  editable={editable}
                  pending={pending}
                  activeColours={activeColours}
                  onSave={(fd) => run(() => updateMaterial(fd))}
                />
              ))}
              {!shown.length && (
                <tr>
                  <td colSpan={type === 'dyed' ? (editable ? 7 : 6) : editable ? 5 : 4} className="wf-empty-cell">
                    No {TYPE_LABEL[type].toLowerCase()} codes yet{editable ? ' — add one above.' : '.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Colour list manager */}
      <div className="panel wf-form-panel">
        <div className="panel-title">
          <h3>Colours</h3>
          <span>used to build dyed-fabric codes</span>
        </div>
        {editable && (
          <div className="wf-form-grid">
            <Field label="New colour">
              <input
                value={newColour}
                placeholder="e.g. Indigo"
                onChange={(e) => setNewColour(e.target.value)}
              />
            </Field>
            <button
              type="button"
              className="wf-btn wf-btn-primary"
              disabled={pending || !newColour.trim()}
              onClick={() => {
                const fd = new FormData();
                fd.set('colour', newColour.trim());
                run(() => addColour(fd));
              }}
            >
              <Plus size={15} /> Add colour
            </button>
          </div>
        )}
        <div className="wf-chip-row">
          {colours.map((c) => (
            <span key={c.colour} className={c.is_active ? 'wf-chip' : 'wf-chip wf-chip-off'}>
              {c.colour}
              {editable && (
                <button
                  type="button"
                  className="wf-chip-x"
                  title={c.is_active ? 'Deactivate' : 'Activate'}
                  onClick={() => {
                    const fd = new FormData();
                    fd.set('colour', c.colour);
                    fd.set('is_active', String(!c.is_active));
                    run(() => setColourActive(fd));
                  }}
                >
                  {c.is_active ? '×' : '+'}
                </button>
              )}
            </span>
          ))}
          {!colours.length && <span className="wf-subtle">No colours yet.</span>}
        </div>
      </div>
    </>
  );
}

function MaterialRow({
  material,
  editable,
  pending,
  activeColours,
  onSave,
}: {
  material: MaterialMaster;
  editable: boolean;
  pending: boolean;
  activeColours: string[];
  onSave: (fd: FormData) => void;
}) {
  const [name, setName] = useState(material.name ?? '');
  const [base, setBase] = useState(material.base_fabric_code ?? '');
  const [colour, setColour] = useState(material.colour ?? '');
  const [uom, setUom] = useState(material.default_uom ?? '');
  const [active, setActive] = useState(material.is_active);
  const isDyed = material.material_type === 'dyed';

  const dirty =
    name !== (material.name ?? '') ||
    base !== (material.base_fabric_code ?? '') ||
    colour !== (material.colour ?? '') ||
    uom !== (material.default_uom ?? '') ||
    active !== material.is_active;

  function save() {
    const fd = new FormData();
    fd.set('material_code', material.material_code);
    fd.set('material_type', material.material_type);
    fd.set('name', name);
    fd.set('default_uom', uom);
    if (isDyed) {
      fd.set('base_fabric_code', base);
      fd.set('colour', colour);
    }
    fd.set('is_active', String(active));
    onSave(fd);
  }

  if (!editable) {
    return (
      <tr>
        <td className="mono">{material.material_code}</td>
        <td>{material.name || '—'}</td>
        {isDyed && <td className="mono">{material.base_fabric_code || '—'}</td>}
        {isDyed && <td>{material.colour || '—'}</td>}
        <td>{material.default_uom || '—'}</td>
        <td>{material.is_active ? 'Yes' : 'No'}</td>
      </tr>
    );
  }

  return (
    <tr>
      <td className="mono">{material.material_code}</td>
      <td className="input-col">
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </td>
      {isDyed && (
        <td className="input-col">
          <input list="fabric-codes" value={base} onChange={(e) => setBase(e.target.value)} />
        </td>
      )}
      {isDyed && (
        <td className="input-col">
          <select value={colour} onChange={(e) => setColour(e.target.value)}>
            <option value="">—</option>
            {[colour, ...activeColours.filter((c) => c !== colour)]
              .filter(Boolean)
              .map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
          </select>
        </td>
      )}
      <td className="input-col">
        <select value={uom} onChange={(e) => setUom(e.target.value)}>
          <option value="">—</option>
          {UOMS.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
      </td>
      <td>
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
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
