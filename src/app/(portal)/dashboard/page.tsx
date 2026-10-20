import { redirect } from 'next/navigation';
import { getFreshSession } from '@/lib/auth';
import { DocumentPortal } from '@/components/DocumentPortal';

/**
 * Dashboard 1 -- User Portal.
 *
 * The shell and session check live in ../layout.tsx.
 */
export default async function DashboardPage() {
  const user = await getFreshSession();

  if (!user) redirect('/login');

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-navy-900">Buat Nomor Surat</h1>
        <p className="mt-1 text-sm text-slate-600">
          Daftarkan surat baru. Surat yang sudah dibuat tersedia di Cari Surat.
        </p>
      </div>

      <DocumentPortal
        canManage={user.role === 'admin' || user.role === 'superadmin'}
      />
    </>
  );
}
