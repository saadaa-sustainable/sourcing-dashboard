import { CommercialRequestScreen } from '../../../vendor-commercial/request-screen';
export const dynamic = 'force-dynamic';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <CommercialRequestScreen id={(await params).id} mode="edit" portal />;
}
