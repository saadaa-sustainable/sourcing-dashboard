import { redirect } from 'next/navigation';
import { DashboardShell } from '@/components/dashboard-shell';
import { loadDashboardData } from '@/lib/data';
import { createClient, hasSupabaseEnv } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

async function signOut() {
  'use server';
  if (hasSupabaseEnv()) { const supabase = await createClient(); await supabase.auth.signOut(); }
  redirect('/login');
}

export default async function Home() {
  let userEmail: string | null = null;
  if (hasSupabaseEnv()) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getClaims();
    if (error || !data?.claims) redirect('/login');
    userEmail = typeof data.claims.email === 'string' ? data.claims.email : null;
  }
  const dashboardData = await loadDashboardData();
  return <DashboardShell data={dashboardData} userEmail={userEmail} signOutAction={signOut} />;
}
