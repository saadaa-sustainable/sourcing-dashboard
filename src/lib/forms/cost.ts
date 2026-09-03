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

export const COST_STAGE_LABEL: Record<string, string> = {
  '': 'Not started',
  proposed: 'Proposed',
  target_set: 'Target set',
  rate_submitted: 'Rate submitted',
  signed_off: 'Signed off',
  renegotiate: 'Renegotiate',
  rejected: 'Rejected',
};

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
      return 'Admin — sign off';
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
export const canPropose = (role: SdRole, stage: string | null) =>
  isTeam(role) && (!stage || stage === 'rejected' || stage === 'signed_off');
export const canSetTarget = (role: SdRole, stage: string | null) =>
  isAdmin(role) && stage === 'proposed';
/** Admin may also accept a proposal as-is — the proposed rates become the standard. */
export const canAcceptProposal = (role: SdRole, stage: string | null) =>
  isAdmin(role) && stage === 'proposed';
/** Whose turn is a row waiting on? Drives the bell + the awaiting-action chip. */
export const isAdminTurn = (stage: string | null) =>
  stage === 'proposed' || stage === 'rate_submitted';
export const isTeamTurn = (stage: string | null) =>
  stage === 'target_set' || stage === 'renegotiate';
export const canSubmitRate = (role: SdRole, stage: string | null) =>
  isTeam(role) && (stage === 'target_set' || stage === 'renegotiate');
export const canSignOff = (role: SdRole, stage: string | null) =>
  isAdmin(role) && stage === 'rate_submitted';
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
