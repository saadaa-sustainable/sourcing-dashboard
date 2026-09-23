import { currentUser } from '@/lib/forms/queries';
import { createClient, hasSupabaseEnv } from '@/lib/supabase/server';
import { renderPoPdf } from '@/lib/po-pdf';
import type { PoApproval, PoApprovalLine } from '@/lib/forms/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Spec 7.6 — download an approved PO as a PDF.
 *
 * Generated on request from the live record rather than stored, so the document can never
 * be a stale copy of the PO. Approved only: a draft or a request still in the queue is not
 * something anyone should be able to hand to a vendor.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return new Response('Not signed in.', { status: 401 });
  if (!hasSupabaseEnv()) return new Response('Supabase is not configured.', { status: 503 });

  const { id } = await ctx.params;
  const poId = Number(id);
  if (!poId) return new Response('Invalid PO.', { status: 400 });

  const supabase = await createClient();
  const { data: po } = await supabase.from('sd_po_approval').select('*').eq('id', poId).maybeSingle();
  if (!po) return new Response('PO not found.', { status: 404 });
  const row = po as unknown as PoApproval;
  if (row.deleted_at) return new Response('This request was deleted.', { status: 410 });
  if (row.status !== 'approved') {
    return new Response('Only an approved PO can be downloaded as a PDF.', { status: 409 });
  }

  // paging-ok: the size lines of one PO, a few dozen at most
  const { data: lines } = await supabase
    .from('sd_po_approval_line')
    .select('*')
    .eq('po_id', poId)
    .order('id');

  const pdf = renderPoPdf(row, (lines ?? []) as PoApprovalLine[]);
  const name = `${row.request_id}${row.product_code ? `-${row.product_code}` : ''}.pdf`.replace(/[^\w.-]+/g, '-');
  return new Response(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    },
  });
}
