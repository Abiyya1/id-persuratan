import { AuditTab } from '@/components/AuditTab';

/**
 * Audit Log. Admin and superadmin both get this; the API enforces it too.
 *
 * Purely presentational: (portal)/layout.tsx redirects an unauthenticated
 * visitor and ./layout.tsx gates the role, so there is nothing for this page
 * to check and nothing it needs from the session.
 */
export default function AdminAuditPage() {
  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-navy-900">Riwayat Audit</h1>
        <p className="mt-1 text-sm text-slate-600">
          Semua perubahan surat dan akun, mulai dari yang terbaru.
        </p>
      </div>

      <AuditTab />
    </>
  );
}
