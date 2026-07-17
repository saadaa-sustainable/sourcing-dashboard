import { ArrowLeft, CheckCircle2, Info, LayoutDashboard, LogOut, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient, hasSupabaseEnv } from '@/lib/supabase/server';
import { createAdminClient, hasSupabaseAdminEnv } from '@/lib/supabase/admin';
import { inviteUser } from './actions';
import { UserTable, type UserRow } from './user-table';

export const dynamic = 'force-dynamic';

async function signOut() {
  'use server';
  if (hasSupabaseEnv()) { const supabase = await createClient(); await supabase.auth.signOut(); }
  redirect('/login');
}

function statusOf(user: { last_sign_in_at?: string | null; email_confirmed_at?: string | null; confirmed_at?: string | null; invited_at?: string | null }): UserRow['status'] {
  if (user.last_sign_in_at) return 'Active';
  if (user.email_confirmed_at || user.confirmed_at) return 'Confirmed';
  if (user.invited_at) return 'Invited';
  return 'Pending';
}

async function loadUsers(): Promise<UserRow[]> {
  if (!hasSupabaseAdminEnv()) return [];
  const admin = createAdminClient();
  const rows: UserRow[] = [];
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`Failed to load users: ${error.message}`);
    const users = data?.users ?? [];
    for (const u of users) rows.push({ id: u.id, email: u.email ?? '(no email)', status: statusOf(u), createdAt: u.created_at, lastSignInAt: u.last_sign_in_at ?? null });
    if (users.length < 1000) break;
  }
  return rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export default async function UsersPage({ searchParams }: { searchParams: Promise<{ error?: string; invited?: string }> }) {
  if (!hasSupabaseEnv()) redirect('/');

  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) redirect('/login');
  const userEmail = typeof data.claims.email === 'string' ? data.claims.email : null;

  const adminReady = hasSupabaseAdminEnv();
  const { error: formError, invited } = await searchParams;
  const users = adminReady ? await loadUsers() : [];

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">S</div><div><strong>SAADAA</strong><span>Sourcing intelligence</span></div></div>
      <nav>
        <Link href="/"><LayoutDashboard size={18} /><span>Dashboard</span></Link>
        <Link href="/users" className="active"><UserPlus size={18} /><span>User Management</span></Link>
      </nav>
      <div className="sidebar-foot">
        <div className="status-dot"><i />Data connected</div>
        <small>{userEmail}</small>
        <form action={signOut}><button><LogOut size={16} /> Sign out</button></form>
      </div>
    </aside>
    <main>
      <header>
        <div><p>Access control</p><h1>User Management</h1></div>
        <div className="header-actions"><Link href="/" className="help-button"><ArrowLeft size={16} /> Back to dashboard</Link></div>
      </header>

      {!adminReady && <div className="notice"><Info size={16} />Inviting users needs the <code>SUPABASE_SERVICE_ROLE_KEY</code> server variable. Add it in Vercel (server-only, never <code>NEXT_PUBLIC_</code>) to enable this panel.</div>}

      <div className="content">
        <section className="panel invite-panel">
          <div className="panel-title"><div><span className="panel-kicker">Add a user</span><h3>Send an invite</h3></div></div>
          <div className="panel-body">
            {formError && <div className="form-alert error"><Info size={15} />{formError}</div>}
            {invited && <div className="form-alert success"><CheckCircle2 size={15} />Invite email sent to {invited}. They can set a password from the link.</div>}
            <form action={inviteUser} className="invite-form">
              <label className="field"><span>Work email</span><input type="email" name="email" placeholder="new.teammate@company.com" required autoComplete="off" disabled={!adminReady} /></label>
              <button type="submit" className="primary-button" disabled={!adminReady}><UserPlus size={16} /> Send invite</button>
            </form>
            <p className="invite-hint">An invite email is sent via Supabase to any valid address. Invite emails require SMTP to be configured on the Supabase project.</p>
          </div>
        </section>

        <UserTable users={users} />
      </div>
    </main>
  </div>;
}
