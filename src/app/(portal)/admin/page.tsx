import { redirect } from 'next/navigation';
import { getFreshSession } from '@/lib/auth';
import { AdminPortal } from '@/components/AdminPortal';

/**
 * Management Portal -- Documents section.
 *
 * Shell is in ../../(portal)/layout.tsx, role gate in ./layout.tsx.
 * AdminPortal no longer takes a `tab` prop; it is only rendered here.
 */
export default async function AdminDocumentsPage() {
  const user = await getFreshSession();
  if (!user) redirect('/login');

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-navy-900">Management Portal</h1>
        <p className="mt-1 text-sm text-slate-600">
          All documents, live sync status, and manual re-sync.
        </p>
      </div>

      <AdminPortal />
    </>
  );
}
