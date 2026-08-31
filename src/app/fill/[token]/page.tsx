import { createPublicClient } from '@/lib/supabase/public';
import { FillForm } from './fill-form';

// Public, no-login data-capture route (spec §2). Validates the token via the
// SECURITY DEFINER RPC (anon can't read the tables). Invalid / expired / inactive /
// already-submitted all render the same generic "no longer active" page — no reason
// is revealed, so the token space can't be probed.
export const dynamic = 'force-dynamic';

type LinkCtx = {
  is_valid: boolean;
  link_type: string | null;
  po_ref_num: string | null;
  product_code: string | null;
  bom_quantity: number | null;
  bom_uom: string | null;
};

export default async function FillPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  let ctx: LinkCtx | null = null;
  try {
    const supabase = createPublicClient();
    const { data } = await supabase.rpc('sd_validate_dynamic_link', { p_token: token });
    const row = (Array.isArray(data) ? data[0] : data) as LinkCtx | undefined;
    if (row?.is_valid) ctx = row;
  } catch {
    ctx = null;
  }

  if (!ctx) {
    return (
      <main className="fill-shell">
        <div className="fill-card">
          <div className="fill-brand">SAADAA</div>
          <h1>Link no longer active</h1>
          <p>This data-entry link has expired or has already been used. Please ask for a fresh link.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="fill-shell">
      <div className="fill-card">
        <div className="fill-brand">SAADAA</div>
        <h1>Cutting Register</h1>
        <p className="fill-meta">
          PO <strong>{ctx.po_ref_num}</strong>
          {ctx.product_code ? <> · {ctx.product_code}</> : null}
        </p>
        <FillForm
          token={token}
          bomQty={ctx.bom_quantity}
          bomUom={ctx.bom_uom}
        />
      </div>
    </main>
  );
}
