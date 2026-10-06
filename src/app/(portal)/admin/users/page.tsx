import { redirect } from 'next/navigation';
import { getFreshSession } from '@/lib/auth';
import { UsersTab } from '@/components/UsersTab';

/**
 * User Management -- superadmin only.
 *
 * The role is re-checked because the URL is typeable. /api/superadmin/users
 * refuses independently too, but failing here gives a clean redirect instead
 * of an empty panel.
 *
 * The session is read for the current user's id, so the table can hide its own
 * row's destructive controls.
 */
export default async function AdminUsersPage() {
  const user = await getFreshSession();

  // The null check is redundant with (portal)/layout.tsx at runtime, but
  // TypeScript cannot see across the layout boundary, so it is required.
  if (!user) redirect('/login');
  if (user.role !== 'superadmin') redirect('/admin');

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-navy-900">User Management</h1>
        <p className="mt-1 text-sm text-slate-600">
          Approve registrations, create accounts, and assign roles.
        </p>
      </div>

      <UsersTab currentUserId={user.id} />
    </>
  );
}
