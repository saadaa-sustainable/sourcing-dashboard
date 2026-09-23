import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canDeletePo,
  canRework,
  canSubmit,
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
  it('keeps submit routing by qty/category', () => {
    assert.equal(statusOnSubmit('buying_plan', 100), 'submitted');
    assert.equal(statusOnSubmit('buying_plan', 9000), 'pending_l2');
    assert.equal(statusOnSubmit('po_approval', 100, 'npd'), 'pending_l2');
  });
});
