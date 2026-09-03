'use client';

import { InfoDot } from '@/components/info-dot';
import type { ApprovalContext } from '@/lib/approval-context';

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`);

/** Colour a rate cell green/amber/red by how healthy the coverage is. */
function rateTone(v: number | null): string {
  if (v == null) return 'var(--ink-4)';
  if (v >= 0.75) return 'var(--success-text)';
  if (v >= 0.5) return 'var(--warning-text)';
  return 'var(--danger-text)';
}

/**
 * Inline approval context (spec item 1): DOQ · Pending · Stock · In-Process ·
 * DOH · SKU in-stock · Colour in-stock — the numbers the approver needs to clear
 * a routine line without leaving the screen. `pendingQty` is the line's request.
 */
export function ApprovalContextPanel({
  ctx,
  pendingQty,
}: {
  ctx: ApprovalContext | undefined;
  pendingQty?: number;
}) {
  if (!ctx) {
    return <span className="wf-subtle" style={{ fontSize: 11 }}>no stock/DOQ data</span>;
  }
  const cell = (label: string, value: string, info?: string, color?: string) => (
    <span className="ac-cell">
      <span className="ac-label">
        {label}
        {info && <InfoDot text={info} label={`About ${label}`} />}
      </span>
      <strong className="tabular" style={color ? { color } : undefined}>{value}</strong>
    </span>
  );
  return (
    <div className="approval-context">
      {pendingQty != null && cell('Pending', fmt.format(pendingQty), 'Quantity requested on this buying-plan line.')}
      {cell('DOQ', String(ctx.doq), 'Inventory-Planning DOQ (daily demand rate) for this product — the same IPDOQ used by Replenishment.')}
      {cell('Stock', fmt.format(ctx.currentStock), 'Current sellable stock across the product’s SKUs.')}
      {cell('In-Proc', fmt.format(ctx.inProcess), 'Quantity already covered by an open PO (in process).')}
      {cell(
        'DOH',
        ctx.doh == null ? '—' : `${fmt.format(ctx.doh)}d`,
        'Days of Hand = (current stock + in-process) ÷ DOQ — how many days of coverage you already have before approving more.',
        ctx.doh == null ? undefined : ctx.doh >= 45 ? 'var(--success-text)' : ctx.doh >= 15 ? 'var(--warning-text)' : 'var(--danger-text)',
      )}
      {cell(
        'SKU in-stock',
        pct(ctx.skuInStockRate),
        `Ongoing SKUs in stock ÷ ongoing SKUs (${ctx.ongoingSkuCount} ongoing; NPD & discontinued excluded).`,
        rateTone(ctx.skuInStockRate),
      )}
      {cell(
        'Colour in-stock',
        pct(ctx.colorInStockRate),
        `Colours with ≥75% of sizes in stock ÷ total colours (${ctx.qualifyingColors}/${ctx.totalColors}).`,
        rateTone(ctx.colorInStockRate),
      )}
    </div>
  );
}
