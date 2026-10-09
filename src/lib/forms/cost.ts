import type { SdRole } from './types';

/**
 * Cost Approval is its own process — a real negotiation, not a plain approval:
 *   propose (team) → target cost (admin) → actual rate (team) → sign-off (admin).
 * Plus renegotiate (admin sends back) and reject. The stage lives in its own
 * `neg_stage` column; sign-off is what flips the record's sd_status to 'approved'.
 * Kept separate from approval.ts so the cost flow stays a distinct process.
 */

export type CostStage =
  | 'proposed'
  | 'target_set'
  | 'rate_submitted'
  | 'signed_off'
  | 'renegotiate'
  | 'rejected';

const RANK: Record<SdRole, number> = { viewer: 0, team: 1, admin: 2 };
const isTeam = (r: SdRole) => RANK[r] >= RANK.team;
const isAdmin = (r: SdRole) => RANK[r] >= RANK.admin;

// Cost stages in the approval workflow's words (spec 2026-10-08): the two stages waiting on the
// admin read Approval Pending; renegotiate is Rework / Reassign; rejected is Rejected / Discarded.
export const COST_STAGE_LABEL: Record<string, string> = {
  '': 'Not started',
  proposed: 'Approval Pending · Proposal',
  target_set: 'Target set · with the team',
  rate_submitted: 'Approval Pending · Vendor rate',
  signed_off: 'Approved',
  renegotiate: 'Rework / Reassign',
  rejected: 'Rejected / Discarded',
};

/**
 * A cost's stage as shown on badges. Approved carries its sub status: Edited & Approved when
 * the admin set a target (changed the rate) in this round, First time Approved otherwise.
 */
export function costStageText(
  stage: string | null | undefined,
  row?: { target_job?: number | null; target_fob?: number | null; target_efob?: number | null; target_cost?: number | null } | null,
): string {
  const key = stage ?? '';
  if (key === 'signed_off') {
    const edited = Boolean(row && (row.target_job != null || row.target_fob != null || row.target_efob != null || row.target_cost != null));
    return edited ? 'Edited & Approved' : 'First time Approved';
  }
  return COST_STAGE_LABEL[key] ?? 'Not started';
}

/** Maps onto the existing .tone-* badge classes. */
export const COST_STAGE_TONE: Record<string, string> = {
  '': 'purple',
  proposed: 'blue',
  target_set: 'orange',
  rate_submitted: 'orange',
  renegotiate: 'orange',
  signed_off: 'teal',
  rejected: 'red',
};

/** Whose turn it is at a given stage — shown as a hint on the row. */
export function nextActor(stage: string | null): string {
  switch (stage ?? '') {
    case '':
      return 'Team — propose';
    case 'proposed':
      return 'Admin — accept, reject or set target';
    case 'target_set':
      return 'Team — enter actual rate';
    case 'rate_submitted':
      return 'Admin — approve';
    case 'renegotiate':
      return 'Team — re-enter rate';
    case 'signed_off':
      return 'Accepted — team may re-propose to revise';
    default:
      return '—';
  }
}

// A signed-off cost can be re-proposed to start a fresh negotiation round — the
// current accepted rate stays live (from history) until the new one is accepted.
// Until approved, everything is amendable: a proposal still awaiting the admin
// ('proposed') can be revised — it stays Approval Pending with the new figures.
export const canPropose = (role: SdRole, stage: string | null) =>
  isTeam(role) && (!stage || stage === 'proposed' || stage === 'rejected' || stage === 'signed_off');
/** The approver may set or change a target, for any rate type, at any stage (a frozen cost
 *  is refused by the action). The team is notified and owes a vendor rate against it. */
export const canSetTarget = (role: SdRole, _stage?: string | null) => isAdmin(role);
/** Admin may also accept a proposal as-is — the proposed rates become the standard. */
export const canAcceptProposal = (role: SdRole, stage: string | null) =>
  isAdmin(role) && stage === 'proposed';
/** Whose turn is a row waiting on? Drives the bell + the awaiting-action chip. */
export const isAdminTurn = (stage: string | null) =>
  stage === 'proposed' || stage === 'rate_submitted';
export const isTeamTurn = (stage: string | null) =>
  stage === 'target_set' || stage === 'renegotiate';
/** The team enters the vendor rate against a target, and may revise it while it still awaits
 *  approval ('rate_submitted') — the revised rate stays Approval Pending. */
export const canSubmitRate = (role: SdRole, stage: string | null) =>
  isTeam(role) && (stage === 'target_set' || stage === 'renegotiate' || stage === 'rate_submitted');
