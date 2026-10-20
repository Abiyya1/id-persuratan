'use client';

import { useState, type FormEvent, type ReactNode, type CSSProperties } from 'react';
import { SyncBadge } from './Badges';
import type { DocumentRow, SyncStatus } from '@/lib/supabase';
import { ClassificationInput, useRegisterOptions } from './ClassificationInput';
import { KET_OPTIONS } from '@/lib/letter-fields';
import { REGISTER_FILLED_NUMBER_COLOR } from '@/lib/register-sheet';
import type { DocumentSortField, DocumentSortDirection } from '@/lib/document-sort';
import { DocumentActionIcon } from './DocumentActionIcon';

/**
 * Documents table: search, status filter, pagination, per-row re-sync, and
 * structured editing without changing the official number or date.
 */
export function DocumentsTab({
  documents,
  loading,
  search,
  setSearch,
  statusFilter,
  setStatusFilter,
  sortBy,
  setSortBy,
  sortDirection,
  setSortDirection,
  page,
  setPage,
  totalPages,
  total,
  onResyncOne,
  onDelete,
  onSaved,
  onAuthLoss,
  busyId,
  actionsDisabled,
  onEditingChange,
}: {
  documents: DocumentRow[];
  loading: boolean;
  search: string;
  setSearch: (v: string) => void;
  statusFilter: SyncStatus | 'all';
  setStatusFilter: (v: SyncStatus | 'all') => void;
  sortBy: DocumentSortField;
  setSortBy: (value: DocumentSortField) => void;
  sortDirection: DocumentSortDirection;
  setSortDirection: (value: DocumentSortDirection) => void;
  page: number;
  setPage: (v: number) => void;
  totalPages: number;
  total: number;
  onResyncOne: (id: number) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onSaved: () => void | Promise<void>;
  onAuthLoss: (status: number) => boolean;
  busyId: number | null;
  actionsDisabled: boolean;
  onEditingChange: (editing: boolean) => void;
}) {
  const [editing, setEditing] = useState<number | null>(null);

  return (
    <section className="card min-w-0" aria-label="Daftar surat">
      <div className="grid gap-3 border-b border-slate-200 p-4 sm:grid-cols-2 xl:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]">
        <div className="min-w-0">
          <label htmlFor="doc-search" className="label">Cari surat</label>
          <input
            id="doc-search"
            type="search"
            placeholder="Hal atau Nomor Surat"
            className="input min-h-[44px] border-slate-500 placeholder:text-slate-500"
            value={search}
            disabled={editing !== null || actionsDisabled}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="min-w-0">
          <label htmlFor="doc-status" className="label">Status sinkronisasi</label>
          <select
            id="doc-status"
            className="input min-h-[44px] border-slate-500"
            value={statusFilter}
            disabled={editing !== null || actionsDisabled}
            onChange={(e) => setStatusFilter(e.target.value as SyncStatus | 'all')}
          >
            <option value="all">Semua</option>
            <option value="synced">Tersinkron</option>
            <option value="pending">Menunggu</option>
            <option value="failed">Gagal</option>
          </select>
        </div>
        <div className="min-w-0">
          <label htmlFor="doc-sort-by" className="label">Urutkan berdasarkan</label>
          <select
            id="doc-sort-by"
            className="input min-h-[44px] border-slate-500"
            value={sortBy}
            disabled={editing !== null || actionsDisabled}
            onChange={(e) => setSortBy(e.target.value as DocumentSortField)}
          >
            <option value="number">Nomor Surat</option>
            <option value="created">Tanggal dibuat</option>
            <option value="date">Tanggal</option>
          </select>
        </div>
        <div className="min-w-0">
          <label htmlFor="doc-sort-direction" className="label">Arah urutan</label>
          <select
            id="doc-sort-direction"
            className="input min-h-[44px] border-slate-500"
            value={sortDirection}
            disabled={editing !== null || actionsDisabled}
            onChange={(e) => setSortDirection(e.target.value as DocumentSortDirection)}
          >
            <option value="asc">ASC (menaik)</option>
            <option value="desc">DESC (menurun)</option>
          </select>
        </div>
      </div>

      {loading ? (
        <p role="status" className="px-6 py-10 text-center text-sm text-slate-600">Memuat daftar surat…</p>
      ) : documents.length === 0 ? (
        <p className="px-6 py-10 text-center text-sm text-slate-600">
          Tidak ada surat yang sesuai dengan filter ini.
        </p>
      ) : (
        <table role="table" aria-label="Surat dan status sinkronisasi" className="block w-full table-fixed text-sm xl:table">
          <colgroup className="hidden xl:table-column-group">
            <col style={{ width: '8%' }} />
            <col style={{ width: '12%' }} />
            <col style={{ width: '9%' }} />
            <col style={{ width: '6%' }} />
            <col style={{ width: '8%' }} />
            <col style={{ width: '14%' }} />
            <col style={{ width: '12%' }} />
            <col style={{ width: '9%' }} />
            <col style={{ width: '10%' }} />
            <col style={{ width: '12%' }} />
          </colgroup>
          <thead className="hidden bg-slate-50 text-left text-xs text-slate-600 xl:table-header-group">
            <tr role="row">
              {['Nomor Surat', 'Tanggal dibuat', 'Tanggal', 'KD Surat', 'KD Satker', 'Hal', 'Tujuan Surat', 'Ket', 'Sinkronisasi', 'Tindakan'].map((label) => (
                <th key={label} scope="col" className="px-3 py-3 font-medium [overflow-wrap:anywhere]">{label}</th>
              ))}
            </tr>
          </thead>
          <tbody className="block divide-y divide-slate-200 xl:table-row-group">
            {documents.map((doc) =>
              editing === doc.id ? (
                <EditRow
                  key={doc.id}
                  doc={doc}
                  onCancel={() => { setEditing(null); onEditingChange(false); }}
                  onSaved={async () => { setEditing(null); onEditingChange(false); await onSaved(); }}
                  onAuthLoss={onAuthLoss}
                />
              ) : (
                <tr key={doc.id} role="row" data-document-id={doc.id} className="grid grid-cols-1 p-3 hover:bg-slate-50 sm:grid-cols-2 xl:table-row xl:p-0">
                  <DocumentCell label="Nomor Surat" className="font-mono font-semibold text-navy-800" style={{ backgroundColor: REGISTER_FILLED_NUMBER_COLOR }}>
                    {doc.surat_number}
                  </DocumentCell>
                  <DocumentCell label="Tanggal dibuat"><CreatedAt value={doc.created_at} /></DocumentCell>
                  <DocumentCell label="Tanggal">{doc.letter_date ?? 'Arsip tanpa tanggal'}</DocumentCell>
                  <DocumentCell label="KD Surat">{String(doc.metadata?.kdSurat ?? 'Tidak tersedia')}</DocumentCell>
                  <DocumentCell label="KD Satker">{String(doc.metadata?.kdSatker ?? 'Tidak tersedia')}</DocumentCell>
                  <DocumentCell label="Hal" className="font-medium text-slate-900">
                    {doc.title}
                    {!doc.letter_date && Object.keys(doc.metadata ?? {}).length > 0 && (
                      <details className="mt-1 text-xs font-normal text-slate-600">
                        <summary className="min-h-[44px] cursor-pointer py-3">Data arsip</summary>
                        <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-slate-50 p-2">{JSON.stringify(doc.metadata, null, 2)}</pre>
                      </details>
                    )}
                  </DocumentCell>
                  <DocumentCell label="Tujuan Surat">{String(doc.metadata?.tujuanSurat ?? 'Tidak tersedia')}</DocumentCell>
                  <DocumentCell label="Ket">{String(doc.metadata?.ket ?? 'Tidak tersedia')}</DocumentCell>
                  <DocumentCell label="Sinkronisasi">
                    <SyncBadge status={doc.sync_status} />
                    {doc.sync_attempts > 0 && (
                      <p className="mt-1 text-xs text-slate-600">{doc.sync_attempts} percobaan</p>
                    )}
                    {doc.last_sync_error && <p className="mt-1 text-xs text-red-700">{doc.last_sync_error}</p>}
                  </DocumentCell>
                  <DocumentCell label="Tindakan">
                    <div className="flex flex-wrap gap-1" aria-busy={busyId === doc.id}>
                      <button
                        type="button"
                        onClick={() => { setEditing(doc.id); onEditingChange(true); }}
                        disabled={!doc.letter_date || actionsDisabled || editing !== null}
                        aria-label={`Sunting surat ${doc.surat_number}`}
                        title={!doc.letter_date ? 'Data lama, hanya baca' : 'Sunting surat'}
                        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-navy-700 bg-white text-navy-700 hover:bg-navy-50 focus-visible:ring-2 focus-visible:ring-navy-700 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <DocumentActionIcon action="edit" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void onResyncOne(doc.id)}
                        disabled={!doc.letter_date || actionsDisabled || editing !== null}
                        aria-label={`Sinkronkan ulang surat ${doc.surat_number}`}
                        title={!doc.letter_date ? 'Data lama, hanya baca' : 'Sinkronkan ulang surat'}
                        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-emerald-700 bg-white text-emerald-700 hover:bg-emerald-50 focus-visible:ring-2 focus-visible:ring-navy-700 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <DocumentActionIcon action="resync" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void onDelete(doc.id)}
                        disabled={!doc.letter_date || actionsDisabled || editing !== null}
                        aria-label={`Hapus surat ${doc.surat_number}`}
                        title={!doc.letter_date ? 'Data lama, hanya baca' : 'Kosongkan isi surat dan lepaskan nomor setelah Sheets dikosongkan'}
                        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-red-700 bg-white text-red-700 hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-navy-700 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <DocumentActionIcon action="delete" />
                      </button>
                    </div>
                    {busyId === doc.id && <p role="status" className="mt-1 text-xs text-slate-600">Memproses surat…</p>}
                    {!doc.letter_date && <p className="mt-1 text-xs text-slate-600">Data lama, hanya baca</p>}
                  </DocumentCell>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-sm">
        <p className="text-slate-600">
          Halaman <span className="font-medium">{page}</span> dari{' '}
          <span className="font-medium">{totalPages}</span> ({total} surat)
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setPage(1)} disabled={page <= 1 || editing !== null || actionsDisabled} className="btn-secondary min-h-[44px] border-slate-500">Pertama</button>
          <button type="button" onClick={() => setPage(Math.max(1, page - 1))} disabled={page <= 1 || editing !== null || actionsDisabled} className="btn-secondary min-h-[44px] border-slate-500">Sebelumnya</button>
          <button type="button" onClick={() => setPage(Math.min(totalPages, page + 1))} disabled={page >= totalPages || editing !== null || actionsDisabled} className="btn-secondary min-h-[44px] border-slate-500">Berikutnya</button>
          <button type="button" onClick={() => setPage(totalPages)} disabled={page >= totalPages || editing !== null || actionsDisabled} className="btn-secondary min-h-[44px] border-slate-500">Terakhir</button>
        </div>
      </div>
    </section>
  );
}

function DocumentCell({ label, children, className = '', style }: {
  label: string;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <td role="cell" className={`block min-w-0 px-3 py-3 align-top [overflow-wrap:anywhere] xl:table-cell ${className}`} style={style}>
      <span className="mb-1 block font-sans text-xs font-medium text-slate-600 xl:hidden">{label}</span>
      {children}
    </td>
  );
}

const createdDateFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
});
const createdTimeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function CreatedAt({ value }: { value: string | null }) {
  const instant = value ? new Date(value) : null;
  if (!instant || Number.isNaN(instant.getTime())) return <span>Tidak tersedia</span>;
  return (
    <time dateTime={value ?? undefined}>
      <span className="block">{createdDateFormatter.format(instant)}</span>
      <span className="block">{createdTimeFormatter.format(instant)} WIB</span>
    </time>
  );
}

