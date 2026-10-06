'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AuditLogRow } from '@/lib/supabase';

/**
 * Read-only audit log viewer.
 *
 * Renders `details` as pretty-printed JSON rather than a flat string -- the
 * payload is what makes a log entry useful months later.
 */
export function AuditTab() {
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [action, setAction] = useState('');

  // A fixed set of known actions for the filter dropdown. Keeping this static
  // avoids a second endpoint just to populate a select.
  const ACTIONS = [
    '',
    'REGISTER',
    'LOGIN',
    'LOGIN_BLOCKED_PENDING',
    'LOGOUT',
    'CREATE_DOC',
    'EDIT_DOC',
    'EDIT_ID',
    'RESYNC_DOC',
    'CRON_RESYNC',
    'APPROVE_USER',
    'REJECT_USER',
    'CREATE_USER',
    'UPDATE_USER_ROLE',
    'UPDATE_USER_STATUS',
    'DELETE_USER',
    'PROFILE_UPDATE',
    'PROFILE_PASSWORD',
  ];

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: '50',
      });
      if (action) params.set('action', action);

      const res = await fetch(`/api/audit/list?${params.toString()}`);
      if (!res.ok) return;

      const data = await res.json();
      setLogs(data.logs ?? []);
      setTotalPages(data.pagination?.totalPages ?? 1);
      setTotal(data.pagination?.total ?? 0);
    } catch {
      // Leave the current table intact on a failed refresh.
    } finally {
      setLoading(false);
    }
  }, [page, action]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => setPage(1), [action]);

  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-end gap-3 border-b border-slate-200 p-4">
        <div>
          <label htmlFor="audit-action" className="label">
            Action
          </label>
          <select
            id="audit-action"
            className="input"
            value={action}
            onChange={(e) => setAction(e.target.value)}
          >
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a === '' ? 'All actions' : a}
              </option>
            ))}
          </select>
        </div>

        <button type="button" onClick={() => void load()} className="btn-secondary btn-sm ml-auto">
          Refresh
        </button>
      </div>

      {loading ? (
        <p className="px-6 py-10 text-center text-sm text-slate-500">Loading...</p>
      ) : logs.length === 0 ? (
        <p className="px-6 py-10 text-center text-sm text-slate-500">
          No audit entries match this filter.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">When</th>
                <th className="px-4 py-3 font-medium">Action</th>
                <th className="px-4 py-3 font-medium">Target</th>
                <th className="px-4 py-3 font-medium">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {logs.map((log) => (
                <tr key={log.id} className="hover:bg-slate-50">
                  <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-500">
                    {new Date(log.created_at).toLocaleString()}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <span className="badge bg-slate-100 font-mono text-slate-700">
                      {log.action}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-navy-800">
                    {log.target_id ?? '—'}
                  </td>
                  <td className="px-4 py-3">
                    <details className="group">
                      <summary className="cursor-pointer text-xs text-slate-500 hover:text-navy-700">
                        View
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
          Page <span className="font-medium">{page}</span> of{' '}
          <span className="font-medium">{totalPages}</span> ({total} total)
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="btn-secondary btn-sm"
          >
            Prev
          </button>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="btn-secondary btn-sm"
          >
            Next
          </button>
        </div>
      </div>
    </section>
  );
}
