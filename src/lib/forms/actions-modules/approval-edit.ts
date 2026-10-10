'use server';

import { revalidatePath } from 'next/cache';
import { currentUser, loadApprovedMaterialCosts, loadApprovedStandardCosts } from '../queries';
import { canApprove, isPlanFrozen } from '../approval';
import type { ApprovalEntity, SdStatus } from '../types';
import type { ApprovalEditChange, ApprovalEditField, ApprovalEditForm, ApprovalEditKind, ApprovalEditRow } from '../approval-edit-types';
import { decideApproval } from './approval';
import { approveBuyingPlanLines } from './buying-plan';
import { type ActionResult, fail, supa } from './_shared';

/*
 * Edit & approve. Wherever a submission waits for approval, the approver may change the values
 * that were submitted and approve in one step. The server owns what can be edited (the form is
 * built here, never trusted from the client); every changed value is recorded in
 * sd_approval_edit, the record (and edited lines) are flagged approver_edited, and the approval
 * itself goes through decideApproval so every rule there (levels, TNA gate, logging, notices)
 * still applies. If the approval is refused, the edits are put back.
 */

// The typed client cannot follow table names chosen at runtime; this is the narrow shape used.
type Db = {
  from: (table: string) => {
    select: (cols: string) => QueryChain;
    update: (patch: Record<string, unknown>) => QueryChain;
    insert: (rows: Record<string, unknown>[]) => Promise<{ error: { message: string } | null }>;
  };
};
type QueryChain = {
  eq: (col: string, v: unknown) => QueryChain;
  in: (col: string, v: unknown[]) => QueryChain;
  order: (col: string) => QueryChain;
  limit: (n: number) => QueryChain;
  maybeSingle: () => Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }>;
  then: Promise<{ data: Record<string, unknown>[] | null; error: { message: string } | null }>['then'];
};

const PENDING: SdStatus[] = ['submitted', 'pending_l2'];

/** Where each editable row lives, so the save can write it and put it back. */
type RowTarget = { ref: string; table: string; keyCol: string; key: unknown };
type Built = { form: ApprovalEditForm; targets: Map<string, RowTarget>; status: SdStatus; header?: { table: string; id: number } };

const text = (v: unknown) => (v == null ? '' : String(v));
const dateText = (v: unknown) => (v == null ? '' : String(v).slice(0, 10));
const f = (key: string, label: string, kind: ApprovalEditKind, value: unknown): ApprovalEditField => ({
  key,
  label,
  kind,
  value: kind === 'date' ? dateText(value) : text(value),
});

