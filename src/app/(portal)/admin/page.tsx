import { DocumentPortal } from '@/components/DocumentPortal';
import { redirect } from 'next/navigation';
import { getFreshSession } from '@/lib/auth';

/**
 * Administrator letter creation.
 *
 * Shell and route layout also check access. Re-read the user here so
 * management controls follow the latest role, not a stale cookie.
 */
export default async function AdminDocumentsPage() {
  const user = await getFreshSession();
  if (!user) redirect('/login');
  const canManage = user.role === 'admin' || user.role === 'superadmin';
  if (!canManage) redirect('/dashboard');
  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-navy-900">Buat Nomor Surat</h1>
        <p className="mt-1 text-sm text-slate-600">
          Daftarkan surat baru dan kelola katalog satker.
        </p>
      </div>
      <DocumentPortal canManage={canManage} />
    </>
  );
}
