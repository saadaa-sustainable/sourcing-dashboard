import { redirect } from 'next/navigation';
import { DashboardShell } from '@/components/dashboard-shell';
import { loadDashboardData } from '@/lib/data';
import { hasSupabaseEnv } from '@/lib/supabase/server';
import { currentUser, loadOpenClosures } from '@/lib/forms/queries';
import type { PoClosureView, SdRole } from '@/lib/forms/types';

export const dynamic = 'force-dynamic';

export default async function Home() {
  let userEmail: string | null = null;
  // Local fixture mode (no Supabase env) has no auth — show the full nav.
  let role: SdRole = 'admin';
  if (hasSupabaseEnv()) {
    const user = await currentUser();
    if (!user) redirect('/login');
    userEmail = user.email;
    if (!userEmail.endsWith('@saadaa.in')) redirect('/login?error=This+dashboard+is+restricted+to+SAADAA+accounts.');
    role = user.role;
  }
  const dashboardData = await loadDashboardData();
  // Pending-closure panel on the Open PO Tracker (best-effort — never block the dashboard).
  let closures: PoClosureView[] = [];
  if (hasSupabaseEnv()) {
    try { closures = await loadOpenClosures(); } catch { closures = []; }
  }
  return <DashboardShell data={dashboardData} closures={closures} userEmail={userEmail} role={role} />;
}
