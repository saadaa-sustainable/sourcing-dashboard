/** Serializable, editable snapshots. Operational/approval stamps are never copied. */
export const COST_SECTIONS = ['rates', 'fabric', 'cmtp', 'documents'] as const;
export type CostSection = typeof COST_SECTIONS[number];
export const SECTION_LABEL: Record<CostSection, string> = { rates: 'Final cost / rates', fabric: 'Fabric / size costing', cmtp: 'CMTP', documents: 'CAD / RFP documents' };
export type CostSnapshot = {
  rates: { job_cost: number | null; fob_cost: number | null; efob_cost: number | null; total_po_avg_cost: number | null; proposed_cost?: number | null; target_job?: number | null; target_fob?: number | null; target_efob?: number | null };
  fabric: { fabric_code: string; fabric_uom: 'mtr' | 'kg'; lines: { colour: string; size: string; consumption: number | null; fabric_cost: number | null; cm_cost: number | null; total_cost: number | null }[]; extras: { fabric_code: string; size: string; position: number; uom: 'mtr' | 'kg'; consumption: number | null; fabric_cost: number | null }[] };
  cmtp: { category: string; label: string; amount: number | null; position: number }[];
  documents: { rfp_link: string; cad_link: string; files: { file_path: string | null; file_name: string | null; file_size: number | null; doc_group: string; width: string | null; link_url: string | null; remark: string | null }[] };
};
export type CostRevision = { id: number; product_code: string; kind: 'new' | 'amendment'; status: 'draft' | 'pending' | 'rework' | 'rejected' | 'approved'; owner: string; reason: string; reference_code: string | null; base: CostSnapshot; payload: CostSnapshot; sections: CostSection[]; approved_sections: CostSection[]; version: number; updated_at: string };
export type CostWorkflowEvent = { id: number; revision_id: number; product_code: string; event: string; actor: string; reason: string; sections: CostSection[]; before_data: unknown; after_data: unknown; created_at: string };

export function costEventChanges(event: CostWorkflowEvent): { field: string; before: string; after: string }[] {
  const previous = event.before_data as Partial<CostRevision> | null;
  const next = event.after_data as Partial<CostRevision> | null;
  const before = event.event === 'approve' ? previous?.base : previous?.payload;
  const after = next?.payload;
  const changes: { field: string; before: string; after: string }[] = [];
  const display = (v: unknown) => v === null || v === undefined || v === '' ? '—' : String(v);
  const walk = (a: unknown, b: unknown, path: string) => {
    if (a === b) return;
    if ((a && typeof a === 'object') || (b && typeof b === 'object')) {
      const left = (a ?? {}) as Record<string, unknown>, right = (b ?? {}) as Record<string, unknown>;
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
        if (key === 'file_path') continue;
        walk(left[key], right[key], `${path} / ${/^\d+$/.test(key) ? `row ${Number(key)+1}` : key.replaceAll('_', ' ')}`);
      }
    } else changes.push({ field: path, before: display(a), after: display(b) });
  };
  for (const section of event.sections) walk(before?.[section], after?.[section], SECTION_LABEL[section]);
  if (previous?.status !== next?.status) changes.push({ field: 'Approval status', before: display(previous?.status), after: display(next?.status) });
  if (previous?.reference_code !== next?.reference_code) changes.push({ field: 'Reference product', before: display(previous?.reference_code), after: display(next?.reference_code) });
  return changes;
}

export function copyCostReference(source: CostSnapshot): CostSnapshot {
  const copy = structuredClone(source);
  copy.documents.files = [];
  copy.documents.cad_link = '';
  return copy;
}

export function changedCostSections(base: CostSnapshot, next: CostSnapshot): CostSection[] {
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => [k,stable(v)])) : value;
  return COST_SECTIONS.filter(s => JSON.stringify(stable(base[s])) !== JSON.stringify(stable(next[s])));
}