async function buildForm(db: Db, entity: ApprovalEntity, idText: string): Promise<Built | { error: string }> {
  const id = Number(idText);
  const header = async (table: string) => {
    const { data } = await db.from(table).select('*').eq('id', id).maybeSingle();
    return data;
  };

  if (entity === 'buying_plan') {
    const plan = await header('sd_buying_plan');
    if (!plan) return { error: 'Plan not found.' };
    // A buying plan whose month is over is view only (user rule, 2026-10-08).
    if (isPlanFrozen(String(plan.plan_month))) return { error: `The ${String(plan.plan_month).slice(0, 7)} plan is view only — its month is over.` };
    const material = plan.plan_type === 'material';
    // paging-ok: the lines of one plan, a few dozen at most
    const { data: lines } = await db
      .from('sd_buying_plan_line')
      .select('id, product_code, product_status, colour, uom, job_work_qty, fob_qty, efob_qty')
      .eq('plan_id', id)
      .order('id')
      .limit(1000);
    const rows: ApprovalEditRow[] = [];
    const targets = new Map<string, RowTarget>();
    for (const l of lines ?? []) {
      const qty = Number(l.job_work_qty || 0) + Number(l.fob_qty || 0) + Number(l.efob_qty || 0);
      if (qty <= 0) continue;
      const ref = String(l.id);
      rows.push({
        ref,
        label: text(l.product_code),
        sub: material ? [l.colour, l.uom].filter(Boolean).join(' · ') || undefined : text(l.product_status) || undefined,
        fields: material
          ? [f('job_work_qty', 'Job work', 'int', l.job_work_qty), f('fob_qty', 'Purchase', 'int', l.fob_qty)]
          : [f('job_work_qty', 'Job', 'int', l.job_work_qty), f('efob_qty', 'E-FOB', 'int', l.efob_qty), f('fob_qty', 'FOB', 'int', l.fob_qty)],
      });
      targets.set(ref, { ref, table: 'sd_buying_plan_line', keyCol: 'id', key: l.id });
    }
    return {
      form: {
        title: `${material ? 'Material' : 'Buying'} plan ${text(plan.plan_month).slice(0, 7)}`,
        note: 'Edited lines are re-priced at the approved standard cost, the same way the plan was valued at submission.',
        rows,
      },
      targets,
      status: plan.status as SdStatus,
      header: { table: 'sd_buying_plan', id },
    };
  }

  if (entity === 'po_approval') {
    const po = await header('sd_po_approval');
    if (!po) return { error: 'PO not found.' };
    // paging-ok: the size lines of one PO
    const { data: lines } = await db.from('sd_po_approval_line').select('id, product_variant, size, qty').eq('po_id', id).order('id').limit(1000);
    const targets = new Map<string, RowTarget>([['header', { ref: 'header', table: 'sd_po_approval', keyCol: 'id', key: id }]]);
    const rows: ApprovalEditRow[] = [
      {
        ref: 'header',
        label: `${text(po.product_code)} · ${text(po.vendor_name)}`,
        sub: text(po.po_ref_num || po.request_id) || undefined,
        fields: [
          f('rate', 'Rate (₹ / pc)', 'money', po.rate),
          f('po_closing_date', 'PO closing date', 'date', po.po_closing_date),
          f('critical_path_first_delivery', 'First delivery', 'date', po.critical_path_first_delivery),
          ...((lines ?? []).length ? [] : [f('po_qty', 'PO qty', 'int', po.po_qty)]),
        ],
      },
    ];
    for (const l of lines ?? []) {
      const ref = String(l.id);
      rows.push({ ref, label: [l.product_variant, l.size].filter(Boolean).join(' · ') || `Line ${ref}`, fields: [f('qty', 'Qty', 'int', l.qty)] });
      targets.set(ref, { ref, table: 'sd_po_approval_line', keyCol: 'id', key: l.id });
    }
    return {
      form: { title: po.po_ref_num ? `PO ${text(po.po_ref_num)}` : `PO request ${text(po.request_id) || `#${id}`}`, note: (lines ?? []).length ? 'PO qty is the total of the size lines and follows any change to them.' : undefined, rows },
      targets,
      status: po.status as SdStatus,
      header: { table: 'sd_po_approval', id },
    };
  }

  if (entity === 'po_amendment') {
    const a = await header('sd_po_amendment');
    if (!a) return { error: 'Amendment not found.' };
    const fields: ApprovalEditField[] = [];
    if (a.new_rate != null || a.current_rate != null) fields.push(f('new_rate', `New rate (now ₹${text(a.current_rate) || '—'})`, 'money', a.new_rate));
    if (a.new_qty != null || a.current_qty != null) fields.push(f('new_qty', `New qty (now ${text(a.current_qty) || '—'})`, 'int', a.new_qty));
    if (a.new_delivery_date != null || a.current_delivery_date != null)
      fields.push(f('new_delivery_date', `New delivery date (now ${dateText(a.current_delivery_date) || '—'})`, 'date', a.new_delivery_date));
    fields.push(f('reason', 'Reason', 'text', a.reason));
    return {
      form: { title: `Amendment to PO ${text(a.po_ref_num || a.po_number)}`, rows: [{ ref: 'header', label: text(a.amendment_type) || 'Amendment', sub: text(a.vendor_name) || undefined, fields }] },
      targets: new Map([['header', { ref: 'header', table: 'sd_po_amendment', keyCol: 'id', key: id }]]),
      status: a.status as SdStatus,
      header: { table: 'sd_po_amendment', id },
    };
  }

  if (entity === 'discontinue') {
    const d = await header('sd_discontinue_request');
    if (!d) return { error: 'Request not found.' };
    return {
      form: {
        title: `Discontinue ${text(d.product_code)}`,
        rows: [{ ref: 'header', label: [d.product_code, d.product_variant, d.size].filter(Boolean).join(' · '), sub: text(d.scope) || undefined, fields: [f('reason', 'Reason', 'text', d.reason)] }],
      },
      targets: new Map([['header', { ref: 'header', table: 'sd_discontinue_request', keyCol: 'id', key: id }]]),
      status: d.status as SdStatus,
      header: { table: 'sd_discontinue_request', id },
    };
  }

  if (entity === 'vendor_deboarding') {
    const v = await header('sd_vendor_deboarding_request');
    if (!v) return { error: 'Request not found.' };
    return {
      form: {
        title: `De-board ${text(v.vendor_name || v.vendor_code)}`,
        rows: [{ ref: 'header', label: text(v.vendor_name || v.vendor_code), sub: text(v.reason) || undefined, fields: [f('remarks', 'Remarks', 'text', v.remarks)] }],
      },
      targets: new Map([['header', { ref: 'header', table: 'sd_vendor_deboarding_request', keyCol: 'id', key: id }]]),
      status: v.status as SdStatus,
      header: { table: 'sd_vendor_deboarding_request', id },
    };
  }

  if (entity === 'vendor_commercial') {
    const c = await header('sd_vendor_commercial_request');
    if (!c) return { error: 'Request not found.' };
    const t = text(c.request_type);
    // What the approver may change: the figures the request turns on, and the remarks.
    const fields =
      t === 'hold_waiver'
        ? [f('hold_qty', 'Hold qty', 'int', c.hold_qty), f('hold_days', 'Days hold asked', 'int', c.hold_days), f('ready_date', 'Ready date', 'date', c.ready_date)]
        : t === 'cost_increment'
          ? [f('increment_amount', 'Increment amount (₹)', 'money', c.increment_amount)]
          : t === 'cash_discount'
            ? [f('invoice_amount', 'Invoice amount (₹)', 'money', c.invoice_amount), f('invoice_date', 'Invoice date', 'date', c.invoice_date)]
            : t === 'credit_note'
              ? [f('credit_amount', 'Credit note amount (₹)', 'money', c.credit_amount)]
              : [f('debit_note_number', 'Debit note number', 'text', c.debit_note_number)];
    return {
      form: {
        title: `Commercial approval — ${text(c.vendor_name || c.vendor_code)}`,
        rows: [{ ref: 'header', label: text(c.vendor_name || c.vendor_code), sub: `PO ${text(c.po_numbers)}`, fields: [...fields, f('remarks', 'Remarks', 'text', c.remarks)] }],
      },
      targets: new Map([['header', { ref: 'header', table: 'sd_vendor_commercial_request', keyCol: 'id', key: id }]]),
      status: c.status as SdStatus,
      header: { table: 'sd_vendor_commercial_request', id },
    };
  }

  if (entity === 'inward_plan') {
    if (!/^\d{4}-\d{2}-01$/.test(idText)) return { error: 'Invalid plan month.' };
    // paging-ok: one month's pending inward lines, a few dozen
    const { data: lines } = await db
      .from('sd_inward_plan_entry')
      .select('id, po_no, product_code, vendor_name, inward_qty, cost_per_piece')
      .eq('plan_month', idText)
      .eq('approval_status', 'Pending')
      .order('id')
      .limit(1000);
    const targets = new Map<string, RowTarget>();
    const rows: ApprovalEditRow[] = (lines ?? []).map((l) => {
      const ref = String(l.id);
      targets.set(ref, { ref, table: 'sd_inward_plan_entry', keyCol: 'id', key: l.id });
      return {
        ref,
        label: [l.po_no, l.product_code].filter(Boolean).join(' · ') || `Line ${ref}`,
        sub: text(l.vendor_name) || undefined,
        fields: [f('inward_qty', 'Inward qty', 'int', l.inward_qty), f('cost_per_piece', '₹ / pc', 'money', l.cost_per_piece)],
      };
    });
    return { form: { title: `Inward plan ${idText.slice(0, 7)}`, rows }, targets, status: 'pending_l2' };
  }

  if (entity === 'receivable_plan') {
    // paging-ok: one submitted receivable batch
    const { data: lines } = await db
      .from('sd_receivable_input')
      .select('row_key, po_number, product_variant, qty_expected_this_week, delivery_date_this_week')
      .eq('status', 'submitted')
      .order('row_key')
      .limit(1000);
    const targets = new Map<string, RowTarget>();
    const rows: ApprovalEditRow[] = (lines ?? []).map((l) => {
      const ref = text(l.row_key);
      targets.set(ref, { ref, table: 'sd_receivable_input', keyCol: 'row_key', key: l.row_key });
      return {
        ref,
        label: [l.po_number, l.product_variant].filter(Boolean).join(' · ') || ref,
        fields: [f('qty_expected_this_week', 'Expected qty', 'int', l.qty_expected_this_week), f('delivery_date_this_week', 'Delivery date', 'date', l.delivery_date_this_week)],
      };
    });
    return { form: { title: 'Inward plan (weekly)', rows }, targets, status: 'submitted' };
  }

  return { error: 'This approval has nothing to edit.' };
}

/** Normalise an entered value for its kind; null = invalid. '' clears a value. */
function normalise(kind: ApprovalEditKind, raw: string): string | null {
  const v = raw.trim();
  if (v === '') return '';
  if (kind === 'int') return /^\d+$/.test(v.replace(/,/g, '')) ? String(Number(v.replace(/,/g, ''))) : null;
  if (kind === 'money') {
    const n = Number(v.replace(/,/g, ''));
    return Number.isFinite(n) && n >= 0 ? String(Math.round(n * 100) / 100) : null;
  }
  if (kind === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null;
  return v.slice(0, 2000);
}
const dbValue = (kind: ApprovalEditKind, v: string) => (v === '' ? null : kind === 'int' || kind === 'money' ? Number(v) : v);
const same = (kind: ApprovalEditKind, a: string, b: string) =>
  kind === 'int' || kind === 'money' ? (a === '' ? b === '' : b !== '' && Number(a) === Number(b)) : a === b;

/** The editable values of a pending approval, for the approver's Edit & approve dialog. */
export async function getApprovalEditForm(entityType: ApprovalEntity, entityId: string): Promise<{ ok: true; form: ApprovalEditForm } | { ok: false; error: string }> {
  const user = await currentUser();
  if (!user) return { ok: false, error: 'Not signed in.' };
  const db = (await supa()) as unknown as Db;
  const built = await buildForm(db, entityType, entityId);
  if ('error' in built) return { ok: false, error: built.error };
  if (!PENDING.includes(built.status)) return { ok: false, error: 'This is no longer waiting for approval.' };
  if (!canApprove(user.role, built.status)) return { ok: false, error: 'This decision is above your approval level.' };
  if (!built.form.rows.length) return { ok: false, error: 'There is nothing pending to edit here.' };
  return { ok: true, form: built.form };
}

/** Apply the approver's edits, then approve. Edits are put back if the approval is refused. */
export async function editAndApprove(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  const entityType = String(formData.get('entity_type') ?? '') as ApprovalEntity;
  const entityId = String(formData.get('entity_id') ?? '');
  const label = String(formData.get('entity_label') ?? '');
  const notes = String(formData.get('notes') ?? '').trim();
  let changes: ApprovalEditChange[];
  try {
    changes = JSON.parse(String(formData.get('changes') ?? '[]'));
  } catch {
    return fail('Invalid edits.');
  }

  const db = (await supa()) as unknown as Db;
  const built = await buildForm(db, entityType, entityId);
  if ('error' in built) return fail(built.error);
  if (!PENDING.includes(built.status)) return fail('This is no longer waiting for approval.');
  if (!canApprove(user.role, built.status)) return fail('This decision is above your approval level.');

  // Keep only real changes to fields the server offered.
  const rowsByRef = new Map(built.form.rows.map((r) => [r.ref, r]));
  type Edit = { row: ApprovalEditRow; field: ApprovalEditField; next: string };
  const edits: Edit[] = [];
  for (const c of changes) {
    const row = rowsByRef.get(String(c.ref));
    const field = row?.fields.find((x) => x.key === c.key);
    if (!row || !field) return fail('One of the edited values is not editable here.');
    const next = normalise(field.kind, String(c.value ?? ''));
    if (next == null) return fail(`${row.label}: "${c.value}" is not a valid ${field.label.toLowerCase()}.`);
    if (!same(field.kind, field.value, next)) edits.push({ row, field, next });
  }
  if (!edits.length) return fail('Nothing was changed. Use Approve to approve it as submitted.');

  // Group per row, write, remembering the old values to put back.
  const byRef = new Map<string, Edit[]>();
  for (const e of edits) byRef.set(e.row.ref, [...(byRef.get(e.row.ref) ?? []), e]);
  const undo: { target: RowTarget; patch: Record<string, unknown> }[] = [];
  const write = async (target: RowTarget, patch: Record<string, unknown>) =>
    (await db.from(target.table).update(patch).eq(target.keyCol, target.key)) as unknown as { error: { message: string } | null };

  for (const [ref, list] of byRef) {
    const target = built.targets.get(ref);
    if (!target) return fail('Edited row not found.');
    const patch: Record<string, unknown> = { approver_edited: true };
    const back: Record<string, unknown> = {};
    for (const e of list) {
      patch[e.field.key] = dbValue(e.field.kind, e.next);
      back[e.field.key] = dbValue(e.field.kind, e.field.value);
    }
    const { data: prev } = await db.from(target.table).select('approver_edited').eq(target.keyCol, target.key).maybeSingle();
    back.approver_edited = Boolean(prev?.approver_edited);
    const { error } = await write(target, patch);
    if (error) {
      for (const u of undo.reverse()) await write(u.target, u.patch);
      return fail(error.message);
    }
    undo.push({ target, patch: back });
  }

  // Follow-on values: a plan line is re-priced; a PO's qty follows its size lines.
  if (entityType === 'buying_plan' && built.header) {
    const { data: plan } = await db.from('sd_buying_plan').select('plan_type').eq('id', built.header.id).maybeSingle();
    const material = plan?.plan_type === 'material';
    const costs = material ? await loadApprovedMaterialCosts() : await loadApprovedStandardCosts();
    for (const ref of byRef.keys()) {
      const { data: l } = await db.from('sd_buying_plan_line').select('id, product_code, job_work_qty, fob_qty, efob_qty, standard_value').eq('id', Number(ref)).maybeSingle();
      if (!l) continue;
      const c = (costs as Record<string, { job: number; fob: number; efob?: number }>)[text(l.product_code)];
      if (!c) continue;
      const value = Number(l.job_work_qty || 0) * c.job + Number(l.fob_qty || 0) * c.fob + (material ? 0 : Number(l.efob_qty || 0) * (c.efob ?? 0));
      undo.push({ target: { ref, table: 'sd_buying_plan_line', keyCol: 'id', key: l.id }, patch: { standard_value: l.standard_value } });
      await write({ ref, table: 'sd_buying_plan_line', keyCol: 'id', key: l.id }, { standard_value: value > 0 ? value : null });
    }
  }
  if (entityType === 'po_approval' && built.header && [...byRef.keys()].some((r) => r !== 'header')) {
    // paging-ok: the size lines of one PO
    const { data: lines } = await db.from('sd_po_approval_line').select('qty').eq('po_id', built.header.id).limit(1000);
    const total = (lines ?? []).reduce((s, l) => s + Number(l.qty || 0), 0);
    const { data: po } = await db.from('sd_po_approval').select('po_qty').eq('id', built.header.id).maybeSingle();
    undo.push({ target: { ref: 'header', table: 'sd_po_approval', keyCol: 'id', key: built.header.id }, patch: { po_qty: po?.po_qty ?? null } });
    await write({ ref: 'header', table: 'sd_po_approval', keyCol: 'id', key: built.header.id }, { po_qty: total });
  }
  // The record itself is marked edited even when only its lines changed.
  if (built.header && !byRef.has('header')) {
    const { data: prev } = await db.from(built.header.table).select('approver_edited').eq('id', built.header.id).maybeSingle();
    const target = { ref: 'header', table: built.header.table, keyCol: 'id', key: built.header.id };
    undo.push({ target, patch: { approver_edited: Boolean(prev?.approver_edited) } });
    await write(target, { approver_edited: true });
  }

  // Approve through the one approval path; the edits go into the recorded comment.
  const summary = edits
    .slice(0, 8)
    .map((e) => `${e.row.label} ${e.field.label} ${e.field.value || '—'} → ${e.next || '—'}`)
    .join('; ');
  const recorded = `Edited by the approver: ${summary}${edits.length > 8 ? `; and ${edits.length - 8} more` : ''}.${notes ? ` ${notes}` : ''}`;
  const approval = new FormData();
  approval.set('entity_type', entityType);
  approval.set('entity_id', entityId);
  approval.set('entity_label', label);
  approval.set('decision', 'approve');
  approval.set('notes', recorded.slice(0, 1900));
  const result = await decideApproval(approval);
  if (!result.ok) {
    for (const u of undo.reverse()) await write(u.target, u.patch);
    return result;
  }

  const now = new Date().toISOString();
  const { error: logError } = await db.from('sd_approval_edit').insert(
    edits.map((e) => ({
      entity_type: entityType,
      entity_id: entityId,
      row_ref: e.row.ref,
      row_label: e.row.label,
      field: e.field.key,
      field_label: e.field.label,
      old_value: e.field.value || null,
      new_value: e.next || null,
      edited_by: user.email,
      edited_at: now,
    })),
  );
  if (logError) console.error('[approval-edit] edit history not recorded:', logError.message);

  revalidatePath('/receivable-plan');
  revalidatePath('/approvals');
  return { ok: true, message: `Approved with ${edits.length} edit${edits.length === 1 ? '' : 's'}.` };
}

/**
 * Buying plan, per line: the approver changed quantities on some lines (on the plan's cards
 * or table) and approves them, together with any other ticked lines approved as they are.
 * Each changed value is written, the line re-priced at the approved cost and flagged
 * approver_edited, the plan flagged too, and every change recorded in sd_approval_edit — the
 * same record Edit & approve keeps. The approval itself goes through approveBuyingPlanLines;
 * if it is refused, the edits are put back.
 *   edits      = [{ lineId, job_work_qty?, efob_qty?, fob_qty? }]
 *   approve_ids = other line ids to approve unchanged
 */
export async function editAndApprovePlanLines(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  const planId = String(formData.get('plan_id') ?? '');
  let editsIn: Record<string, unknown>[] = [];
  let approveIds: number[] = [];
  try {
    editsIn = JSON.parse(String(formData.get('edits') ?? '[]'));
    approveIds = (JSON.parse(String(formData.get('approve_ids') ?? '[]')) as unknown[]).map(Number).filter((n) => n > 0);
  } catch {
    return fail('Invalid edits.');
  }

  const db = (await supa()) as unknown as Db;
  const built = await buildForm(db, 'buying_plan', planId);
  if ('error' in built) return fail(built.error);
  if (!PENDING.includes(built.status)) return fail('This plan is no longer waiting for approval.');
  if (!canApprove(user.role, built.status)) return fail('This decision is above your approval level.');

  const rowsByRef = new Map(built.form.rows.map((r) => [r.ref, r]));
  type Edit = { row: ApprovalEditRow; field: ApprovalEditField; next: string };
  const edits: Edit[] = [];
  for (const e of editsIn) {
    const row = rowsByRef.get(String(e.lineId));
    if (!row) return fail('One of the edited lines cannot be edited here.');
    for (const field of row.fields) {
      if (!(field.key in e)) continue;
      const next = normalise(field.kind, String(e[field.key] ?? ''));
      if (next == null) return fail(`${row.label}: "${String(e[field.key])}" is not a valid ${field.label.toLowerCase()}.`);
      if (!same(field.kind, field.value, next)) edits.push({ row, field, next });
    }
  }

  const write = async (target: RowTarget, patch: Record<string, unknown>) =>
    (await db.from(target.table).update(patch).eq(target.keyCol, target.key)) as unknown as { error: { message: string } | null };
  const undo: { target: RowTarget; patch: Record<string, unknown> }[] = [];
  const byRef = new Map<string, Edit[]>();
  for (const e of edits) byRef.set(e.row.ref, [...(byRef.get(e.row.ref) ?? []), e]);

  for (const [ref, list] of byRef) {
    const target = built.targets.get(ref);
    if (!target) return fail('Edited line not found.');
    const patch: Record<string, unknown> = { approver_edited: true };
    const back: Record<string, unknown> = {};
    for (const e of list) {
      patch[e.field.key] = dbValue(e.field.kind, e.next);
      back[e.field.key] = dbValue(e.field.kind, e.field.value);
    }
    const { data: prev } = await db.from(target.table).select('approver_edited, standard_value').eq(target.keyCol, target.key).maybeSingle();
    back.approver_edited = Boolean(prev?.approver_edited);
    back.standard_value = prev?.standard_value ?? null;
    const { error } = await write(target, patch);
    if (error) {
      for (const u of undo.reverse()) await write(u.target, u.patch);
      return fail(error.message);
    }
    undo.push({ target, patch: back });
  }

  if (byRef.size && built.header) {
    // Re-price the edited lines at the approved cost, as the plan was valued at submission.
    const { data: plan } = await db.from('sd_buying_plan').select('plan_type, approver_edited').eq('id', built.header.id).maybeSingle();
    const material = plan?.plan_type === 'material';
    const costs = material ? await loadApprovedMaterialCosts() : await loadApprovedStandardCosts();
    for (const ref of byRef.keys()) {
      const { data: l } = await db.from('sd_buying_plan_line').select('id, product_code, job_work_qty, fob_qty, efob_qty').eq('id', Number(ref)).maybeSingle();
      if (!l) continue;
      const c = (costs as Record<string, { job: number; fob: number; efob?: number }>)[text(l.product_code)];
      if (!c) continue;
      const value = Number(l.job_work_qty || 0) * c.job + Number(l.fob_qty || 0) * c.fob + (material ? 0 : Number(l.efob_qty || 0) * (c.efob ?? 0));
      await write({ ref, table: 'sd_buying_plan_line', keyCol: 'id', key: l.id }, { standard_value: value > 0 ? value : null });
    }
    const target = { ref: 'header', table: built.header.table, keyCol: 'id', key: built.header.id };
    undo.push({ target, patch: { approver_edited: Boolean(plan?.approver_edited) } });
    await write(target, { approver_edited: true });
  }

  const ids = [...new Set([...[...byRef.keys()].map(Number), ...approveIds])];
  if (!ids.length) return fail('Nothing to approve.');
  const approval = new FormData();
  approval.set('plan_id', planId);
  approval.set('line_ids', JSON.stringify(ids));
  const result = await approveBuyingPlanLines(approval);
  if (!result.ok) {
    for (const u of undo.reverse()) await write(u.target, u.patch);
    return result;
  }

  if (edits.length) {
    const now = new Date().toISOString();
    const { error: logError } = await db.from('sd_approval_edit').insert(
      edits.map((e) => ({
        entity_type: 'buying_plan',
        entity_id: planId,
        row_ref: e.row.ref,
        row_label: e.row.label,
        field: e.field.key,
        field_label: e.field.label,
        old_value: e.field.value || null,
        new_value: e.next || null,
        edited_by: user.email,
        edited_at: now,
      })),
    );
    if (logError) console.error('[approval-edit] edit history not recorded:', logError.message);
  }
  revalidatePath('/buying-plan');
  revalidatePath('/approvals');
  const n = byRef.size;
  return {
    ok: true,
    message: n ? `${result.message ?? 'Approved.'} ${n} line${n === 1 ? '' : 's'} edited and approved.` : result.message ?? 'Approved.',
  };
}
