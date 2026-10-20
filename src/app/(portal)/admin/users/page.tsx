import { redirect } from 'next/navigation';
import { getFreshSession } from '@/lib/auth';
import { UsersTab } from '@/components/UsersTab';

export default async function AdminUsersPage() {
  const user = await getFreshSession();

  // The null check is redundant with (portal)/layout.tsx at runtime, but
  // TypeScript cannot see across the layout boundary, so it is required.
  if (!user) redirect('/login');
  if (user.role !== 'admin' && user.role !== 'superadmin') redirect('/dashboard');

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-navy-900">
          {user.role === 'superadmin' ? 'Kelola Pengguna' : 'Permintaan Akses'}
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          {user.role === 'superadmin'
            ? 'Setujui pendaftaran, buat akun, dan atur peran pengguna.'
            : 'Setujui atau tolak permintaan pendaftaran pengguna yang menunggu persetujuan.'}
        </p>
      </div>

      <UsersTab currentUserId={user.id} currentUserRole={user.role} />
    </>
  );
}
