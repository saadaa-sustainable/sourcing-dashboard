import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadPoApprovals,
  loadPoDeleteRequests,
  loadPoReviewItems,
  loadStandardCmByCode,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { canView } from '@/lib/views';
import { PoPageClient } from './po-page-client';

export const dynamic = 'force-dynamic';

/**
 * One purchase order on its own URL: what it is, where it stands, what happens next, the
 * review, and everything that can be done to it. The list's cards link here.
 */
export default async function PoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: idParam } = await params;
  const id = Number(idParam);
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="PO Approval" active="/po-approval" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }
  if (!user) redirect('/login');
  if (!canView('/po-approval', user.role, user.allowed_pages ?? null)) redirect('/');
  if (!Number.isFinite(id)) notFound();

  const [{ pos, cycleById, linesByPo }, deleteRequests, stdCm] = await Promise.all([
    loadPoApprovals(),
    loadPoDeleteRequests(),
    loadStandardCmByCode(),
  ]);
  const po = pos.find((p) => p.id === id);
  if (!po) notFound();
  const [review] = await loadPoReviewItems([po]);

  return (
    <FormLayout
      title={`PO ${po.request_id}`}
      subtitle={`${po.product_code ?? '—'} · ${po.vendor_name || po.vendor_code || 'no vendor'} · ${Number(po.po_qty || 0).toLocaleString('en-IN')} pcs`}
      active="/po-approval"
      helpRoute="/po-approval"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
      accent="blue"
    >
      <p className="poa-back">
        <Link href="/po-approval">← All purchase orders</Link>
      </p>
      <PoPageClient
        po={po}
        cycle={cycleById.get(po.id)}
        lines={linesByPo.get(po.id) ?? []}
        deleteRequest={deleteRequests[String(po.id)]}
        review={review}
        stdCm={stdCm}
        role={user.role}
      />
    </FormLayout>
  );
}
