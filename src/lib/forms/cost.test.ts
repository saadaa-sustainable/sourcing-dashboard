import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  nextActor,
  canPropose,
  canSetTarget,
  canAcceptProposal,
  isAdminTurn,
  isTeamTurn,
  canSubmitRate,
  canSignOff,
  canRenegotiate,
  canRejectCost,
  canConfirmFabric,
  canConfirmCm,
  COST_STAGE_LABEL,
  COST_STAGE_TONE,
  CMTP_HEADS,
  CMTP_MANDATORY,
} from './cost';
import type { SdRole } from './types';

// Every stage the machine can be in, including the "not started" empty stage.
// null is treated as '' by the guards, so we test both explicitly.
const STAGES = [
  '',
  'proposed',
  'target_set',
  'rate_submitted',
  'signed_off',
  'renegotiate',
  'rejected',
] as const;

describe('cost negotiation — nextActor hints', () => {
  it('names the actor waited on at each stage', () => {
    assert.equal(nextActor(''), 'Team — propose');
    assert.equal(nextActor('proposed'), 'Admin — accept, reject or set target');
    assert.equal(nextActor('target_set'), 'Team — enter actual rate');
    assert.equal(nextActor('rate_submitted'), 'Admin — sign off');
    assert.equal(nextActor('renegotiate'), 'Team — re-enter rate');
    assert.equal(nextActor('signed_off'), 'Accepted — team may re-propose to revise');
  });
  it('treats null as the not-started stage', () => {
    assert.equal(nextActor(null), 'Team — propose');
  });
  it('falls back to a dash for an unknown stage', () => {
    assert.equal(nextActor('bogus'), '—');
  });
});

describe('cost negotiation — role gating', () => {
  it('viewer can do nothing that mutates the negotiation', () => {
    for (const stage of STAGES) {
      assert.equal(canPropose('viewer', stage), false, `propose@${stage}`);
      assert.equal(canSetTarget('viewer', stage), false, `setTarget@${stage}`);
      assert.equal(canAcceptProposal('viewer', stage), false, `accept@${stage}`);
      assert.equal(canSubmitRate('viewer', stage), false, `submitRate@${stage}`);
      assert.equal(canSignOff('viewer', stage), false, `signOff@${stage}`);
      assert.equal(canRenegotiate('viewer', stage), false, `reneg@${stage}`);
      assert.equal(canRejectCost('viewer', stage), false, `reject@${stage}`);
      assert.equal(canConfirmFabric('viewer', stage, false), false, `fabric@${stage}`);
      assert.equal(canConfirmCm('viewer', stage, true, false), false, `cm@${stage}`);
    }
  });
  it('admin-only gates never open for team', () => {
    assert.equal(canSetTarget('team', 'proposed'), false);
    assert.equal(canAcceptProposal('team', 'proposed'), false);
    assert.equal(canSignOff('team', 'rate_submitted'), false);
    assert.equal(canRenegotiate('team', 'rate_submitted'), false);
    assert.equal(canRejectCost('team', 'proposed'), false);
  });
  it('admin outranks team, so admin may also perform team actions (override)', () => {
    // isTeam/isAdmin are rank FLOORS (RANK.admin >= RANK.team), so an admin can
    // act at team stages too — an intentional admin override, not a leak. The
    // turn indicators (isTeamTurn/isAdminTurn) still track whose turn it nominally is.
    assert.equal(canPropose('admin', ''), true);
    assert.equal(canSubmitRate('admin', 'target_set'), true);
    assert.equal(canSubmitRate('admin', 'renegotiate'), true);
  });
});

