import { redirect } from 'next/navigation';
import { getFreshSession } from '@/lib/auth';
import { DocumentPortal } from '@/components/DocumentPortal';
import type { DocumentRow } from '@/lib/supabase';

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
        <h1 className="text-2xl font-bold text-navy-900">My Documents</h1>
        <p className="mt-1 text-sm text-slate-600">
          Submit a document to receive an atomic, duplicate-proof ID.
        </p>
      </div>

      <DocumentPortal
        userId={user.id}
        username={user.username}
        initialDocuments={[] as DocumentRow[]}
      />
    </>
  );
}
