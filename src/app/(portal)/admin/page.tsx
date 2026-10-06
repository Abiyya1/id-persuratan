import { AdminPortal } from '@/components/AdminPortal';

/**
 * Management Portal -- Documents section.
 *
 * Shell is in ../../(portal)/layout.tsx, role gate in ./layout.tsx. Both
 * already redirect when the session is missing, so this page does not re-check:
 * AdminPortal takes no user context.
 */
export default function AdminDocumentsPage() {
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
