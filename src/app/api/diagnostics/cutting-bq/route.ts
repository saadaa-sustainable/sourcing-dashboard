import { currentUser } from '@/lib/forms/queries';
import { probeCuttingBqAccess } from '@/lib/cutting-bq';

// Verifies whether the deployed service account can WRITE to the warehouse cutting-register
// table (saadaa-wh.MAPLEMONK.po_qty_cutting_register). Non-destructive — writes no rows.
// The BigQuery client needs the Node runtime (not edge).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Admin-only: open in a browser while signed in as an admin. Returns a JSON verdict —
//   ready     : key present and write confirmed → the push will work
//   read-only : key present, table readable, but no write permission → grant Data Editor
//   no-key    : GCP_SA_KEY is not set in this environment
//   no-access : key present but the table isn't even reachable
export async function GET() {
  const user = await currentUser();
  if (!user || user.role !== 'admin') {
    return new Response('Forbidden — admin only.', { status: 403 });
  }
  const result = await probeCuttingBqAccess();
  return Response.json(result);
}
