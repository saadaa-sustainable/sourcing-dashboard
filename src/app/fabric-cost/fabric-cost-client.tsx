'use client';

import { useMemo, useRef, useState, useTransition } from 'react';
import { reloadWithToast } from '@/lib/toast';
import { Calculator, Download, Save, Upload } from 'lucide-react';
import { saveFabricCostBase } from '@/lib/forms/actions';
import { csvObjects, downloadCsv } from '@/lib/csv';
import { Notice } from '@/components/forms/form-layout';
import type { FabricCostBase } from '@/lib/forms/types';

const NUM_FIELDS = [
  'yarn_cost',
  'conversion_cost',
  'grey_rate',
  'processing_cost',
  'finished_fabric_cost',
] as const;
type NumField = (typeof NUM_FIELDS)[number];
type Draft = Record<NumField, string> & { fabric_code: string; notes: string };

const num = (v: string) => Number(v) || 0;

function toDraft(r: FabricCostBase): Draft {
  return {
    fabric_code: r.fabric_code,
    yarn_cost: r.yarn_cost?.toString() ?? '',
    conversion_cost: r.conversion_cost?.toString() ?? '',
    grey_rate: r.grey_rate?.toString() ?? '',
    processing_cost: r.processing_cost?.toString() ?? '',
    finished_fabric_cost: r.finished_fabric_cost?.toString() ?? '',
    notes: r.notes ?? '',
  };
}

const same = (a: Draft, b: Draft) =>
  a.notes === b.notes && NUM_FIELDS.every((f) => a[f] === b[f]);

