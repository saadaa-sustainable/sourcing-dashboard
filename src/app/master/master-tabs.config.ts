/**
 * The Master hub's tab registry. Deliberately a plain module (no 'use client' /
 * 'use server'): the server page (page.tsx) reads it to pick the landing tab and
 * the client MasterTabs component reads it to render — so it must be importable
 * as a real array from both sides. A constant exported from a 'use client' module
 * arrives in a server component as an opaque client-reference proxy, which is
 * exactly how `MASTER_TABS.find is not a function` (digest 1775315435) happened.
 */
export type MasterTab = {
  id: string;
  label: string;
  /** The original standalone route — used for the access check + help content. */
  route: string;
};

// Every master, in reading order. `route` is the legacy per-master page (kept
// reachable) and drives both the access check and the help panel.
export const MASTER_TABS: MasterTab[] = [
  { id: 'product', label: 'Product', route: '/product-master' },
  { id: 'category', label: 'Category', route: '/category-mapping' },
  { id: 'vendor', label: 'Vendor', route: '/vendor-master' },
  { id: 'fabric', label: 'Fabric', route: '/fabric-master' },
  { id: 'material', label: 'Material', route: '/material-master' },
  { id: 'fabric-cost', label: 'Fabric Cost', route: '/fabric-cost' },
];
