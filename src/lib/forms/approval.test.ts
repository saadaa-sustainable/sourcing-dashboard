import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
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
    assert.equal(STATUS_LABEL.rework, 'Rework/Reassign');
    assert.equal(STATUS_LABEL.submitted, 'Approval Pending');
    assert.equal(STATUS_LABEL.pending_l2, 'Approval Pending');
    assert.ok(STATUS_TONE.rework);
  });
  it('keeps submit routing by qty/category', () => {
    assert.equal(statusOnSubmit('buying_plan', 100), 'submitted');
    assert.equal(statusOnSubmit('buying_plan', 9000), 'pending_l2');
    assert.equal(statusOnSubmit('po_approval', 100, 'npd'), 'pending_l2');
  });
});
