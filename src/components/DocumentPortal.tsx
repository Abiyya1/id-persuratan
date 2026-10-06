'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { SyncBadge } from './Badges';
import type { DocumentRow, SyncStatus } from '@/lib/supabase';

/**
 * Dashboard 1 body: the create form plus the submitter's own document list.
 *
 * Documents are fetched client-side against createdBy=<own id>. The server
 * stamps created_by from the session, so a user cannot file a document under
 * someone else's name by tampering with the request.
 */
export function DocumentPortal({
  userId,
  username,
  initialDocuments,
}: {
  userId: string;
  username: string;
  initialDocuments: DocumentRow[];
}) {
  const router = useRouter();

  const [title, setTitle] = useState('');
  const [metadataKey, setMetadataKey] = useState('');
  const [metadataValue, setMetadataValue] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{
    kind: 'success' | 'error';
    message: string;
    warning?: string | null;
  } | null>(null);

  const [documents, setDocuments] = useState<DocumentRow[]>(initialDocuments);
  const [loading, setLoading] = useState(true);

  const loadDocuments = useCallback(async () => {
    try {
      const res = await fetch(`/api/documents/list?createdBy=${userId}&pageSize=25`);
      if (!res.ok) return;
      const data = await res.json();
      setDocuments(data.documents ?? []);
    } catch {
      // A failed refresh should not wipe the table the user is looking at.
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

  // Poll while this tab is focused. A new document's sync status changes
  // server-side (pending -> synced/failed), and without this the badge would
  // stay frozen at whatever it was when the row was created.
  useEffect(() => {
    function onVisibility() {
      if (document.visibilityState === 'visible') void loadDocuments();
    }

    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void loadDocuments();
    }, 15_000);

    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [loadDocuments]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFeedback(null);

    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setFeedback({ kind: 'error', message: 'Title is required.' });
      return;
    }

    // Metadata is free-form; only include the pair when a key was given, so a
    // stray value in the second box does not create a blank key.
    const metadata: Record<string, string> = {};
    const cleanKey = metadataKey.trim();
    if (cleanKey) metadata[cleanKey] = metadataValue.trim();

    setSubmitting(true);

    try {
      const res = await fetch('/api/documents/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: cleanTitle, metadata }),
      });

      const data = await res.json();

      if (!res.ok) {
        setFeedback({ kind: 'error', message: data.error ?? 'Could not create document.' });
        return;
      }

      setFeedback({
        kind: 'success',
        message: data.message,
        warning: data.syncWarning,
      });

      // Clear the form so the next submission starts clean. The ID is already
      // allocated server-side -- clearing does not release it.
      setTitle('');
      setMetadataKey('');
      setMetadataValue('');

      await loadDocuments();
      router.refresh();
    } catch {
      setFeedback({ kind: 'error', message: 'Could not reach the server.' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* ---- Create form ------------------------------------------------- */}
      <section className="card p-6">
        <h2 className="text-lg font-semibold text-navy-900">New document</h2>

        {feedback && (
          <div
            role="status"
            className={`mt-4 rounded-md border p-3 text-sm ${
              feedback.kind === 'success'
                ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
                : 'border-red-300 bg-red-50 text-red-800'
            }`}
          >
            <p className="font-medium">{feedback.message}</p>
            {feedback.warning && (
              <p className="mt-1 text-xs opacity-80">Sheets said: {feedback.warning}</p>
            )}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <label htmlFor="title" className="label">
              Title <span className="text-red-500">*</span>
            </label>
            <input
              id="title"
              type="text"
              required
              maxLength={300}
              autoFocus
              placeholder="e.g. Surat Izin Usaha"
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="meta-key" className="label">
                Metadata key <span className="font-normal text-slate-400">(optional)</span>
              </label>
              <input
                id="meta-key"
                type="text"
                maxLength={100}
                placeholder="e.g. Applicant"
                className="input"
                value={metadataKey}
                onChange={(e) => setMetadataKey(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="meta-value" className="label">
                Metadata value
              </label>
              <input
                id="meta-value"
                type="text"
                maxLength={500}
                placeholder="e.g. Budi Santoso"
                className="input"
                value={metadataValue}
                onChange={(e) => setMetadataValue(e.target.value)}
              />
            </div>
          </div>

          <button type="submit" disabled={submitting} className="btn-primary">
            {submitting ? 'Generating ID...' : 'Generate document ID'}
          </button>
        </form>
      </section>

      {/* ---- Own documents ------------------------------------------------ */}
      <section className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h2 className="text-lg font-semibold text-navy-900">
            Submitted by {username}
          </h2>
          <button
            type="button"
            onClick={() => void loadDocuments()}
            className="btn-secondary btn-sm"
          >
            Refresh
          </button>
        </div>

        {loading ? (
          <p className="px-6 py-8 text-center text-sm text-slate-500">Loading...</p>
        ) : documents.length === 0 ? (
          <p className="px-6 py-8 text-center text-sm text-slate-500">
            You have not submitted any documents yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-6 py-3 font-medium">ID</th>
                  <th className="px-6 py-3 font-medium">Title</th>
                  <th className="px-6 py-3 font-medium">Metadata</th>
                  <th className="px-6 py-3 font-medium">Sync</th>
                  <th className="px-6 py-3 font-medium">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {documents.map((doc) => (
                  <tr key={doc.id} className="hover:bg-slate-50">
                    <td className="whitespace-nowrap px-6 py-3 font-mono font-semibold text-navy-800">
                      {doc.id}
                    </td>
                    <td className="px-6 py-3">{doc.title}</td>
                    <td className="max-w-xs truncate px-6 py-3 text-xs text-slate-500">
                      {Object.keys(doc.metadata ?? {}).length > 0
                        ? JSON.stringify(doc.metadata)
                        : '--'}
                    </td>
                    <td className="whitespace-nowrap px-6 py-3">
                      <SyncBadge status={doc.sync_status as SyncStatus} />
                      {doc.sync_status === 'failed' && doc.last_sync_error && (
                        <p
                          className="mt-1 max-w-[16rem] truncate text-xs text-red-600"
                          title={doc.last_sync_error}
                        >
                          {doc.last_sync_error}
                        </p>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-6 py-3 text-xs text-slate-500">
                      {new Date(doc.created_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
