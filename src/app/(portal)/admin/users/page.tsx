import { redirect } from 'next/navigation';
import { getFreshSession } from '@/lib/auth';
import { UsersSection } from '@/components/UsersSection';

/**
 * User Management -- superadmin only.
 *
 * The role is re-checked because the URL is typeable. /api/superadmin/users
 * refuses independently too, but failing here gives a clean redirect instead
 * of an empty panel.
 */
export default async function AdminUsersPage() {
  const user = await getFreshSession();

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

      <UsersSection currentUserId={user.id} />
    </>
  );
}
