import { redirect } from 'next/navigation';
import { getFreshSession } from '@/lib/auth';
import { AppNav } from '@/components/AppNav';
import { DocumentPortal } from '@/components/DocumentPortal';
import type { DocumentRow } from '@/lib/supabase';

/**
 * Dashboard 1 -- User Portal.
 *
 * Server component: verifies the session, then hands a serialisable snapshot
 * to the client component which handles the form and the live list.
 */
export default async function DashboardPage() {
  const user = await getFreshSession();

  // Middleware already blocks this, but a server component must never trust
  // that alone -- middleware is a redirect layer, not an authz check.
  if (!user) redirect('/login');

  return (
    <div className="min-h-screen">
      <AppNav user={user} active="dashboard" />

      <main className="mx-auto max-w-5xl px-4 py-8">
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
      </main>
    </div>
  );
}
