'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RoleBadge, StatusBadge } from './Badges';
import type { PublicUser, Role } from '@/lib/supabase';

/**
 * Superadmin User Management: approve/reject the registration queue, create
 * accounts manually, change roles, delete accounts.
 *
 * The API independently enforces every rule here (including the "cannot
 * demote yourself / cannot remove the last superadmin" guards), so a stale UI
 * can never escalate privileges.
 */
export function UsersTab({
  currentUserId,
  onToast,
}: {
  currentUserId: string;
  onToast: (t: { kind: 'success' | 'error'; text: string }) => void;
}) {
  const router = useRouter();

  const [users, setUsers] = useState<PublicUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'pending' | 'approved' | 'rejected'>('pending');
  const [busyId, setBusyId] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<Role>('user');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filter !== 'all') params.set('status', filter);

      const res = await fetch(`/api/superadmin/users?${params.toString()}`);
      if (!res.ok) {
        onToast({ kind: 'error', text: 'Could not load users.' });
        return;
      }
      const data = await res.json();
      setUsers(data.users ?? []);
    } catch {
      onToast({ kind: 'error', text: 'Could not reach the server.' });
    } finally {
      setLoading(false);
    }
  }, [filter, onToast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function patchUser(userId: string, body: Record<string, unknown>) {
    setBusyId(userId);
    try {
      const res = await fetch('/api/superadmin/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, ...body }),
      });

      const data = await res.json();

      if (!res.ok) {
        onToast({ kind: 'error', text: data.error ?? 'Update failed.' });
        return;
      }

      onToast({ kind: 'success', text: data.message ?? 'Updated.' });
      await load();
      router.refresh();
    } catch {
      onToast({ kind: 'error', text: 'Could not reach the server.' });
    } finally {
      setBusyId(null);
    }
  }

  async function createUser() {
    setCreating(true);
    try {
      const res = await fetch('/api/superadmin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: newUsername.trim(),
          password: newPassword,
          role: newRole,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        onToast({ kind: 'error', text: data.error ?? 'Could not create account.' });
        return;
      }

      onToast({ kind: 'success', text: data.message ?? 'Account created.' });
      setNewUsername('');
      setNewPassword('');
      setNewRole('user');
      setShowCreate(false);
      setFilter('all');
      await load();
    } catch {
      onToast({ kind: 'error', text: 'Could not reach the server.' });
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <label htmlFor="user-filter" className="label">
            Filter by status
          </label>
          <select
            id="user-filter"
            className="input"
            value={filter}
            onChange={(e) => setFilter(e.target.value as typeof filter)}
          >
            <option value="all">All</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
        </div>

        <button
          type="button"
          onClick={() => setShowCreate((v) => !v)}
          className="btn-primary ml-auto"
        >
          {showCreate ? 'Close' : 'Create account'}
        </button>
      </div>

      {showCreate && (
        <section className="card p-4">
          <h3 className="mb-3 text-sm font-semibold text-navy-900">Create an account</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor="new-username" className="label text-xs">
                Username
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
                Password
              </label>
              <input
                id="new-password"
                type="password"
                className="input"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
              <p className="mt-1 text-xs text-slate-500">8+ chars, a letter and a number.</p>
            </div>
            <div>
              <label htmlFor="new-role" className="label text-xs">
                Role
              </label>
              <select
                id="new-role"
                className="input"
                value={newRole}
                onChange={(e) => setNewRole(e.target.value as Role)}
              >
                <option value="user">user</option>
                <option value="admin">admin</option>
                <option value="superadmin">superadmin</option>
              </select>
            </div>
          </div>
          <button
            type="button"
            onClick={createUser}
            disabled={creating || !newUsername || !newPassword}
            className="btn-primary btn-sm mt-3"
          >
            {creating ? 'Creating...' : 'Create account'}
          </button>
        </section>
      )}

      <section className="card overflow-hidden">
        {loading ? (
          <p className="px-6 py-10 text-center text-sm text-slate-500">Loading...</p>
        ) : users.length === 0 ? (
          <p className="px-6 py-10 text-center text-sm text-slate-500">
            No users match this filter.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">Username</th>
                  <th className="px-4 py-3 font-medium">Role</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Created</th>
                  <th className="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {users.map((u) => {
                  const isSelf = u.id === currentUserId;
                  return (
                    <tr key={u.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 font-medium text-slate-900">
                        {u.username}
                        {isSelf && (
                          <span className="ml-2 text-xs font-normal text-slate-400">(you)</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {isSelf ? (
                          <RoleBadge role={u.role} />
                        ) : (
                          <select
                            className="input input-sm"
                            aria-label={`Role for ${u.username}`}
                            value={u.role}
                            disabled={busyId === u.id}
                            onChange={(e) =>
                              void patchUser(u.id, { role: e.target.value })
                            }
                          >
                            <option value="user">user</option>
                            <option value="admin">admin</option>
                            <option value="superadmin">superadmin</option>
                          </select>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={u.status} />
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-500">
                        {new Date(u.created_at).toLocaleDateString()}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right">
                        {!isSelf && u.status === 'pending' && (
                          <>
                            <button
                              type="button"
                              onClick={() => void patchUser(u.id, { status: 'approved' })}
                              disabled={busyId === u.id}
                              className="btn-primary btn-sm"
                            >
                              Approve
                            </button>{' '}
                            <button
                              type="button"
                              onClick={() => void patchUser(u.id, { status: 'rejected' })}
                              disabled={busyId === u.id}
                              className="btn-secondary btn-sm"
                            >
                              Reject
                            </button>
                          </>
                        )}
                        {!isSelf && u.status === 'rejected' && (
                          <button
                            type="button"
                            onClick={() => void patchUser(u.id, { status: 'approved' })}
                            disabled={busyId === u.id}
                            className="btn-secondary btn-sm"
                          >
                            Approve
                          </button>
                        )}
                        {!isSelf && u.status === 'approved' && u.role === 'user' && (
                          <button
                            type="button"
                            onClick={() => {
                              if (confirm(`Delete account "${u.username}"? This cannot be undone.`)) {
                                void patchUser(u.id, { delete: true });
                              }
                            }}
                            disabled={busyId === u.id}
                            className="btn-danger btn-sm"
                          >
                            Delete
                          </button>
                        )}
                        {isSelf && (
                          <span className="text-xs text-slate-400">—</span>
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
