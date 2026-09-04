/**
 * Item 4 — the Product Matrix must default to PRODUCT CODE level, not variant.
 * (Per git history this was never actually shipped as the default — MatrixTab has
 * used "variant" since it was introduced — so this is both the fix and the guard
 * against it drifting again.)
 *
 * The default lives here as a named constant so dashboard-shell's MatrixTab consumes
 * it and matrix-defaults.test.ts can assert it in isolation (importing the huge
 * client component into a node test would pull in browser-only deps). If someone
 * changes this, the test fails loudly instead of the default silently reverting.
 */
export const MATRIX_DEFAULT_MODE: 'variant' | 'product' = 'product';
