/**
 * Barrel for the forms server actions.
 *
 * This module has NO 'use server' directive: it is a plain re-export barrel. Each
 * domain module under actions-modules/ carries its own 'use server' directive and
 * owns a group of server actions; re-exporting them from a plain barrel is the
 * supported pattern. Shared types come from _shared. Consumers import from
 * '@/lib/forms/actions' exactly as before.
 */

export * from './actions-modules/buying-plan';
export * from './actions-modules/vendor-capacity';
export * from './actions-modules/discontinue';
export * from './actions-modules/approval';
export * from './actions-modules/receivable';
export * from './actions-modules/po-lines-cutting';
export * from './actions-modules/po-closure';
export * from './actions-modules/tna';
export * from './actions-modules/standard-cost';
export * from './actions-modules/cost-negotiation';
export * from './actions-modules/po-approval';
export * from './actions-modules/product-master';
export * from './actions-modules/fabric';
export * from './actions-modules/material';
export * from './actions-modules/users-roles';
export * from './actions-modules/oos';
export * from './actions-modules/inward-plan';
export type { ActionResult, LinkResult } from './actions-modules/_shared';
