import { redirect } from 'next/navigation';
import { getFreshSession } from '@/lib/auth';
import { AppNav } from '@/components/AppNav';
import { AdminPortal } from '@/components/AdminPortal';

/**
 * Dashboard 2 -- Management Portal (admin and superadmin).
 *
 * The User Management tab is rendered only for superadmin; the API behind it
 * independently enforces the same rule, so hiding the tab is UX, not security.
 */
export default async function AdminPage() {
  const user = await getFreshSession();

  if (!user) redirect('/login');
  if (user.role !== 'admin' && user.role !== 'superadmin') redirect('/dashboard');

  return (
    <div className="min-h-screen">
      <AppNav user={user} active="admin" />

      <main className="mx-auto max-w-7xl px-4 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-navy-900">Management Portal</h1>
          <p className="mt-1 text-sm text-slate-600">
            All documents, live sync status, and audit history.
          </p>
        </div>

        <AdminPortal
          currentUser={{ id: user.id, username: user.username, role: user.role }}
        />
      </main>
    </div>
  );
}
