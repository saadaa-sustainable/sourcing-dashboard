import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeIssueStats, daysOpen, diffAutoIssues, routeFor, type IssueRow, type IssueRoute } from './issues';

const T0 = Date.parse('2026-09-22T09:00:00Z');
const iso = (daysAgo: number) => new Date(T0 - daysAgo * 86_400_000).toISOString();

const row = (o: Partial<IssueRow> & { id: number }): IssueRow => ({
  category: 'po',
  title: 'x',
  detail: null,
  related_ref: null,
  page_path: null,
  source: 'manual',
  auto_key: null,
  severity: 'medium',
  status: 'open',
  raised_by: 'a@saadaa.in',
  raised_at: iso(3),
  assignee: null,
  assigned_via: null,
  assigned_at: null,
  resolved_at: null,
  resolved_by: null,
  resolution: null,
  updated_at: iso(0),
  messageCount: 0,
  ...o,
});

test('days open: raise to resolve, or raise to now while open', () => {
  assert.equal(daysOpen(iso(5), null, T0), 5);
  assert.equal(daysOpen(iso(5), iso(2), T0), 3);
  assert.equal(daysOpen(iso(0), null, T0), 0);
});

test('routing by category; unset route stays unassigned', () => {
  const routes: IssueRoute[] = [
    { category: 'tna', label: 'TNA', assignee: 'tna-owner@example.com', updated_by: null, updated_at: iso(0) },
    { category: 'po', label: 'PO', assignee: '  ', updated_by: null, updated_at: iso(0) },
  ];
  assert.equal(routeFor('tna', routes), 'tna-owner@example.com');
  assert.equal(routeFor('po', routes), null);
  assert.equal(routeFor('vendor', routes), null);
});

test('stats: open, unassigned, auto, oldest, and average days to resolve over 30 days', () => {
  const rows = [
    row({ id: 1, raised_at: iso(10), assignee: 'x@saadaa.in', status: 'in_progress' }),
    row({ id: 2, raised_at: iso(2), source: 'auto', auto_key: 'k' }),
    row({ id: 3, raised_at: iso(8), status: 'resolved', resolved_at: iso(4) }),   // 4 days
    row({ id: 4, raised_at: iso(9), status: 'resolved', resolved_at: iso(1) }),   // 8 days
    row({ id: 5, raised_at: iso(90), status: 'resolved', resolved_at: iso(60) }), // outside 30 days
    row({ id: 6, raised_at: iso(1), status: 'dismissed' }),
  ];
  const s = computeIssueStats(rows, T0);
  assert.equal(s.open, 2);
  assert.equal(s.inProgress, 1);
  assert.equal(s.unassigned, 1);
  assert.equal(s.autoOpen, 1);
  assert.equal(s.oldestOpenDays, 10);
  assert.equal(s.resolvedLast30, 2);
  assert.equal(s.avgDaysToResolve30, 6);
  assert.deepEqual(s.byAssignee, [
    { assignee: 'x@saadaa.in', open: 1 },
    { assignee: 'Unassigned', open: 1 },
  ]);
});

test('auto diff: raise what is new, close what is gone, leave the rest', () => {
  const d = (key: string) => ({
    key, category: 'tna' as const, title: key, detail: '', related_ref: null, page_path: null, severity: 'medium' as const,
  });
  const { toRaise, toClose } = diffAutoIssues([d('a'), d('b')], ['b', 'c']);
  assert.deepEqual(toRaise.map((x) => x.key), ['a']);
  assert.deepEqual(toClose, ['c']);
});