export function FabricCostClient({
  rows,
  editable,
}: {
  rows: FabricCostBase[];
  editable: boolean;
}) {
  const original = useMemo(() => new Map(rows.map((r) => [r.fabric_code, toDraft(r)])), [rows]);
  const [drafts, setDrafts] = useState<Draft[]>(() => rows.map(toDraft));
  const [filter, setFilter] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  const dirtyCodes = useMemo(() => {
    const s = new Set<string>();
    for (const d of drafts) {
      const o = original.get(d.fabric_code);
      if (!o || !same(d, o)) s.add(d.fabric_code);
    }
    return s;
  }, [drafts, original]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? drafts.filter((d) => d.fabric_code.toLowerCase().includes(q)) : drafts;
  }, [drafts, filter]);

  function set(code: string, field: keyof Draft, value: string) {
    setDrafts((cur) => cur.map((d) => (d.fabric_code === code ? { ...d, [field]: value } : d)));
  }

  // Grey ≈ yarn + conversion (the yarn→grey one-time setup).
  function computeGrey(code: string) {
    setDrafts((cur) =>
      cur.map((d) =>
        d.fabric_code === code
          ? { ...d, grey_rate: String(num(d.yarn_cost) + num(d.conversion_cost)) }
          : d,
      ),
    );
  }

  function downloadTemplate() {
    const examples = drafts
      .slice(0, 3)
      .map((d) => [d.fabric_code, d.yarn_cost, d.conversion_cost, d.grey_rate, d.processing_cost, d.finished_fabric_cost, d.notes]);
    downloadCsv(
      'fabric-cost-base.csv',
      ['fabric_code', 'yarn_cost', 'conversion_cost', 'grey_rate', 'processing_cost', 'finished_fabric_cost', 'notes'],
      examples.length ? examples : [['FAB01', '', '', '', '', '', '']],
    );
  }

  async function onCsvFile(file: File) {
    setError(null);
    setMessage(null);
    let objects: Record<string, string>[];
    try {
      objects = csvObjects(await file.text());
    } catch {
      setError('Could not read that file as CSV.');
      return;
    }
    const byCode = new Map(drafts.map((d) => [d.fabric_code.toUpperCase(), d.fabric_code]));
    const patch = new Map<string, Partial<Draft>>();
    const skipped: string[] = [];
    objects.forEach((r, i) => {
      const code = String(r.fabric_code ?? '').trim().toUpperCase();
      if (!code) return skipped.push(`row ${i + 2}: missing fabric code`);
      if (!byCode.has(code)) return skipped.push(`row ${i + 2}: unknown fabric "${code}"`);
      const real = byCode.get(code)!;
      const p: Partial<Draft> = {};
      NUM_FIELDS.forEach((f) => {
        if (r[f] != null && String(r[f]).trim() !== '') p[f] = String(r[f]).trim();
      });
      if (r.notes != null && String(r.notes).trim() !== '') p.notes = String(r.notes).trim();
      patch.set(real, p);
    });
    if (!patch.size) {
      setError(`No rows imported.${skipped.length ? ` ${skipped.slice(0, 4).join('; ')}` : ' Expected a fabric_code column.'}`);
      return;
    }
    setDrafts((cur) => cur.map((d) => (patch.has(d.fabric_code) ? { ...d, ...patch.get(d.fabric_code) } : d)));
    setMessage(`Loaded ${patch.size} fabric(s)${skipped.length ? `, skipped ${skipped.length}` : ''}. Review, then Save changes.`);
  }

  function saveAll() {
    const dirty = drafts.filter((d) => dirtyCodes.has(d.fabric_code));
    if (!dirty.length) return;
    setError(null);
    setMessage(null);
    start(async () => {
      for (const d of dirty) {
        const fd = new FormData();
        fd.set('fabric_code', d.fabric_code);
        NUM_FIELDS.forEach((f) => fd.set(f, d[f]));
        fd.set('notes', d.notes);
        const res = await saveFabricCostBase(fd);
        if (!res.ok) {
          setError(`${d.fabric_code}: ${res.error}`);
          return;
        }
      }
      reloadWithToast();
    });
  }

  return (
    <>
      <Notice tone="info">
        The fabric cost base sheet. <strong>Finished fabric cost</strong> is entered directly; grey
        rate &amp; processing are recorded alongside. <strong>Yarn → Grey</strong> is a one-time
        setup — fill yarn + conversion and use <em>=</em> to set the grey rate.
      </Notice>

      {message && <Notice tone="ok">{message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      <div className="wf-toolbar wf-filter-bar">
        <input
          className="wf-search"
          placeholder="Filter fabric code…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="wf-subtle">{shown.length} shown</span>
        {editable && (
          <div className="wf-toolbar-right">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onCsvFile(f);
                e.target.value = '';
              }}
            />
            <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={downloadTemplate}>
              <Download size={13} /> Template
            </button>
            <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => fileRef.current?.click()}>
              <Upload size={13} /> Import CSV
            </button>
            <button
              type="button"
              className="wf-btn wf-btn-primary wf-btn-sm"
              onClick={saveAll}
              disabled={pending || !dirtyCodes.size}
            >
              <Save size={13} /> {pending ? 'Saving…' : `Save changes (${dirtyCodes.size})`}
            </button>
          </div>
        )}
      </div>

      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wf-grid">
            <thead>
              <tr>
                <th>Fabric code</th>
                <th className="num input-col wf-yarn-col">Yarn cost</th>
                <th className="num input-col wf-yarn-col">Conversion</th>
                <th className="wf-yarn-col" aria-label="Compute grey" />
                <th className="num input-col">Grey rate</th>
                <th className="num input-col">Processing</th>
                <th className="num input-col">Finished cost</th>
                <th className="input-col">Notes</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((d) => (
                <tr key={d.fabric_code} className={dirtyCodes.has(d.fabric_code) ? 'wf-row-dirty' : ''}>
                  <td className="mono">{d.fabric_code}</td>
                  <td className="num input-col wf-yarn-col">
                    <input type="number" min={0} value={d.yarn_cost} disabled={!editable} onChange={(e) => set(d.fabric_code, 'yarn_cost', e.target.value)} />
                  </td>
                  <td className="num input-col wf-yarn-col">
                    <input type="number" min={0} value={d.conversion_cost} disabled={!editable} onChange={(e) => set(d.fabric_code, 'conversion_cost', e.target.value)} />
                  </td>
                  <td className="wf-yarn-col">
                    {editable && (
                      <button
                        type="button"
                        className="wf-icon-btn"
                        title="Set grey rate = yarn + conversion"
                        onClick={() => computeGrey(d.fabric_code)}
                      >
                        <Calculator size={13} />
                      </button>
                    )}
                  </td>
                  <td className="num input-col">
                    <input type="number" min={0} value={d.grey_rate} disabled={!editable} onChange={(e) => set(d.fabric_code, 'grey_rate', e.target.value)} />
                  </td>
                  <td className="num input-col">
                    <input type="number" min={0} value={d.processing_cost} disabled={!editable} onChange={(e) => set(d.fabric_code, 'processing_cost', e.target.value)} />
                  </td>
                  <td className="num input-col">
                    <input type="number" min={0} value={d.finished_fabric_cost} disabled={!editable} onChange={(e) => set(d.fabric_code, 'finished_fabric_cost', e.target.value)} />
                  </td>
                  <td className="input-col">
                    <input value={d.notes} disabled={!editable} placeholder="—" onChange={(e) => set(d.fabric_code, 'notes', e.target.value)} />
                  </td>
                </tr>
              ))}
              {!shown.length && (
                <tr>
                  <td colSpan={8} className="wf-empty-cell">
                    No fabrics match. (Rows seed from the active Fabric Master.)
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
