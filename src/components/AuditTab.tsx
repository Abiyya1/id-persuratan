'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuditLogRow } from '@/lib/supabase';

/**
 * Read-only audit log viewer.
 *
 * Renders `details` as pretty-printed JSON rather than a flat string -- the
 * payload is what makes a log entry useful months later.
 */
export function AuditTab() {
  const [logs, setLogs] = useState<(AuditLogRow & { actor: { username: string } | null })[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [action, setAction] = useState('');
  const [search, setSearch] = useState('');
  const requestId = useRef(0);

  // A fixed set of known actions for the filter dropdown. Keeping this static
  // avoids a second endpoint just to populate a select.
  const ACTIONS: Record<string, string> = {
    '': 'Semua tindakan',
    REGISTER: 'Pendaftaran akun',
    LOGIN: 'Masuk',
    LOGIN_BLOCKED_PENDING: 'Masuk ditolak: menunggu persetujuan',
    LOGOUT: 'Keluar',
    CREATE_DOC: 'Pembuatan surat',
    EDIT_DOC: 'Perubahan surat',
    DELETE_DOC: 'Penghapusan surat',
    CREATE_SATKER: 'Penambahan satker',
    EMERGENCY_ALLOCATION: 'Pembuatan nomor darurat',
    EDIT_ID: 'Perubahan nomor surat',
    RESYNC_DOC: 'Sinkronisasi ulang surat',
    CRON_RESYNC: 'Sinkronisasi ulang terjadwal',
    UPDATE_REGISTER_DEFAULTS: 'Perubahan pengaturan bawaan nomor surat',
    SET_REGISTER_DAY_TARGET: 'Penyimpanan rencana nomor per tanggal',
    DELETE_REGISTER_DAY_TARGET: 'Penghapusan rencana nomor per tanggal',
    APPROVE_USER: 'Persetujuan pengguna',
    REJECT_USER: 'Penolakan pengguna',
    CREATE_USER: 'Pembuatan akun',
    UPDATE_USER_ROLE: 'Perubahan peran pengguna',
    UPDATE_USER_STATUS: 'Perubahan status pengguna',
    DELETE_USER: 'Penghapusan akun',
    PROFILE_UPDATE: 'Pembaruan profil',
    PROFILE_PASSWORD: 'Perubahan kata sandi',
  };

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: '50',
      });
      if (action) params.set('action', action);
      if (search.trim()) params.set('search', search.trim());

      const res = await fetch(`/api/audit/list?${params.toString()}`);
      if (!res.ok) return;

      const data = await res.json();
      if (id !== requestId.current) return;
      setLogs(data.logs ?? []);
      setTotalPages(data.pagination?.totalPages ?? 1);
      setTotal(data.pagination?.total ?? 0);
    } catch {
      // Leave the current table intact on a failed refresh.
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [page, action, search]);

  useEffect(() => {
    const requests = requestId;
    void load();
    return () => { ++requests.current; };
  }, [load]);

  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-end gap-3 border-b border-slate-200 p-4">
        <div className="min-w-0 flex-1 basis-64">
          <label htmlFor="audit-search" className="label">Cari riwayat audit</label>
          <input
            id="audit-search"
            type="search"
            className="input"
            maxLength={100}
            placeholder="Nama pengguna, sasaran, atau nomor surat"
            value={search}
            onChange={(e) => {
              ++requestId.current;
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div>
          <label htmlFor="audit-action" className="label">
            Tindakan
          </label>
          <select
            id="audit-action"
            className="input"
            value={action}
            onChange={(e) => {
              ++requestId.current;
              setAction(e.target.value);
              setPage(1);
            }}
          >
            {Object.entries(ACTIONS).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <button type="button" onClick={() => void load()} className="btn-secondary btn-sm ml-auto">
          Muat ulang
        </button>
      </div>

      {loading ? (
        <p className="px-6 py-10 text-center text-sm text-slate-500">Memuat...</p>
      ) : logs.length === 0 ? (
        <p className="px-6 py-10 text-center text-sm text-slate-500">
          Tidak ada riwayat audit yang sesuai dengan penyaringan ini.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Waktu (WIB)</th>
                <th className="px-4 py-3 font-medium">Nama pengguna</th>
                <th className="px-4 py-3 font-medium">Tindakan</th>
                <th className="px-4 py-3 font-medium">Sasaran</th>
                <th className="px-4 py-3 font-medium">Rincian</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {logs.map((log) => (
                <tr key={log.id} className="hover:bg-slate-50">
                  <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-500">
                    {new Date(log.created_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 font-medium text-navy-900">
                    {log.actor?.username ?? (log.action === 'CRON_RESYNC' ? 'Sistem' : 'Tidak tersedia')}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <span className="badge bg-slate-100 font-mono text-slate-700">
                      {ACTIONS[log.action] ?? 'Tindakan tidak dikenal'}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-navy-800">
                    {log.target_id ?? '—'}
                  </td>
                  <td className="px-4 py-3">
                    <details className="group">
                      <summary className="cursor-pointer text-xs text-slate-500 hover:text-navy-700">
                        Lihat
                      </summary>
                      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-50 p-2 text-[0.7rem] text-slate-600">
                        {JSON.stringify(log.details, null, 2)}
                      </pre>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-sm">
        <p className="text-slate-600">
          Halaman <span className="font-medium">{page}</span> dari{' '}
          <span className="font-medium">{totalPages}</span> ({total} entri)
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="btn-secondary btn-sm"
          >
            Sebelumnya
          </button>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="btn-secondary btn-sm"
          >
            Berikutnya
          </button>
        </div>
      </div>
    </section>
  );
}
