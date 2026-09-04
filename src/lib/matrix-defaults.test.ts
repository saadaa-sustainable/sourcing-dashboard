import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MATRIX_DEFAULT_MODE } from './matrix-defaults';

// Item 4 anti-regression guard: the Product Matrix default view MUST be Product Code.
// It reverted to variant-level before; if this ever changes, fail visibly here rather
// than letting the default silently drift again. dashboard-shell's MatrixTab seeds its
// mode state from MATRIX_DEFAULT_MODE, so this pins the shipped default.
test('Product Matrix defaults to product-code level', () => {
  assert.equal(MATRIX_DEFAULT_MODE, 'product');
});