/** Reject malformed drafts too: a saved draft must always be safe to reopen. */
export function parseCostSnapshot(value: unknown): CostSnapshot {
  const object = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid cost section.');
    return v as Record<string, unknown>;
  };
  const text = (v: unknown, max = 1000) => { if (typeof v !== 'string' || v.length > max) throw new Error('Invalid or oversized cost text field.'); return v; };
  const nullableText = (v: unknown) => v === null ? null : text(v);
  const amount = (v: unknown) => { if (v !== null && (typeof v !== 'number' || !Number.isFinite(v))) throw new Error('Cost amounts must be finite numbers.'); return v as number | null; };
  const rows = (v: unknown): Record<string, unknown>[] => { if (!Array.isArray(v) || v.length > 500) throw new Error('A section can contain up to 500 lines.'); return v.map(object); };
  const unit = (v: unknown): 'mtr'|'kg' => { if (v !== 'mtr' && v !== 'kg') throw new Error('Choose metre or kg.'); return v; };
  const position = (v: unknown) => { if (!Number.isInteger(v) || Number(v) < 0) throw new Error('Invalid line position.'); return Number(v); };
  const root=object(value), rates=object(root.rates), fabric=object(root.fabric), documents=object(root.documents);
  for (const link of [documents.rfp_link, documents.cad_link, ...rows(documents.files).map(f => f.link_url)]) {
    if (link !== null && link !== '' && (typeof link !== 'string' || !/^https?:\/\/\S+$/i.test(link))) throw new Error('Document links must start with http:// or https://.');
  }
  return {
    rates:{job_cost:amount(rates.job_cost),fob_cost:amount(rates.fob_cost),efob_cost:amount(rates.efob_cost),total_po_avg_cost:amount(rates.total_po_avg_cost),...Object.fromEntries(['proposed_cost','target_job','target_fob','target_efob'].filter(key => key in rates).map(key => [key,amount(rates[key])]))},
    fabric:{fabric_code:text(fabric.fabric_code,100),fabric_uom:unit(fabric.fabric_uom),lines:rows(fabric.lines).map(l=>({colour:text(l.colour,100),size:text(l.size,100),consumption:amount(l.consumption),fabric_cost:amount(l.fabric_cost),cm_cost:amount(l.cm_cost),total_cost:amount(l.total_cost)})),extras:rows(fabric.extras).map(l=>({fabric_code:text(l.fabric_code,100),size:text(l.size,100),position:position(l.position),uom:unit(l.uom),consumption:amount(l.consumption),fabric_cost:amount(l.fabric_cost)}))},
    cmtp:rows(root.cmtp).map(l=>({category:text(l.category,100),label:text(l.label,200),amount:amount(l.amount),position:position(l.position)})),
    documents:{rfp_link:text(documents.rfp_link),cad_link:text(documents.cad_link),files:rows(documents.files).map(f=>({file_path:nullableText(f.file_path),file_name:nullableText(f.file_name),file_size:amount(f.file_size),doc_group:text(f.doc_group,30),width:nullableText(f.width),link_url:nullableText(f.link_url),remark:nullableText(f.remark)}))},
  };
}

/** Validate only submitted sections of amendments, all sections of a new cost. */
export function validateCostSnapshot(value: CostSnapshot, sections: CostSection[], isNew: boolean): string[] {
  const errors: string[] = [];
  const required = new Set(isNew ? COST_SECTIONS : sections);
  const number = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (required.has('rates')) {
    for (const key of ['job_cost','fob_cost','efob_cost','total_po_avg_cost'] as const) if (!number(value.rates[key])) errors.push(`${key.replaceAll('_', ' ')} is required and must be a finite nonnegative number.`);
    for (const key of ['proposed_cost','target_job','target_fob','target_efob'] as const) if (value.rates[key] != null && !number(value.rates[key])) errors.push(`${key.replaceAll('_', ' ')} must be a finite nonnegative number.`);
  }
  if (required.has('fabric')) {
    if (!value.fabric.fabric_code.trim()) errors.push('Fabric code is required.');
    if (!['mtr', 'kg'].includes(value.fabric.fabric_uom)) errors.push('Choose a fabric unit.');
    if (!value.fabric.lines.length) errors.push('At least one colour / size costing line is required.');
    const keys = new Set<string>();
    for (const l of value.fabric.lines) {
      const key = `${l.colour.trim().toUpperCase()}|${l.size.trim().toUpperCase()}`;
      if (!l.colour.trim() || !l.size.trim() || ![l.consumption, l.fabric_cost, l.cm_cost, l.total_cost].every(number)) errors.push('Every size line needs colour, size, consumption, fabric cost, CM cost and total cost.');
      if (keys.has(key)) errors.push('Duplicate colour / size line.');
      keys.add(key);
    }
    const extraKeys = new Set<string>();
    for (const l of value.fabric.extras) {
      const key = `${l.fabric_code.trim().toUpperCase()}|${l.size.trim().toUpperCase()}`;
      if (!l.fabric_code.trim() || !l.size.trim() || ![l.consumption, l.fabric_cost].every(number) || !['mtr', 'kg'].includes(l.uom) || !Number.isInteger(l.position) || l.position < 1) errors.push('Complete every extra fabric line, including its unit and position.');
      if (l.fabric_code.toUpperCase() === value.fabric.fabric_code.toUpperCase() || extraKeys.has(key)) errors.push('A fabric may appear only once per size and cannot repeat the main fabric.');
      extraKeys.add(key);
    }
  }
  if (required.has('cmtp')) {
    if (!value.cmtp.length || value.cmtp.some(l => !l.category.trim() || !l.label.trim() || !number(l.amount))) errors.push('Every CMTP line needs a head, sub-item and nonnegative amount; at least one line is required.');
  }
  if (required.has('documents')) {
    if (!/^https?:\/\/\S+$/i.test(value.documents.rfp_link)) errors.push('A valid RFP sheet link is required.');
    if (isNew && !(/^https?:\/\/\S+$/i.test(value.documents.cad_link) || value.documents.files.some(file => /^https?:\/\/\S+$/i.test(file.link_url ?? '')))) errors.push('A valid CAD reference link is required for a new submission.');
    if (isNew && !value.documents.files.some(f => f.file_path && /\.pdf$/i.test(f.file_name ?? ''))) errors.push('Upload at least one CAD PDF for this new submission.');
    for (const f of value.documents.files) {
      if (!['single_piece', 'full_layer', 'standard_ratio', 'ratio_1_1'].includes(f.doc_group) || (f.doc_group === 'full_layer' && !f.width?.trim()) || (!f.file_path && !/^https?:\/\/\S+$/i.test(f.link_url ?? ''))) errors.push('Complete every CAD entry and width for full-layer plans.');
    }
  }
  return [...new Set(errors)];
}