/** Inline edit form for one document row. */
function EditRow({ doc, onCancel, onSaved, onAuthLoss }: {
  doc: DocumentRow;
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
  onAuthLoss: (status: number) => boolean;
}) {
  const { options, error: optionsError, loading: optionsLoading, reload } = useRegisterOptions();
  const [title, setTitle] = useState(doc.title);
  const [kdSurat, setKdSurat] = useState(String(doc.metadata?.kdSurat ?? ''));
  const [kdSatker, setKdSatker] = useState(String(doc.metadata?.kdSatker ?? ''));
  const [tujuanSurat, setTujuanSurat] = useState(String(doc.metadata?.tujuanSurat ?? ''));
  const [ket, setKet] = useState(String(doc.metadata?.ket ?? ''));
  const ketOptions = doc.letter_date === options?.today ? KET_OPTIONS : ['MANUAL'] as const;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setWarning(null);
    if (!title.trim()) {
      setError('Hal wajib diisi.');
      return;
    }
    if (!tujuanSurat.trim()) {
      setError('Tujuan Surat wajib diisi.');
      return;
    }
    if (!options || optionsError || optionsLoading ||
        !options.classifications.some((item) => item.code === kdSurat) ||
        !options.satkers.some((item) => item.name === kdSatker) ||
        !ketOptions.some((item) => item === ket)) {
      setError('Pilih KD Surat, KD Satker, dan Ket yang terdaftar. Tanggal selain hari ini (WIB) hanya dapat menggunakan MANUAL.');
      return;
    }
    setSaving(true);
    try {
      const response = await fetch('/api/documents/update', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: doc.id,
          title: title.trim(),
          metadata: { kdSurat, kdSatker, tujuanSurat: tujuanSurat.trim(), ket },
        }),
      });
      if (onAuthLoss(response.status)) return;
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? 'Tidak dapat menyimpan perubahan.');
        return;
      }
      if (data.syncWarning) {
        setWarning(`Perubahan tersimpan. Sinkronisasi Sheets: ${data.syncWarning}`);
        return;
      }
      await onSaved();
    } catch {
      setError('Tidak dapat menghubungi server. Muat ulang daftar untuk memeriksa perubahan.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr role="row" className="block bg-navy-50/50 xl:table-row">
      <td role="cell" colSpan={10} className="block min-w-0 px-4 py-4 [overflow-wrap:anywhere] [&_button]:min-h-[44px] [&_.input]:min-h-[44px] [&_.input]:border-slate-500 [&_.input]:placeholder:text-slate-500 [&_[role=option]]:min-h-[44px] xl:table-cell">
        {error && <p role="alert" className="mb-3 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800">{error}</p>}
        {warning && <div role="status" className="mb-3 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900"><p>{warning}</p><button type="button" className="btn-secondary btn-sm mt-2" onClick={() => void onSaved()}>Tutup dan muat ulang</button></div>}
        {optionsError && <div role="alert" className="mb-3 text-sm text-red-600"><p>{optionsError}</p><button type="button" className="btn-secondary btn-sm mt-2" disabled={optionsLoading} onClick={() => void reload()}>Muat ulang katalog</button></div>}
        {optionsLoading && <p role="status" className="mb-3 text-sm text-slate-500">Memuat klasifikasi dan satker…</p>}
        <form onSubmit={save} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <div className="min-w-0"><p className="label text-xs">Nomor Surat (tetap)</p><p id={`number-${doc.id}`} className="rounded-md border border-slate-500 p-3 font-mono [overflow-wrap:anywhere]" style={{ backgroundColor: REGISTER_FILLED_NUMBER_COLOR }}>{doc.surat_number}</p></div>
            <div className="min-w-0"><p className="label text-xs">Tanggal dibuat (tetap)</p><CreatedAt value={doc.created_at} /></div>
            <div className="min-w-0"><label className="label text-xs" htmlFor={`date-${doc.id}`}>Tanggal surat (tetap)</label><input id={`date-${doc.id}`} className="input min-h-[44px] border-slate-500" value={doc.letter_date ?? 'Arsip tanpa tanggal'} readOnly /></div>
          </div>
          <fieldset disabled={saving || optionsLoading || !options || !!optionsError} className="min-w-0 space-y-3 [&_div]:min-w-0">
            <div><label className="label text-xs" htmlFor={`hal-${doc.id}`}>Hal</label><textarea id={`hal-${doc.id}`} className="input resize-y" rows={3} required value={title} maxLength={300} onChange={(event) => setTitle(event.target.value)} /></div>
              <div className="grid gap-3 sm:grid-cols-2">
                <ClassificationInput id={`kd-surat-${doc.id}`} options={options?.classifications ?? []} value={kdSurat} onChange={setKdSurat} disabled={saving || optionsLoading || !options || !!optionsError} />
                <div><label className="label" htmlFor={`satker-${doc.id}`}>KD Satker</label><select id={`satker-${doc.id}`} className="input" required value={kdSatker} onChange={(event) => setKdSatker(event.target.value)}><option value="">Pilih satker</option>{options?.satkers.map((satker) => <option key={satker.id} value={satker.name}>{satker.name}</option>)}</select></div>
                <div><label className="label" htmlFor={`tujuan-${doc.id}`}>Tujuan Surat <span className="text-red-500">*</span></label><textarea id={`tujuan-${doc.id}`} className="input resize-y" rows={3} required maxLength={500} value={tujuanSurat} onChange={(event) => setTujuanSurat(event.target.value)} /></div>
                <div><label className="label" htmlFor={`ket-${doc.id}`}>Ket</label><select id={`ket-${doc.id}`} className="input" required value={ket} onChange={(event) => setKet(event.target.value)}><option value="">Pilih Ket</option>{ketOptions.map((item) => <option key={item} value={item}>{item}</option>)}</select>{doc.letter_date !== options?.today && <p className="mt-1 text-xs text-slate-500">Tanggal selain hari ini hanya dapat menggunakan MANUAL.</p>}</div>
              </div>
            <div className="flex gap-2"><button type="submit" disabled={saving || !!warning} className="btn-primary btn-sm">{saving ? 'Menyimpan…' : 'Simpan perubahan'}</button></div>
          </fieldset>
          <button type="button" disabled={saving} onClick={onCancel} className="btn-secondary btn-sm">Batal</button>
        </form>
      </td>
    </tr>
  );
}
