import { notFound, redirect } from 'next/navigation';
import { FormLayout } from '@/components/forms/form-layout';
import { commercialIdentity, commercialPos } from '@/lib/commercial-access.server';
import { loadVendorCommercial } from '@/lib/forms/queries-modules/vendor-commercial';
import { mayEditCommercial, commercialRequestNumber } from '@/lib/forms/commercial-workflow';
import { requestTypeLabel } from '@/lib/forms/commercial';
import { canEdit } from '@/lib/forms/approval';
import { CommercialReview } from './commercial-review';
import { VendorCommercialClient } from './vendor-commercial-client';
import './commercial.css';

export async function CommercialRequestScreen({ id, mode, portal }: { id: string; mode: 'edit' | 'review'; portal: boolean }) {
  const actor = await commercialIdentity();
  if (!actor) redirect(portal ? '/commercial-requests/login' : '/login');
  if (actor.passwordChangeRequired) redirect('/commercial-requests/change-password');
  const basePath = actor.vendorCode ? '/commercial-requests' : '/vendor-commercial';
  if (portal !== !!actor.vendorCode) redirect(`${basePath}/${encodeURIComponent(id)}/${mode}`);
  if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id))) notFound();
  const data = await loadVendorCommercial();
  // The shared loader scopes vendor data before this lookup. Never disclose other vendors' IDs.
  const request = data.requests.find((row) => row.id === Number(id));
  if (!request || (actor.vendorCode && request.vendor_code !== actor.vendorCode)) notFound();
  const editable = (!!actor.vendorCode || canEdit(actor.role, 'draft')) && mayEditCommercial(actor.email, actor.role === 'admin', request.requested_by, request.status);
  if (mode === 'edit' && !editable) notFound();
  const title = `${mode === 'edit' ? 'Edit request' : 'Request review'} · ${commercialRequestNumber(request.id, request.requested_at)}`;
  const content = mode === 'edit'
    ? <VendorCommercialClient {...data} role={actor.role} editRequest={request} initialPos={await commercialPos(request.vendor_code)} />
    : <div className="commercial-workspace"><nav className="commercial-screen-nav"><a className="wf-btn wf-btn-ghost" href={basePath}>Back to requests</a></nav><section className="panel commercial-review-screen"><h2>{requestTypeLabel(request.request_type, request.business_type)}</h2><CommercialReview request={request} events={data.events.filter((event) => event.request_id === request.id)} admin={actor.role === 'admin' && !actor.vendorCode} standalone /></section></div>;
  if (portal) return <main className="commercial-portal ui-shopify"><header><h1>{title}</h1></header>{content}</main>;
  return <FormLayout title={title} subtitle="Commercial Approval Requests" active="/vendor-commercial" role={actor.role} userEmail={actor.email} allowedPages={actor.allowedPages ?? null}>{content}</FormLayout>;
}
