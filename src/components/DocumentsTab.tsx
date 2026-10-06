'use client';

import { useState } from 'react';
import { SyncBadge } from './Badges';
import type { DocumentRow, SyncStatus } from '@/lib/supabase';

/**
 * Documents table: search, status filter, pagination, per-row re-sync, and
 * inline editing of title/metadata/ID.
 */
export function DocumentsTab({
  documents,
  loading,
  search,
  setSearch,
  statusFilter,
  setStatusFilter,
  page,
  setPage,
  totalPages,
  total,
  onResyncOne,
}: {
  documents: DocumentRow[];
  loading: boolean;
  search: string;
  setSearch: (v: string) => void;
  statusFilter: SyncStatus | 'all';
  setStatusFilter: (v: SyncStatus | 'all') => void;
  page: number;
  setPage: (v: number) => void;
  totalPages: number;
  total: number;
  onResyncOne: (id: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  return (
    <section className="card overflow-hidden">
      {/* ---- Toolbar ----------------------------------------------------- */}
      <div className="flex flex-wrap items-end gap-3 border-b border-slate-200 p-4">
        <div className="min-w-[16rem] flex-1">
          <label htmlFor="doc-search" className="label">
            Search
          </label>
          <input
            id="doc-search"
            type="search"
            placeholder="Title or numeric ID"
            className="input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div>
          <label htmlFor="doc-status" className="label">
            Sync status
          </label>
          <select
            id="doc-status"
            className="input"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as SyncStatus | 'all')}
          >
            <option value="all">All</option>
            <option value="synced">Synced</option>
            <option value="pending">Pending</option>
            <option value="failed">Failed</option>
          </select>
        </div>
      </div>

      {/* ---- Table -------------------------------------------------------- */}
      {loading ? (
        <p className="px-6 py-10 text-center text-sm text-slate-500">Loading...</p>
      ) : documents.length === 0 ? (
        <p className="px-6 py-10 text-center text-sm text-slate-500">
          No documents match these filters.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">ID</th>
                <th className="px-4 py-3 font-medium">Title</th>
                <th className="px-4 py-3 font-medium">Metadata</th>
                <th className="px-4 py-3 font-medium">Sync</th>
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {documents.map((doc) =>
                editing === doc.id ? (
                  <EditRow
                    key={doc.id}
                    doc={doc}
                    onCancel={() => setEditing(null)}
                    onSaved={() => setEditing(null)}
                  />
                ) : (
                  <tr key={doc.id} className="hover:bg-slate-50">
                    <td className="whitespace-nowrap px-4 py-3 font-mono font-semibold text-navy-800">
                      {doc.id}
                    </td>
                    <td className="px-4 py-3 font-medium text-slate-900">{doc.title}</td>
                    <td className="max-w-xs px-4 py-3">
                      <details className="group">
                        <summary className="cursor-pointer break-all text-xs text-slate-500 hover:text-navy-700">
                          {Object.keys(doc.metadata ?? {}).length > 0
                            ? `${Object.keys(doc.metadata).length} field(s)`
                            : '--'}
                        </summary>
                        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded bg-slate-50 p-2 text-[0.7rem] text-slate-600">
                          {JSON.stringify(doc.metadata ?? {}, null, 2)}
                        </pre>
                      </details>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <SyncBadge status={doc.sync_status} />
                      {doc.sync_attempts > 0 && (
                        <p className="mt-1 text-xs text-slate-400">
                          {doc.sync_attempts} attempt{doc.sync_attempts === 1 ? '' : 's'}
                        </p>
                      )}
                      {doc.last_sync_error && (
                        <p
                          className="mt-1 max-w-[14rem] truncate text-xs text-red-600"
                          title={doc.last_sync_error}
                        >
                          {doc.last_sync_error}
                        </p>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-500">
                      {new Date(doc.created_at).toLocaleString()}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => setEditing(doc.id)}
                        className="btn-secondary btn-sm"
                      >
                        Edit
                      </button>{' '}
                      <button
                        type="button"
                        onClick={async () => {
                          setBusyId(doc.id);
                          await onResyncOne(doc.id);
                          setBusyId(null);
                        }}
                        disabled={busyId === doc.id}
                        className="btn-secondary btn-sm"
                      >
                        {busyId === doc.id ? '...' : 'Re-sync'}
                      </button>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ---- Pagination --------------------------------------------------- */}
      <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-sm">
        <p className="text-slate-600">
          Page <span className="font-medium">{page}</span> of{' '}
          <span className="font-medium">{totalPages}</span> ({total} total)
        </p>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setPage(1)}
            disabled={page <= 1}
            className="btn-secondary btn-sm"
          >
            First
          </button>
          <button
            type="button"
            onClick={() => setPage(Math.max(1, page - 1))}
            disabled={page <= 1}
            className="btn-secondary btn-sm"
          >
            Prev
          </button>
          <button
            type="button"
            onClick={() => setPage(Math.min(totalPages, page + 1))}
            disabled={page >= totalPages}
            className="btn-secondary btn-sm"
          >
            Next
          </button>
          <button
            type="button"
            onClick={() => setPage(totalPages)}
            disabled={page >= totalPages}
            className="btn-secondary btn-sm"
          >
            Last
          </button>
        </div>
      </div>
    </section>
  );
}

/** Inline edit form for one document row. */
function EditRow({
  doc,
  onCancel,
  onSaved,
}: {
  doc: DocumentRow;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(doc.title);
  const [newId, setNewId] = useState(String(doc.id));
  const [metadataText, setMetadataText] = useState(
    JSON.stringify(doc.metadata ?? {}, null, 2),
  );

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);

    // Parse metadata client-side so a JSON syntax error is reported instantly
    // instead of after a round trip.
    let metadata: unknown;
    try {
      metadata = JSON.parse(metadataText || '{}');
    } catch {
      setError('Metadata must be valid JSON.');
      return;
    }

    const parsedId = Number(newId);
    if (!Number.isInteger(parsedId) || parsedId <= 0) {
      setError('Document ID must be a positive integer.');
      return;
    }

    setSaving(true);

    try {
      const res = await fetch('/api/documents/update', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // Always send the ID field. The API treats "unchanged" as a no-op and
        // only performs the re-key when parsedId actually differs from doc.id.
        body: JSON.stringify({
          id: parsedId,
          title: title.trim(),
          metadata,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? 'Update failed.');
        return;
      }

      onSaved();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr className="bg-navy-50/50">
      <td colSpan={6} className="px-4 py-4">
        {error && (
          <p role="alert" className="mb-3 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800">
            {error}
          </p>
        )}

        <div className="grid gap-3 lg:grid-cols-3">
          <div>
            <label className="label text-xs" htmlFor={`title-${doc.id}`}>
              Title
            </label>
            <input
              id={`title-${doc.id}`}
              className="input"
              value={title}
              maxLength={300}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div>
            <label className="label text-xs" htmlFor={`id-${doc.id}`}>
              Document ID
            </label>
            <input
              id={`id-${doc.id}`}
              className="input font-mono"
              type="number"
              value={newId}
              onChange={(e) => setNewId(e.target.value)}
            />
            <p className="mt-1 text-xs text-slate-500">
              Must exceed the highest issued ID.
            </p>
          </div>

          <div>
            <label className="label text-xs" htmlFor={`meta-${doc.id}`}>
              Metadata (JSON)
            </label>
            <textarea
              id={`meta-${doc.id}`}
              className="input font-mono text-xs"
              rows={4}
              value={metadataText}
              onChange={(e) => setMetadataText(e.target.value)}
            />
          </div>
        </div>

        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="btn-primary btn-sm"
          >
            {saving ? 'Saving...' : 'Save changes'}
          </button>
          <button type="button" onClick={onCancel} className="btn-secondary btn-sm">
            Cancel
          </button>
        </div>
      </td>
    </tr>
  );
}
