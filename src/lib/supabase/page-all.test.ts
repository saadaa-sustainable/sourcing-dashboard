import assert from 'node:assert/strict';
import test from 'node:test';
import { pageAll } from './page-all';

test('reads beyond the response cap with fresh queries and inclusive page bounds', async () => {
  const source = Array.from({ length: 1201 }, (_, id) => ({ id }));
  const ranges: number[][] = [];
  let builds = 0;
  const result = await pageAll(() => {
    builds += 1;
    return {
      range: async (from, to) => {
        ranges.push([from, to]);
        return { data: source.slice(from, to + 1), error: null };
      },
    };
  });
  assert.deepEqual(result.data, source);
  assert.deepEqual(ranges, [[0, 499], [500, 999], [1000, 1499]]);
  assert.equal(builds, 3);
});

test('checks the terminal page when the row count is an exact multiple', async () => {
  const source = Array.from({ length: 500 }, (_, id) => id);
  let builds = 0;
  const result = await pageAll(() => {
    builds += 1;
    return { range: async (from, to) => ({ data: source.slice(from, to + 1), error: null }) };
  });
  assert.deepEqual(result.data, source);
  assert.equal(builds, 2);
});

test('rejects a failed later page instead of returning incomplete data', async () => {
  await assert.rejects(pageAll(() => ({
    range: async (from) => from === 0
      ? { data: Array.from({ length: 500 }, (_, id) => id), error: null }
      : { data: null, error: { message: 'statement timeout' } },
  })), /statement timeout/);
});
