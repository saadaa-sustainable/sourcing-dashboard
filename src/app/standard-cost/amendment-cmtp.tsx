'use client';

import { useState, type ReactNode } from 'react';
import { Combobox } from '@/components/forms/combobox';
import { CMTP_HEADS, CMTP_MANDATORY } from '@/lib/forms/cost';
import type { CostSnapshot } from '@/lib/standard-cost-workflow';

type Line = CostSnapshot['cmtp'][number];
type BlankLine = { category: string; label: string; id: number; amount: string };
const amountText = (value: number) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(value);

/** All edits stay in the amendment snapshot; this component never writes the live master. */
export function AmendmentCmtp({ value, onChange, subitems = {}, afterTotal }: {
  value: Line[]; onChange: (lines: Line[]) => void; subitems?: Record<string, string[]>; afterTotal?: ReactNode;
}) {
  const [heads, setHeads] = useState(() => [...new Set([...CMTP_MANDATORY, ...value.map(row => row.category)])]);
  const [newHead, setNewHead] = useState('');
  const [blanks, setBlanks] = useState<BlankLine[]>(() => {
    const rows: BlankLine[] = [];
    for (const head of CMTP_HEADS) {
      // Show the documented defaults up front. Any additional active master item is
      // selected through Add sub-item, so the search dropdown always has a purpose.
      for (const label of head.suggest ?? []) {
        if (!value.some(row => row.category === head.key && row.label === label)) rows.push({ category: head.key, label, id: rows.length, amount: '' });
      }
    }
    return rows;
  });
  const [nextId, setNextId] = useState(() => blanks.length);
  const total = value.reduce((sum, row) => sum + (row.amount ?? 0), 0) + blanks.reduce((sum,row) => sum + (Number(row.amount) || 0),0);
  const columns = [
    ['Labour', 'Product Trims'],
    ['Cutting', 'Packaging', 'Brand Trims'],
    ['Finishing', ...heads.filter(head => !CMTP_MANDATORY.includes(head))],
  ];

  function masterOptions(category: string, currentId?: number) {
    const fallback = CMTP_HEADS.find(head => head.key === category)?.suggest ?? [];
    const master = [...new Set(subitems[category] ?? fallback)];
    const used = new Set([
      ...value.filter(row => row.category === category).map(row => row.label.trim().toLocaleLowerCase()),
      ...blanks.filter(row => row.category === category && row.id !== currentId && row.label.trim()).map(row => row.label.trim().toLocaleLowerCase()),
    ]);
    return master.filter(label => !used.has(label.trim().toLocaleLowerCase())).map(label => ({ value: label, label }));
  }

  function addLine(category: string) {
    setBlanks(rows => [...rows, { category, label: '', id: nextId, amount: '' }]);
    setNextId(id => id + 1);
  }
  function fillBlank(row: BlankLine, text: string) {
    if (text.trim() === '') return;
    onChange([...value, { category: row.category, label: row.label, amount: Number(text), position: value.length }]);
    setBlanks(rows => rows.filter(item => item.id !== row.id));
  }
  function addHead() {
    const category = newHead.trim();
    if (!category || heads.includes(category)) return;
    setHeads(current => [...current, category]);
    addLine(category);
    setNewHead('');
  }

  return <div className="scw-amend-cmtp">
    <p className="scw-cmtp-intro">CMTP cost is built from these heads — the total below is the product’s FINAL CMTP. Fill the amounts that apply and leave the rest blank. Remove a line you do not need, or add a sub-item or a whole head the product needs.</p>
    <div className="scw-cmtp-columns">{columns.map((column, columnIndex) => <div className="scw-cmtp-column" key={columnIndex}>
      {column.filter(head => heads.includes(head)).map(head => <section className="scw-cmtp-head" key={head} aria-label={`${head} CMTP`}>
        <div className="scw-cmtp-head-heading"><div><h3>{head}{CMTP_MANDATORY.includes(head) && <span className="scw-required" aria-label="required"> *</span>}</h3></div><strong className="scw-cmtp-total">{amountText(value.filter(row => row.category === head).reduce((sum, row) => sum + (row.amount ?? 0), 0) + blanks.filter(row => row.category === head).reduce((sum,row) => sum + (Number(row.amount) || 0),0))}</strong></div>
        {value.map((row,index) => row.category === head && <div className="scw-cmtp-line" key={`saved-${index}`}>
          <span className="scw-cmtp-label-text">{row.label}</span>
          <input className="scw-cmtp-amount" aria-label={`CMTP amount row ${index+1}`} type="number" min="0" step="any" value={row.amount ?? ''} onChange={event => onChange(value.map((line,i) => i === index ? { ...line, amount: event.target.value === '' ? null : Number(event.target.value) } : line))} />
          <button className="scw-cmtp-remove" type="button" aria-label={`Remove ${head} ${row.label}`} onClick={() => onChange(value.filter((_,i) => i !== index))}>×</button>
        </div>)}
        {blanks.filter(row => row.category === head).map(row => <div className="scw-cmtp-line" key={`blank-${row.id}`}>
          {row.label ? <span className="scw-cmtp-label-text">{row.label}</span> : <Combobox ariaLabel={`${head} sub-item search`} value="" allowFreeText={false} placeholder="Search master sub-item" emptyText="No unused master sub-items." options={masterOptions(head,row.id)} onChange={label => setBlanks(items => items.map(item => item.id === row.id ? { ...item, label } : item))} />}
          <input className="scw-cmtp-amount" aria-label={`${head} amount ${row.label || row.id+1}`} type="number" min="0" step="any" value={row.amount} placeholder="—" onChange={event => setBlanks(items => items.map(item => item.id === row.id ? { ...item, amount:event.target.value } : item))} onBlur={event => fillBlank(row,event.target.value)} />
          <button className="scw-cmtp-remove" type="button" aria-label={`Remove suggested ${head} ${row.label}`} onClick={() => setBlanks(items => items.filter(item => item.id !== row.id))}>×</button>
        </div>)}
        <button className="scw-cmtp-add" type="button" disabled={!masterOptions(head).length} title={!masterOptions(head).length ? 'All active master sub-items are already listed.' : undefined} onClick={() => addLine(head)}>+ Add sub-item</button>
      </section>)}
    </div>)}</div>
    <div className="scw-cmtp-final"><strong>FINAL CMTP cost</strong><strong className="scw-cmtp-total">{amountText(total)}</strong></div>
    {afterTotal}
    <div className="scw-cmtp-add-head"><input aria-label="New CMTP head" placeholder="New head name" value={newHead} onChange={event => setNewHead(event.target.value)} /><button className="wf-btn wf-btn-ghost wf-btn-sm" type="button" disabled={!newHead.trim() || heads.includes(newHead.trim())} onClick={addHead}>Add head</button></div>
  </div>;
}
