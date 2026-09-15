'use client';

import { useState } from 'react';
import { DiscontinueClient } from './discontinue-client';
import { DiscontinuedInventoryView } from '@/components/discontinued-inventory-view';
import type { DiscontinueRequest, SdRole } from '@/lib/forms/types';
import type { DiscontinuedInventoryRow } from '@/lib/discontinued';

/**
 * The Discontinue page has two faces: the variant-level discontinue-approval
 * workflow, and the available-inventory ageing / liquidation view for products
 * already marked discontinued. A segment toggle switches between them.
 */
export function DiscontinueTabs({
  requests,
  variants,
  role,
  invRows,
  salesByVariant,
}: {
  requests: DiscontinueRequest[];
  variants: { product_code: string; product_variant: string }[];
  role: SdRole;
  invRows: DiscontinuedInventoryRow[];
  salesByVariant: Record<string, number>;
}) {
  const [view, setView] = useState<'requests' | 'inventory'>('requests');
  return (
    <>
      <div className="segment wf-segment" style={{ marginBottom: 16 }}>
        <button
          type="button"
          className={view === 'requests' ? 'active' : ''}
          onClick={() => setView('requests')}
        >
          Discontinue requests
        </button>
        <button
          type="button"
          className={view === 'inventory' ? 'active' : ''}
          onClick={() => setView('inventory')}
        >
          Discontinued Products View
        </button>
      </div>
      {view === 'requests' ? (
        <DiscontinueClient requests={requests} variants={variants} role={role} />
      ) : (
        <DiscontinuedInventoryView rows={invRows} salesByVariant={salesByVariant} />
      )}
    </>
  );
}
