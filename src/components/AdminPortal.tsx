'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getBrowserClient } from '@/lib/supabase-client';
import { DocumentsTab } from './DocumentsTab';
import { Toast, type ToastState } from './Toast';
import type { DocumentRow, SyncStatus } from '@/lib/supabase';

/**
 * Documents section of the Management Portal: the documents table, the Realtime
 * subscription, the sync-queue badge, export, and manual resync.
 *
 * Takes no props. Every capability it offers is role-gated server-side by
 * ../app/(portal)/admin/layout.tsx, with the superadmin-only gate for user
 * management in ../app/(portal)/admin/users/page.tsx -- so nothing here needs
 * to know who is looking.
 *
 * Realtime design note: the anon key has SELECT on `documents` (see
 * schema.sql), so the socket receives row-level changes without any
 * app-level authorization. That is a deliberate trade -- it is what makes
 * live updates work at all under a custom (non-Supabase-Auth) session. Every
 * mutation still goes through a service-role API route; the anon key cannot
 * write.
 */
export function AdminPortal() {
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<SyncStatus | 'all'>('all');

  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);

  const [queue, setQueue] = useState({ failed: 0, pending: 0 });
  const [live, setLive] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);

  // Guards against a stale in-flight fetch overwriting a newer one.
  const requestId = useRef(0);

  // Debounce the search box so typing does not fire a query per keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 350);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => setPage(1), [debouncedSearch, statusFilter]);

  const loadQueue = useCallback(async () => {
    try {
      const res = await fetch('/api/documents/resync');
      if (res.ok) {
        const data = await res.json();
        setQueue({ failed: data.failed ?? 0, pending: data.pending ?? 0 });
      }
    } catch {
      // Non-critical badge; leave the last known value.
    }
  }, []);

  const loadDocuments = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);

    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        syncStatus: statusFilter,
      });
      if (debouncedSearch) params.set('search', debouncedSearch);

      const res = await fetch(`/api/documents/list?${params.toString()}`);
      if (!res.ok) return;

      const data = await res.json();

      // A newer request already landed -- discard this response.
      if (id !== requestId.current) return;

      setDocuments(data.documents ?? []);
      setTotal(data.pagination?.total ?? 0);
      setTotalPages(data.pagination?.totalPages ?? 1);
    } catch {
      if (id === requestId.current) {
        setToast({ kind: 'error', text: 'Could not load documents.' });
      }
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [page, pageSize, statusFilter, debouncedSearch]);

  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  // ---- Supabase Realtime ---------------------------------------------------
  useEffect(() => {
    let channel: ReturnType<ReturnType<typeof getBrowserClient>['channel']> | null = null;
    let cancelled = false;

    try {
      const supabase = getBrowserClient();

      channel = supabase
        .channel('documents-live')
        .on(
          // INSERT and UPDATE both, so a fresh row appears without a refresh
          // and a pending -> synced transition updates in place.
          'postgres_changes',
          { event: '*', schema: 'public', table: 'documents' },
          () => {
            // Refetch rather than patching local state: the server is the
            // source of truth for filters, pagination and sort order, and
            // reconciling all three client-side is where bugs live.
            void loadDocuments();
            void loadQueue();
          },
        )
        .subscribe((status) => {
          if (cancelled) return;
          setLive(status === 'SUBSCRIBED');
        });
    } catch {
      // Missing NEXT_PUBLIC_* vars, or the browser blocked the socket. The
      // table still works via the manual Refresh button, so this is not fatal.
      setLive(false);
    }

    return () => {
      cancelled = true;
      if (channel) {
        // Unsubscribe before removing, otherwise the socket lingers.
        try {
          channel.unsubscribe();
        } catch {
          // Already torn down.
        }
      }
    };
  }, [loadDocuments, loadQueue]);

  // ---- Manual resync -------------------------------------------------------
  const [resyncing, setResyncing] = useState(false);

  async function handleResyncAll() {
    setResyncing(true);
    try {
      const res = await fetch('/api/documents/resync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch: true }),
      });

      const data = await res.json();

      setToast({
        kind: data.summary?.failed > 0 ? 'error' : 'success',
        text: data.message ?? 'Resync finished.',
      });

      await Promise.all([loadDocuments(), loadQueue()]);
    } catch {
      setToast({ kind: 'error', text: 'Resync failed to reach the server.' });
    } finally {
      setResyncing(false);
    }
  }

  async function handleResyncOne(id: number) {
    try {
      const res = await fetch('/api/documents/resync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });

      const data = await res.json();

      setToast({
        kind: data.outcome?.ok ? 'success' : 'error',
        text: data.message ?? 'Resync attempted.',
      });

      await Promise.all([loadDocuments(), loadQueue()]);
    } catch {
      setToast({ kind: 'error', text: 'Resync failed to reach the server.' });
    }
  }

  async function handleExport() {
    const params = new URLSearchParams({ syncStatus: statusFilter });
    if (debouncedSearch) params.set('search', debouncedSearch);

    try {
      const res = await fetch(`/api/documents/export?${params.toString()}`);
      if (!res.ok) {
        setToast({ kind: 'error', text: 'Export failed.' });
        return;
      }

      const blob = await res.blob();

      // Object URL is revoked immediately after the click handler returns --
      // otherwise the blob stays in memory for the life of the tab.
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `documents-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      setToast({ kind: 'success', text: 'CSV exported.' });
    } catch {
      setToast({ kind: 'error', text: 'Export failed.' });
    }
  }

  return (
    <div className="space-y-6">
      <Toast toast={toast} onDismiss={() => setToast(null)} />

      {/* ---- Toolbar --------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`badge ${live ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'}`}
          title={
            live
              ? 'Connected to Supabase Realtime'
              : 'Realtime not connected -- use Refresh to update manually'
          }
        >
          <span
            aria-hidden
            className={`mr-1.5 h-1.5 w-1.5 rounded-full ${live ? 'bg-emerald-500' : 'bg-slate-400'}`}
          />
          {live ? 'Live' : 'Offline'}
        </span>

        <button type="button" onClick={() => void loadDocuments()} className="btn-secondary btn-sm">
          Refresh
        </button>
        <button type="button" onClick={() => void handleExport()} className="btn-secondary btn-sm">
          Export CSV
        </button>
        <button
          type="button"
          onClick={() => void handleResyncAll()}
          disabled={resyncing}
          className="btn-primary btn-sm"
        >
          {resyncing ? 'Re-syncing...' : 'Re-sync all'}
        </button>
      </div>

      {/* ---- Queue banner -------------------------------------------------- */}
      {queue.failed > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span className="font-medium">
            {queue.failed} document{queue.failed === 1 ? '' : 's'} failed to sync.
          </span>
          <span className="text-xs">
            The cron job retries automatically every 5 minutes.
          </span>
          <button
            type="button"
            onClick={() => void handleResyncAll()}
            disabled={resyncing}
            className="btn-secondary btn-sm ml-auto"
          >
            Retry now
          </button>
        </div>
      )}

      {/* ---- Panel --------------------------------------------------------- */}
      <DocumentsTab
        documents={documents}
        loading={loading}
        search={search}
        setSearch={setSearch}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        page={page}
        setPage={setPage}
        totalPages={totalPages}
        total={total}
        onResyncOne={handleResyncOne}
      />
    </div>
  );
}
