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
      return 'Admin — set target cost';
    case 'target_set':
      return 'Team — enter actual rate';
    case 'rate_submitted':
      return 'Admin — sign off';
    case 'renegotiate':
      return 'Team — re-enter rate';
    default:
      return '—';
  }
}

export const canPropose = (role: SdRole, stage: string | null) =>
  isTeam(role) && (!stage || stage === 'rejected');
export const canSetTarget = (role: SdRole, stage: string | null) =>
  isAdmin(role) && stage === 'proposed';
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
