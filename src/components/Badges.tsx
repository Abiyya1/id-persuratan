'use client';

import type { SyncStatus } from '@/lib/supabase';

/** Colour mapping for the three sync states. */
export function SyncBadge({ status }: { status: SyncStatus }) {
  const styles: Record<SyncStatus, string> = {
    synced: 'bg-emerald-100 text-emerald-800',
    pending: 'bg-amber-100 text-amber-800',
    failed: 'bg-red-100 text-red-800',
  };

  const labels: Record<SyncStatus, string> = {
    synced: 'Tersinkron',
    pending: 'Menunggu',
    failed: 'Gagal',
  };

  return (
    <span className={`badge ${styles[status]}`}>
      <span
        aria-hidden
        className={`mr-1.5 h-1.5 w-1.5 rounded-full ${
          status === 'synced'
            ? 'bg-emerald-500'
            : status === 'pending'
              ? 'bg-amber-500'
              : 'bg-red-500'
        }`}
      />
      {labels[status] ?? status}
    </span>
  );
}

export const ROLE_LABELS: Record<string, string> = {
  user: 'Pengguna',
  admin: 'Administrator',
  superadmin: 'Administrator Utama',
};

export function RoleBadge({ role }: { role: string }) {
  const styles: Record<string, string> = {
    user: 'bg-slate-100 text-slate-700',
    admin: 'bg-navy-100 text-navy-800',
    superadmin: 'bg-purple-100 text-purple-800',
  };

  return <span className={`badge ${styles[role] ?? styles.user}`}>{ROLE_LABELS[role] ?? 'Peran tidak dikenal'}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: 'bg-amber-100 text-amber-800',
    approved: 'bg-emerald-100 text-emerald-800',
    rejected: 'bg-red-100 text-red-800',
  };

  const labels: Record<string, string> = {
    pending: 'Menunggu persetujuan',
    approved: 'Disetujui',
    rejected: 'Ditolak',
  };

  return <span className={`badge ${styles[status] ?? 'bg-slate-100 text-slate-700'}`}>{labels[status] ?? 'Status tidak dikenal'}</span>;
}
