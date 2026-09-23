import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  approversFor,
  canDecide,
  canDeletePo,
  canRework,
  canSubmit,
  isEscalated,
  levelForStatus,
  statusOnSubmit,
  STATUS_LABEL,
  STATUS_TONE,
} from './approval';

describe('approval workflow v2', () => {
  it('lets a reworked record be re-submitted like a draft', () => {
    assert.equal(canSubmit('team', 'rework'), true);
    assert.equal(canSubmit('team', 'draft'), true);
    assert.equal(canSubmit('team', 'submitted'), false);
    assert.equal(canSubmit('viewer', 'rework'), false);
  });
  it('gates Rework/Reassign exactly like Approve', () => {
    assert.equal(canRework('team', 'submitted'), true);
    assert.equal(canRework('team', 'pending_l2'), false);
    assert.equal(canRework('admin', 'pending_l2'), true);
    assert.equal(canRework('team', 'draft'), false);
  });
  it('labels the new/merged statuses', () => {
    assert.equal(STATUS_LABEL.rework, 'Rework-and-Reassign');
    assert.equal(STATUS_LABEL.submitted, 'Approval Pending');
    assert.equal(STATUS_LABEL.pending_l2, 'Approval Pending');
    assert.ok(STATUS_TONE.rework);
  });
  it('lets the raiser delete their own request until it is approved', () => {
    const me = 'asha@saadaa.in';
    assert.equal(canDeletePo('team', 'draft', me, me), true);
    // The point of the feature: pulling one back while it waits in the queue.
    assert.equal(canDeletePo('team', 'submitted', me, me), true);
    assert.equal(canDeletePo('team', 'pending_l2', me, me), true);
    assert.equal(canDeletePo('team', 'rejected', me, me), true);
    // Approved is a commitment — that is a cancellation, not a delete.
    assert.equal(canDeletePo('team', 'approved', me, me), false);
    // Someone else's request, and read-only users.
    assert.equal(canDeletePo('team', 'submitted', 'ravi@saadaa.in', me), false);
    assert.equal(canDeletePo('viewer', 'draft', me, me), false);
    // Admin oversees everyone's; a blank creator is nobody's to claim.
    assert.equal(canDeletePo('admin', 'submitted', 'ravi@saadaa.in', me), true);
    assert.equal(canDeletePo('admin', 'approved', 'ravi@saadaa.in', me), false);
    assert.equal(canDeletePo('team', 'draft', null, me), false);
    assert.equal(canDeletePo('team', 'draft', ' ASHA@saadaa.in ', me), true); // case/space tolerant
  });
  it('routes a decision through the named people at each level (spec 7.5)', () => {
    const matrix = {
      l1: ['asha@saadaa.in', 'ravi@saadaa.in'],
      l2: ['nisha@saadaa.in'],
      l3: ['mahesh@saadaa.in'],
    };
    assert.equal(levelForStatus('submitted'), 'l1');
    assert.equal(levelForStatus('pending_l2'), 'l2');
    assert.equal(levelForStatus('draft'), null);
    assert.deepEqual(approversFor('submitted', matrix), matrix.l1);

    // At L1: either named person decides; a fallback is not a lesser approver.
    assert.equal(canDecide({ role: 'team', email: 'ravi@saadaa.in' }, 'submitted', matrix), true);
    // A team member who is not on the matrix cannot, even though the old role rule allowed it.
    assert.equal(canDecide({ role: 'team', email: 'other@saadaa.in' }, 'submitted', matrix), false);
    // L1 does not get to decide an L2 item…
    assert.equal(canDecide({ role: 'team', email: 'asha@saadaa.in' }, 'pending_l2', matrix), false);
    // …until it has escalated.
    assert.equal(canDecide({ role: 'team', email: 'nisha@saadaa.in' }, 'submitted', matrix, true), true);
    // L3 is the final authority, at any level, escalated or not.
    assert.equal(canDecide({ role: 'team', email: 'mahesh@saadaa.in' }, 'pending_l2', matrix), true);
    assert.equal(canDecide({ role: 'admin', email: 'someone@saadaa.in' }, 'pending_l2', matrix), true);
  });
  it('falls back to the role ladder for a level nobody is named at', () => {
    const half = { l1: [], l2: ['nisha@saadaa.in'], l3: [] };
    assert.equal(canDecide({ role: 'team', email: 'anyone@saadaa.in' }, 'submitted', half), true);
    assert.equal(canDecide({ role: 'team', email: 'anyone@saadaa.in' }, 'pending_l2', half), false);
    assert.equal(canDecide({ role: 'viewer', email: 'anyone@saadaa.in' }, 'submitted', half), false);
  });
  it('escalates only once the waiting window has actually passed', () => {
    const now = new Date('2026-09-23T10:00:00Z');
    assert.equal(isEscalated('2026-09-20T10:00:00Z', 2, now), true);
    assert.equal(isEscalated('2026-09-22T12:00:00Z', 2, now), false);
    assert.equal(isEscalated(null, 2, now), false);
    assert.equal(isEscalated('2026-09-01T10:00:00Z', 0, now), false); // escalation switched off
  });
  it('keeps submit routing by qty/category', () => {
    assert.equal(statusOnSubmit('buying_plan', 100), 'submitted');
    assert.equal(statusOnSubmit('buying_plan', 9000), 'pending_l2');
    assert.equal(statusOnSubmit('po_approval', 100, 'npd'), 'pending_l2');
  });
});
