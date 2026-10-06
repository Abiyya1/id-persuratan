import { redirect } from 'next/navigation';
import { getFreshSession } from '@/lib/auth';
import { AuditTab } from '@/components/AuditTab';

/** Audit Log. Admin and superadmin both get this; the API enforces it too. */
export default async function AdminAuditPage() {
  const user = await getFreshSession();
  if (!user) redirect('/login');

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-navy-900">Audit Log</h1>
        <p className="mt-1 text-sm text-slate-600">
          Every document and account change, newest first.
        </p>
      </div>

      <AuditTab />
    </>
  );
}