export const canSignOff = (role: SdRole, stage: string | null) =>
  isAdmin(role) && stage === 'rate_submitted';
/** Edit & approve: the admin changes the rates on a cost awaiting approval and approves in one step. */
export const canEditApproveCost = (role: SdRole, stage: string | null) =>
  isAdmin(role) && (stage === 'proposed' || stage === 'rate_submitted');
export const canRenegotiate = (role: SdRole, stage: string | null) =>
  isAdmin(role) && stage === 'rate_submitted';
export const canRejectCost = (role: SdRole, stage: string | null) =>
  isAdmin(role) && (stage === 'proposed' || stage === 'rate_submitted');

// Sequential sign-off (FG): confirm the fabric rate first, then the CM/other rate.
export const canConfirmFabric = (role: SdRole, stage: string | null, fabricConfirmed: boolean) =>
  isAdmin(role) && stage === 'rate_submitted' && !fabricConfirmed;
export const canConfirmCm = (
  role: SdRole,
  stage: string | null,
  fabricConfirmed: boolean,
  cmConfirmed: boolean,
) => isAdmin(role) && stage === 'rate_submitted' && fabricConfirmed && !cmConfirmed;

/**
 * CMTP cost breakdown — the core mandatory heads ("the core architecture").
 * Mandatory heads always render (blank = not yet costed); the team can add extra
 * line items under any head, and add custom heads ad hoc. `suggest` seeds the
 * real operation lines that roll up under a head (from the live CMTP cost sheet):
 * Labour → Karigar + Thekedar Comission (the "Absolute labour Cost"), etc. The
 * sum of every line is the FINAL CMTP.
 */
export const CMTP_HEADS: { key: string; label: string; suggest?: string[] }[] = [
  { key: 'Labour', label: 'Labour', suggest: ['Karigar', 'Thekedar Comission'] },
  { key: 'Cutting', label: 'Cutting', suggest: ['Cutting'] },
  {
    key: 'Finishing',
    label: 'Finishing',
    suggest: ['Fabric QC', 'Iron', 'Thread Cutting', 'Final QC', 'Folding'],
  },
  { key: 'Packaging', label: 'Packaging', suggest: ['Packing - poly bag'] },
  { key: 'Product Trims', label: 'Product Trims', suggest: ['Thread', 'Fusing', 'Button', 'Kaaj'] },
  { key: 'Brand Trims', label: 'Brand Trims', suggest: ['Brand Trims'] },
];

export const CMTP_MANDATORY = CMTP_HEADS.map((h) => h.key);

/* ------------------------------------------------------------------ */
/* Targets per rate type                                               */
/* ------------------------------------------------------------------ */

export type RateKey = 'job' | 'fob' | 'efob';
export const RATE_KEYS: RateKey[] = ['job', 'fob', 'efob'];

/** What each rate slot is called on each track. */
export const RATE_LABELS: Record<'fg' | 'material', Record<RateKey, string>> = {
  fg: { job: 'Job', fob: 'FOB', efob: 'E-FOB' },
  material: { job: 'FOB Fabric', fob: 'Billing', efob: 'Standard Fabric' },
};

export type TargetFields = {
  target_cost?: number | null;
  target_job?: number | null;
  target_fob?: number | null;
  target_efob?: number | null;
};

/**
 * The approver's target(s), labelled by rate type. A target set before targets were per type
 * (only target_cost) reads as "Overall", because its type was never recorded.
 */
export function targetParts(c: TargetFields, track: 'fg' | 'material'): { label: string; value: number }[] {
  const labels = RATE_LABELS[track];
  const parts = RATE_KEYS.flatMap((k) => {
    const v = c[`target_${k}` as const];
    return v == null ? [] : [{ label: labels[k], value: Number(v) }];
  });
  if (parts.length) return parts;
  return c.target_cost == null ? [] : [{ label: 'Overall', value: Number(c.target_cost) }];
}

/** "Job ₹100 · FOB ₹90", or null when no target is set. */
export function targetSummary(c: TargetFields, track: 'fg' | 'material', money = (v: number) => `₹${v}`): string | null {
  const parts = targetParts(c, track);
  return parts.length ? parts.map((p) => `${p.label} ${money(p.value)}`).join(' · ') : null;
}

/** The rate types a target can be set for: all three, any time (the approver decides). */
export function targetKeysFor(_c?: { job_cost: number | null; fob_cost: number | null; efob_cost: number | null }): RateKey[] {
  return RATE_KEYS;
}