describe('cost negotiation — stage transitions (happy path)', () => {
  it('team proposes only from an idle/rejected/signed-off stage', () => {
    assert.equal(canPropose('team', ''), true);
    assert.equal(canPropose('team', null), true);
    assert.equal(canPropose('team', 'rejected'), true);
    assert.equal(canPropose('team', 'signed_off'), true); // re-propose to revise
    assert.equal(canPropose('team', 'proposed'), false);
    assert.equal(canPropose('team', 'target_set'), false);
    assert.equal(canPropose('team', 'rate_submitted'), false);
    assert.equal(canPropose('team', 'renegotiate'), false);
  });
  it('admin sets target OR accepts only a proposal', () => {
    assert.equal(canSetTarget('admin', 'proposed'), true);
    assert.equal(canAcceptProposal('admin', 'proposed'), true);
    for (const stage of STAGES) {
      if (stage === 'proposed') continue;
      assert.equal(canSetTarget('admin', stage), false, `setTarget@${stage}`);
      assert.equal(canAcceptProposal('admin', stage), false, `accept@${stage}`);
    }
  });
  it('team submits the rate only after a target is set or a renegotiation', () => {
    assert.equal(canSubmitRate('team', 'target_set'), true);
    assert.equal(canSubmitRate('team', 'renegotiate'), true);
    for (const stage of STAGES) {
      if (stage === 'target_set' || stage === 'renegotiate') continue;
      assert.equal(canSubmitRate('team', stage), false, `submitRate@${stage}`);
    }
  });
  it('admin signs off or renegotiates only a submitted rate', () => {
    assert.equal(canSignOff('admin', 'rate_submitted'), true);
    assert.equal(canRenegotiate('admin', 'rate_submitted'), true);
    for (const stage of STAGES) {
      if (stage === 'rate_submitted') continue;
      assert.equal(canSignOff('admin', stage), false, `signOff@${stage}`);
      assert.equal(canRenegotiate('admin', stage), false, `reneg@${stage}`);
    }
  });
  it('admin rejects a proposal or a submitted rate, nothing else', () => {
    assert.equal(canRejectCost('admin', 'proposed'), true);
    assert.equal(canRejectCost('admin', 'rate_submitted'), true);
    for (const stage of STAGES) {
      if (stage === 'proposed' || stage === 'rate_submitted') continue;
      assert.equal(canRejectCost('admin', stage), false, `reject@${stage}`);
    }
  });
});

describe('cost negotiation — whose turn is it', () => {
  it('admin turn on proposed and rate_submitted', () => {
    assert.equal(isAdminTurn('proposed'), true);
    assert.equal(isAdminTurn('rate_submitted'), true);
    assert.equal(isAdminTurn('target_set'), false);
    assert.equal(isAdminTurn('renegotiate'), false);
    assert.equal(isAdminTurn(''), false);
    assert.equal(isAdminTurn(null), false);
  });
  it('team turn on target_set and renegotiate', () => {
    assert.equal(isTeamTurn('target_set'), true);
    assert.equal(isTeamTurn('renegotiate'), true);
    assert.equal(isTeamTurn('proposed'), false);
    assert.equal(isTeamTurn('rate_submitted'), false);
  });
  it('a stage is never both actors’ turn at once', () => {
    for (const stage of STAGES) {
      assert.ok(!(isAdminTurn(stage) && isTeamTurn(stage)), `both turns @${stage}`);
    }
  });
});

describe('cost negotiation — sequential FG sign-off (fabric then CM)', () => {
  it('fabric must be confirmed before CM, and only while a rate is submitted', () => {
    // Nothing confirmed yet → fabric is enabled, CM is not.
    assert.equal(canConfirmFabric('admin', 'rate_submitted', false), true);
    assert.equal(canConfirmCm('admin', 'rate_submitted', false, false), false);
    // Fabric confirmed → fabric disabled, CM now enabled.
    assert.equal(canConfirmFabric('admin', 'rate_submitted', true), false);
    assert.equal(canConfirmCm('admin', 'rate_submitted', true, false), true);
    // Both confirmed → neither enabled.
    assert.equal(canConfirmCm('admin', 'rate_submitted', true, true), false);
  });
  it('neither confirm is possible outside the rate_submitted stage', () => {
    for (const stage of STAGES) {
      if (stage === 'rate_submitted') continue;
      assert.equal(canConfirmFabric('admin', stage, false), false, `fabric@${stage}`);
      assert.equal(canConfirmCm('admin', stage, true, false), false, `cm@${stage}`);
    }
  });
});

describe('cost negotiation — every stage has a label and a badge tone', () => {
  it('labels and tones cover all stages incl. not-started', () => {
    for (const stage of STAGES) {
      assert.ok(COST_STAGE_LABEL[stage], `label@"${stage}"`);
      assert.ok(COST_STAGE_TONE[stage], `tone@"${stage}"`);
    }
  });
});

describe('cost negotiation — CMTP head architecture', () => {
  it('the six mandatory heads are present and mirrored in CMTP_MANDATORY', () => {
    const keys = CMTP_HEADS.map((h) => h.key);
    assert.deepEqual(keys, [
      'Labour',
      'Cutting',
      'Finishing',
      'Packaging',
      'Product Trims',
      'Brand Trims',
    ]);
    assert.deepEqual(CMTP_MANDATORY, keys);
  });
  it('every head has a non-empty label', () => {
    for (const head of CMTP_HEADS) {
      assert.ok(head.label.length > 0, `label for ${head.key}`);
    }
  });
});
