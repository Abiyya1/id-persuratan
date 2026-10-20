'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { DocumentsTab } from './DocumentsTab';
import { Toast, type ToastState } from './Toast';
import type { DocumentRow, SyncStatus } from '@/lib/supabase';
import type { DocumentSortField, DocumentSortDirection } from '@/lib/document-sort';

/** Shared search uses only authorized API responses, including background refresh. */
export function DocumentSearch() {
  const router = useRouter();
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<SyncStatus | 'all'>('all');
  const [sortBy, setSortBy] = useState<DocumentSortField>('created');
  const [sortDirection, setSortDirection] = useState<DocumentSortDirection>('desc');
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [queue, setQueue] = useState({ failed: 0, pending: 0, deleting: 0 });
  const [live, setLive] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [resyncing, setResyncing] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [scope, setScope] = useState<string | null>(null);
  const scopeRef = useRef<string | null>(null);
  const requestId = useRef(0);
  const authorized = useRef(true);
  const actionBusy = useRef(false);
  const [debouncedSearch, setDebouncedSearch] = useState('');

  const handleAuthLoss = useCallback((status: number) => {
    if (status !== 401 && status !== 403) return false;
    authorized.current = false;
    ++requestId.current;
    setDocuments([]);
    setTotal(0);
    setTotalPages(1);
    setQueue({ failed: 0, pending: 0, deleting: 0 });
    setLoading(false);
    setLive(false);
    router.replace('/login');
    router.refresh();
    return true;
  }, [router]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 350);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => setPage(1), [debouncedSearch, statusFilter]);

  const loadQueue = useCallback(async () => {
    if (!authorized.current) return;
    try {
      const res = await fetch('/api/documents/resync', { cache: 'no-store' });
      if (handleAuthLoss(res.status)) return;
      if (!res.ok) throw new Error('Tidak dapat memuat antrean sinkronisasi.');
      const data = await res.json();
      if (authorized.current) setQueue({ failed: data.failed ?? 0, pending: data.pending ?? 0, deleting: data.deleting ?? 0 });
    } catch {
      if (authorized.current) setToast({ kind: 'error', text: 'Antrean sinkronisasi tidak dapat diperbarui. Gunakan Muat ulang untuk mencoba lagi.' });
    }
  }, [handleAuthLoss]);

  const loadDocuments = useCallback(async () => {
    if (!authorized.current) return;
    const id = ++requestId.current;
    if (!editing) setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page), pageSize: '25', syncStatus: statusFilter, sortBy, sortDirection,
      });
      if (debouncedSearch) params.set('search', debouncedSearch);
      const res = await fetch(`/api/documents/list?${params}`, { cache: 'no-store' });
      if (handleAuthLoss(res.status)) return;
      const data = await res.json();
      if (id !== requestId.current || !authorized.current) return;
      if (!res.ok) {
        setLive(false);
        setToast({ kind: 'error', text: data.error ?? 'Tidak dapat memuat daftar surat. Gunakan Muat ulang untuk mencoba lagi.' });
        return;
      }
      const scopeChanged = scopeRef.current !== null && scopeRef.current !== data.scope;
      scopeRef.current = data.scope;
      setScope(data.scope);
      if (scopeChanged) {
        setDocuments([]);
        setEditing(false);
        setPage(1);
        setToast({ kind: 'error', text: 'Hak akses berubah. Daftar dimuat ulang dan penyuntingan sebelumnya ditutup.' });
        router.refresh();
        if (page !== 1) return;
      }
      if (editing && !scopeChanged) {
        setLive(true);
        return;
      }
      const pages = Math.max(1, data.pagination?.totalPages ?? 1);
      setTotal(data.pagination?.total ?? 0);
      setTotalPages(pages);
      if (page > pages) {
        setDocuments([]);
        setPage(pages); // The page effect fetches the new last page after deletion.
        return;
      }
      setDocuments(data.documents ?? []);
      setLive(true);
    } catch {
      if (id === requestId.current && authorized.current) {
        setLive(false);
        setToast({ kind: 'error', text: 'Tidak dapat memperbarui daftar surat. Gunakan Muat ulang untuk mencoba lagi.' });
      }
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [page, statusFilter, debouncedSearch, sortBy, sortDirection, handleAuthLoss, editing, router]);

  const refresh = useCallback(async () => {
    await Promise.all([loadDocuments(), loadQueue()]);
  }, [loadDocuments, loadQueue]);
  const refreshRef = useRef(refresh);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    // API polling avoids exposing unscoped realtime payloads under custom sessions.
    function onVisibility() {
      if (document.visibilityState === 'visible') void refresh();
    }
    const timer = setInterval(onVisibility, 15_000);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh]);

  async function handleResyncAll() {
    if (actionBusy.current || !authorized.current) return;
    actionBusy.current = true;
    setResyncing(true);
    try {
      const res = await fetch('/api/documents/resync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batch: true }),
      });
      if (handleAuthLoss(res.status)) return;
      const data = await res.json();
      setToast({ kind: !res.ok || data.summary?.failed > 0 || data.syncWarning ? 'error' : 'success', text: [data.error ?? data.message ?? 'Sinkronisasi selesai.', data.syncWarning].filter(Boolean).join(' ') });
      await refreshRef.current();
    } catch {
      setToast({ kind: 'error', text: 'Tidak dapat menghubungi server untuk sinkronisasi.' });
    } finally {
      actionBusy.current = false;
      setResyncing(false);
    }
  }

  async function handleRowAction(id: number, deleting: boolean) {
    if (actionBusy.current || !authorized.current) return;
    const doc = documents.find((item) => item.id === id);
    if (!doc?.letter_date) return;
    if (deleting && !window.confirm(`Hapus surat ${doc.surat_number}? Seluruh isi surat akan dikosongkan. Jika ini nomor terpakai terakhir, seluruh sisa nomor kosong di akhir register akan dihapus setelah pengosongan Google Sheets dikonfirmasi. Nomor surat lain yang terpakai tidak digeser. Jika masih ada nomor terpakai yang lebih tinggi, nomor ini tersedia kembali hanya pada tanggal asli ${doc.letter_date} setelah pengosongan dikonfirmasi.`)) return;
    actionBusy.current = true;
    setBusyId(id);
    try {
      const res = await fetch(deleting ? '/api/documents/delete' : '/api/documents/resync', {
        method: deleting ? 'DELETE' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
      });
      if (handleAuthLoss(res.status)) return;
      const data = await res.json();
      const pending = deleting && data.releasePending
        ? 'Nomor belum dapat dipakai kembali sampai seluruh pengosongan terkait di Sheets dikonfirmasi.' : '';
      setToast({ kind: !res.ok || data.syncWarning || data.releasePending || (!deleting && !data.outcome?.ok) ? 'error' : 'success', text: [data.error ?? data.message ?? 'Permintaan selesai.', pending, data.syncWarning].filter(Boolean).join(' ') });
      await refreshRef.current();
    } catch {
      setToast({ kind: 'error', text: 'Tidak dapat menghubungi server. Muat ulang daftar sebelum mencoba kembali.' });
    } finally {
      actionBusy.current = false;
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <Toast toast={toast} onDismiss={() => setToast(null)} />
      <div className="flex flex-wrap items-center gap-2">
        <span className={`badge ${live ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'}`} title="Daftar diperbarui otomatis setiap 15 detik saat halaman terlihat; Muat ulang tersedia jika koneksi gagal.">
          <span aria-hidden className={`mr-1.5 h-1.5 w-1.5 rounded-full ${live ? 'bg-emerald-500' : 'bg-slate-400'}`} />
          {live ? 'Pembaruan otomatis · 15 detik' : 'Terputus · gunakan Muat ulang'}
        </span>
        <button type="button" onClick={() => void refresh()} disabled={editing || resyncing || busyId !== null} className="btn-secondary min-h-[44px] border-slate-500">Muat ulang</button>
        <button type="button" onClick={() => void handleResyncAll()} disabled={editing || resyncing || busyId !== null} className="btn-primary min-h-[44px]">{resyncing ? 'Menyinkronkan ulang…' : 'Sinkronkan ulang semua'}</button>
      </div>
      {(queue.failed > 0 || queue.pending > 0 || queue.deleting > 0) && (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span>{queue.failed} surat gagal sinkronisasi · {queue.pending} surat menunggu sinkronisasi.</span>
          {queue.deleting > 0 && <span className="font-medium">{queue.deleting} nomor menunggu pengosongan Sheets dan belum tersedia untuk digunakan kembali.</span>}
          <button type="button" onClick={() => void handleResyncAll()} disabled={editing || resyncing || busyId !== null} className="btn-secondary min-h-[44px] border-slate-500 sm:ml-auto">Coba lagi sekarang</button>
        </div>
      )}
      <DocumentsTab key={scope} documents={documents} loading={loading} search={search} setSearch={setSearch}
        statusFilter={statusFilter} setStatusFilter={setStatusFilter} page={page} setPage={setPage}
        sortBy={sortBy} setSortBy={(value) => { ++requestId.current; setPage(1); setSortBy(value); }}
        sortDirection={sortDirection} setSortDirection={(value) => { ++requestId.current; setPage(1); setSortDirection(value); }}
        totalPages={totalPages} total={total} busyId={busyId} actionsDisabled={resyncing || busyId !== null}
        onResyncOne={(id) => handleRowAction(id, false)} onDelete={(id) => handleRowAction(id, true)}
        onSaved={() => refreshRef.current()} onAuthLoss={handleAuthLoss} onEditingChange={setEditing} />
    </div>
  );
}
