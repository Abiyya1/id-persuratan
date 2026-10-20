'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { RoleBadge, StatusBadge } from './Badges';
import { Toast, type ToastState } from './Toast';
import type { PublicUser, Role } from '@/lib/supabase';

export function UsersTab({
  currentUserId,
  currentUserRole,
}: {
  currentUserId: string;
  currentUserRole: 'admin' | 'superadmin';
}) {
  const isSuperadmin = currentUserRole === 'superadmin';
  // Owns its own toast rather than reporting through a prop: the component that
  // emits the messages is the one that should render them. Callers that also
  // want a toast (the documents panel) keep their own.
  const [toast, setToast] = useState<ToastState>(null);
  const onToast = setToast;

  const [users, setUsers] = useState<PublicUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'pending' | 'approved' | 'rejected'>('pending');
  const [busyId, setBusyId] = useState<string | null>(null);
  const requestId = useRef(0);
  const mounted = useRef(false);
  const filterRef = useRef(filter);

  const [showCreate, setShowCreate] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<Exclude<Role, 'superadmin'>>('user');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    if (!mounted.current) return;
    const id = ++requestId.current;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (!isSuperadmin) params.set('status', 'pending');
      else if (filter !== 'all') params.set('status', filter);

      const res = await fetch(`/api/admin/users?${params.toString()}`);
      if (id !== requestId.current) return;
      if (!res.ok) {
        onToast({ kind: 'error', text: 'Tidak dapat memuat pengguna.' });
        return;
      }
      const data = await res.json();
      if (id !== requestId.current) return;
      setUsers(data.users ?? []);
    } catch {
      if (id === requestId.current) {
        onToast({ kind: 'error', text: 'Tidak dapat menghubungi server.' });
      }
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [filter, isSuperadmin, onToast]);

  const refreshRef = useRef(load);
  useEffect(() => {
    refreshRef.current = load;
    filterRef.current = filter;
  }, [load, filter]);

  useEffect(() => {
    const requests = requestId;
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      ++requests.current;
    };
  }, [load]);

  async function patchUser(userId: string, body: Record<string, unknown>) {
    setBusyId(userId);
    try {
      const res = await fetch('/api/admin/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, ...body }),
      });

      const data = await res.json();
      if (!mounted.current) return;

      if (!res.ok) {
        onToast({ kind: 'error', text: data.error ?? 'Pembaruan gagal.' });
        return;
      }

      onToast({ kind: 'success', text: data.message ?? 'Berhasil diperbarui.' });
      await refreshRef.current();
    } catch {
      if (mounted.current) {
        onToast({ kind: 'error', text: 'Tidak dapat menghubungi server.' });
      }
    } finally {
      if (mounted.current) setBusyId(null);
    }
  }

  async function createUser() {
    if (!isSuperadmin) return;
    setCreating(true);
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: newUsername.trim(),
          password: newPassword,
          role: newRole,
        }),
      });

      const data = await res.json();
      if (!mounted.current) return;

      if (!res.ok) {
        onToast({ kind: 'error', text: data.error ?? 'Tidak dapat membuat akun.' });
        return;
      }

      onToast({ kind: 'success', text: data.message ?? 'Akun berhasil dibuat.' });
      setNewUsername('');
      setNewPassword('');
      setNewRole('user');
      setShowCreate(false);
      if (filterRef.current === 'all') {
        await refreshRef.current();
      } else {
        setFilter('all');
      }
    } catch {
      if (mounted.current) {
        onToast({ kind: 'error', text: 'Tidak dapat menghubungi server.' });
      }
    } finally {
      if (mounted.current) setCreating(false);
    }
  }

  const visibleUsers = isSuperadmin
    ? users
    : users.filter((user) => user.role === 'user' && user.status === 'pending');

  return (
    <div className="space-y-4">
      <Toast toast={toast} onDismiss={() => setToast(null)} />

      {isSuperadmin && (
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <label htmlFor="user-filter" className="label">
              Saring berdasarkan status
            </label>
            <select
              id="user-filter"
              className="input"
              value={filter}
              onChange={(e) => setFilter(e.target.value as typeof filter)}
            >
              <option value="all">Semua</option>
              <option value="pending">Menunggu persetujuan</option>
              <option value="approved">Disetujui</option>
              <option value="rejected">Ditolak</option>
            </select>
          </div>

          <button
            type="button"
            onClick={() => setShowCreate((v) => !v)}
            className="btn-primary ml-auto"
          >
            {showCreate ? 'Tutup' : 'Buat akun'}
          </button>
        </div>
      )}

      {isSuperadmin && showCreate && (
        <section className="card p-4">
          <h3 className="mb-3 text-sm font-semibold text-navy-900">Buat akun</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor="new-username" className="label text-xs">
                Nama pengguna
              </label>
              <input
                id="new-username"
                className="input"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="new-password" className="label text-xs">
                Kata sandi
              </label>
              <input
                id="new-password"
                type="password"
                className="input"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
              <p className="mt-1 text-xs text-slate-500">Minimal 8 karakter, dengan huruf dan angka.</p>
            </div>
            <div>
              <label htmlFor="new-role" className="label text-xs">
                Peran
              </label>
              <select
                id="new-role"
                className="input"
                value={newRole}
                onChange={(e) => setNewRole(e.target.value as Exclude<Role, 'superadmin'>)}
              >
                <option value="user">Pengguna</option>
                <option value="admin">Administrator</option>
              </select>
            </div>
          </div>
          <button
            type="button"
            onClick={createUser}
            disabled={creating || !newUsername || !newPassword}
            className="btn-primary btn-sm mt-3"
          >
            {creating ? 'Sedang membuat...' : 'Buat akun'}
          </button>
        </section>
      )}

      <section className="card overflow-hidden">
        {loading ? (
          <p className="px-6 py-10 text-center text-sm text-slate-500">Memuat pengguna...</p>
        ) : visibleUsers.length === 0 ? (
          <p className="px-6 py-10 text-center text-sm text-slate-500">
            {isSuperadmin
              ? 'Tidak ada pengguna yang sesuai dengan penyaringan ini.'
              : 'Tidak ada permintaan akses yang menunggu persetujuan.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">Nama pengguna</th>
                  <th className="px-4 py-3 font-medium">Peran</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Dibuat</th>
                  <th className="px-4 py-3 text-right font-medium">Tindakan</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {visibleUsers.map((u) => {
                  const isSelf = u.id === currentUserId;
                  const isProtected = isSelf || u.role === 'superadmin';
                  return (
                    <tr key={u.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 font-medium text-slate-900">
                        {u.username}
                        {isSelf && (
                          <span className="ml-2 text-xs font-normal text-slate-400">(Anda)</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {!isSuperadmin || isProtected ? (
                          <RoleBadge role={u.role} />
                        ) : (
                          <select
                            className="input input-sm"
                            aria-label={`Peran untuk ${u.username}`}
                            value={u.role}
                            disabled={busyId === u.id}
                            onChange={(e) =>
                              void patchUser(u.id, { role: e.target.value })
                            }
                          >
                            <option value="user">Pengguna</option>
                            <option value="admin">Administrator</option>
                          </select>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={u.status} />
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-500">
                        {new Date(u.created_at).toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta' })}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right">
                        {!isProtected && u.status === 'pending' && (isSuperadmin || u.role === 'user') && (
                          <>
                            <button
                              type="button"
                              onClick={() => void patchUser(u.id, { status: 'approved' })}
                              disabled={busyId === u.id}
                              className="btn-primary btn-sm"
                            >
                              Setujui
                            </button>{' '}
                            <button
                              type="button"
                              onClick={() => void patchUser(u.id, { status: 'rejected' })}
                              disabled={busyId === u.id}
                              className="btn-secondary btn-sm"
                            >
                              Tolak
                            </button>
                          </>
                        )}
                        {isSuperadmin && !isProtected && u.status === 'rejected' && (
                          <button
                            type="button"
                            onClick={() => void patchUser(u.id, { status: 'approved' })}
                            disabled={busyId === u.id}
                            className="btn-secondary btn-sm"
                          >
                            Setujui
                          </button>
                        )}
                        {isSuperadmin && !isProtected && u.status === 'approved' && u.role === 'user' && (
                          <button
                            type="button"
                            onClick={() => {
                              if (confirm(`Hapus akun "${u.username}"? Tindakan ini tidak dapat dibatalkan.`)) {
                                void patchUser(u.id, { delete: true });
                              }
                            }}
                            disabled={busyId === u.id}
                            className="btn-danger btn-sm"
                          >
                            Hapus
                          </button>
                        )}
                        {isProtected && (
                          <span className="text-xs text-slate-500">Dilindungi</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
