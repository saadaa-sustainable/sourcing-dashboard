import 'server-only';

/**
 * Barrel for the write-side table reads.
 *
 * The implementation was split into domain modules under ./queries-modules/ to
 * reduce file size and merge-conflict surface. This file preserves the public
 * surface: everything previously exported from '@/lib/forms/queries' is
 * re-exported here unchanged, so all consumers keep importing from the same path.
 */

export { NotConfiguredError } from './queries-modules/_shared';
export * from './queries-modules/auth';
export * from './queries-modules/analytics';
export * from './queries-modules/replenishment-oos';
export * from './queries-modules/product';
export * from './queries-modules/standard-cost';
export * from './queries-modules/po-closure';
export * from './queries-modules/vendor';
export * from './queries-modules/buying-plan';
export * from './queries-modules/inward-receivable';
export * from './queries-modules/po-approval';
export * from './queries-modules/approvals';
export * from './queries-modules/discontinue';
export * from './queries-modules/misc';
