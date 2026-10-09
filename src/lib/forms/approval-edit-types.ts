// Edit & approve: the shapes passed between the approver's edit dialog and the server.
// Plain module (no 'use server' / 'use client') so both sides can import the types.

export type ApprovalEditKind = 'int' | 'money' | 'date' | 'text';

export type ApprovalEditField = {
  key: string;
  label: string;
  kind: ApprovalEditKind;
  /** Current value as text ('' when empty). */
  value: string;
};

export type ApprovalEditRow = {
  /** 'header' for the record itself, else the line id / row key. */
  ref: string;
  label: string;
  sub?: string;
  fields: ApprovalEditField[];
};

export type ApprovalEditForm = {
  title: string;
  /** What changes when values are edited (e.g. plan value is re-priced). */
  note?: string;
  rows: ApprovalEditRow[];
};

export type ApprovalEditChange = { ref: string; key: string; value: string };

/** Entities whose approval offers Edit & approve (a deletion has nothing to edit). */
export const EDITABLE_APPROVALS = [
  'buying_plan',
  'po_approval',
  'po_amendment',
  'discontinue',
  'vendor_deboarding',
  'vendor_commercial',
  'inward_plan',
  'receivable_plan',
] as const;
