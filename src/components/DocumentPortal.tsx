'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ClassificationInput, useRegisterOptions } from './ClassificationInput';
import { KET_OPTIONS, MONTH_NAMES } from '@/lib/letter-fields';

export function DocumentPortal({ canManage }: { canManage: boolean }) {
  const router = useRouter();
  const { options, error: optionsError, loading: optionsLoading, reload: reloadOptions } = useRegisterOptions();
  const [kdSurat, setKdSurat] = useState('');
  const [kdSatker, setKdSatker] = useState('');
  const [hal, setHal] = useState('');
  const [tujuanSurat, setTujuanSurat] = useState('');
  const [ket, setKet] = useState('');
  const [date, setDate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [fullDate, setFullDate] = useState<string | null>(null);
  const [emergencyConfirmed, setEmergencyConfirmed] = useState(false);
  const [emergencyReason, setEmergencyReason] = useState('');
  const [satkerName, setSatkerName] = useState('');
  const [addingSatker, setAddingSatker] = useState(false);
  const [catalogFeedback, setCatalogFeedback] = useState<{ error: boolean; message: string } | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; message: string; warning?: string | null } | null>(null);
  const month = date ? Number(date.slice(5, 7)) : '';
  const emergencyAvailable = canManage && fullDate === date;
  const ketOptions = date === options?.today ? KET_OPTIONS : ['MANUAL'] as const;

  useEffect(() => {
    if (!options) return;
    setDate((current) => current || options.today);
  }, [options]);

  function changeDate(next: string) {
    setDate(next);
    setKet('');
    setFullDate(null);
    setEmergencyConfirmed(false);
    setEmergencyReason('');
    setFeedback(null);
  }

  function changeMonth(next: number) {
    const day = Math.min(Number(date.slice(8, 10)) || 1, new Date(Date.UTC(2026, next, 0)).getUTCDate());
    changeDate(`2026-${String(next).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  }


  async function addSatker() {
    setCatalogFeedback(null);
    if (!satkerName.trim()) {
      setCatalogFeedback({ error: true, message: 'Nama satker wajib diisi.' });
      return;
    }
    setAddingSatker(true);
    try {
      const response = await fetch('/api/satkers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: satkerName.trim() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Tidak dapat menambah satker.');
      setSatkerName('');
      const refreshed = await reloadOptions();
      setCatalogFeedback({ error: !refreshed, message: refreshed ? 'Satker ditambahkan dan katalog diperbarui.' : 'Satker ditambahkan, tetapi katalog gagal dimuat ulang. Coba muat ulang katalog.' });
    } catch (cause) {
      setCatalogFeedback({ error: true, message: cause instanceof Error ? cause.message : 'Tidak dapat menghubungi server.' });
    } finally {
      setAddingSatker(false);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFeedback(null);
    if (!options || optionsError || optionsLoading || !options.classifications.some((item) => item.code === kdSurat) || !options.satkers.some((item) => item.name === kdSatker)) {
      setFeedback({ kind: 'error', message: 'Pilih KD Surat dan KD Satker yang terdaftar dari katalog yang berhasil dimuat.' });
      return;
    }
    if (!/^2026-\d{2}-\d{2}$/.test(date) || !hal.trim()) {
      setFeedback({ kind: 'error', message: 'Isi Perihal Surat dan pilih tanggal tahun 2026. Tahun lain belum didukung.' });
      return;
    }
    if (!tujuanSurat.trim()) {
      setFeedback({ kind: 'error', message: 'Tujuan Surat wajib diisi.' });
      return;
    }
    if (!ketOptions.some((item) => item === ket)) {
      setFeedback({ kind: 'error', message: date === options.today ? 'Pilih keterangan surat.' : 'Untuk tanggal selain hari ini (WIB), pilih Keterangan MANUAL.' });
      return;
    }
    const emergency = emergencyAvailable && emergencyConfirmed;
    if (emergencyAvailable && !emergency) {
      setFeedback({ kind: 'error', message: 'Konfirmasikan penggunaan nomor darurat atau pilih tanggal lain.' });
      return;
    }
    if (emergency && !emergencyReason.trim()) {
      setFeedback({ kind: 'error', message: 'Alasan nomor darurat wajib diisi.' });
      return;
    }
    setSubmitting(true);
    try {
      const response = await fetch('/api/documents/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kdSurat, kdSatker, hal: hal.trim(), tujuanSurat: tujuanSurat.trim(), ket, date, month, ...(emergency ? { emergency: true, emergencyReason: emergencyReason.trim() } : {}) }),
      });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 409 && data.code === 'DAY_FULL') {
          setFullDate(date);
          setEmergencyConfirmed(false);
          setFeedback({ kind: 'error', message: canManage ? 'Slot tanggal ini habis. Nomor darurat hanya dapat dibuat setelah konfirmasi dan pengisian alasan di bawah.' : 'Slot tanggal ini habis. Hubungi admin untuk permintaan nomor darurat; nomor tidak dialokasikan otomatis.' });
        } else {
          setFeedback({ kind: 'error', message: data.error ?? 'Tidak dapat mendaftarkan surat.' });
        }
        return;
      }
      const allocatedNumber = String(data.document.surat_number);
      setFeedback({ kind: 'success', message: `Surat terdaftar dengan Nomor Surat ${allocatedNumber}. ${data.message ?? ''}`, warning: data.syncWarning });
      setHal('');
      setTujuanSurat('');
      setKdSatker('');
      setKet('');
      setFullDate(null);
      setEmergencyConfirmed(false);
      setEmergencyReason('');
      router.refresh();
    } catch {
      setFeedback({ kind: 'error', message: 'Tidak dapat menghubungi server. Periksa daftar surat sebelum mencoba kembali untuk menghindari pengajuan ganda.' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="card p-6">
        <h2 className="text-lg font-semibold text-navy-900">Buat Nomor Surat</h2>
        <p className="mt-1 text-sm text-slate-500">Register bulanan 2026 · tanggal mengikuti WIB · nomor ditetapkan saat surat disimpan.</p>
        {optionsError && <div role="alert" className="mt-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800"><p>{optionsError}</p><button type="button" className="btn-secondary btn-sm mt-2" disabled={optionsLoading} onClick={() => void reloadOptions()}>Muat ulang katalog</button></div>}
        {optionsLoading && <p role="status" className="mt-3 text-sm text-slate-500">Memuat klasifikasi, satker, dan tanggal server…</p>}
        {feedback && <div role={feedback.kind === 'error' ? 'alert' : 'status'} className={`mt-4 rounded-md border p-3 text-sm ${feedback.kind === 'success' ? 'border-emerald-300 bg-emerald-50 text-emerald-900' : 'border-red-300 bg-red-50 text-red-800'}`}><p className="font-medium">{feedback.message}</p>{feedback.warning && <p className="mt-1 text-xs">Sinkronisasi Sheets: {feedback.warning}</p>}</div>}
        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <fieldset disabled={submitting || optionsLoading || !options || !!optionsError} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <ClassificationInput id="create-kd-surat" options={options?.classifications ?? []} value={kdSurat} onChange={setKdSurat} disabled={submitting || optionsLoading || !options || !!optionsError} />
              <div><label htmlFor="create-satker" className="label">KD Satker <span className="text-red-500">*</span></label><select id="create-satker" className="input" required value={kdSatker} onChange={(event) => setKdSatker(event.target.value)}><option value="">Pilih satker</option>{options?.satkers.map((satker) => <option key={satker.id} value={satker.name}>{satker.name}</option>)}</select></div>
              <div><label htmlFor="create-ket" className="label">Keterangan <span className="text-red-500">*</span></label><select id="create-ket" className="input" required value={ket} onChange={(event) => setKet(event.target.value)}><option value="">Pilih Keterangan</option>{ketOptions.map((item) => <option key={item} value={item}>{item}</option>)}</select>{date && date !== options?.today && <p className="mt-1 text-xs text-slate-500">Tanggal selain hari ini hanya dapat menggunakan MANUAL.</p>}</div>
            </div>
            <div><label htmlFor="create-hal" className="label">Perihal Surat <span className="text-red-500">*</span></label><input id="create-hal" className="input" required maxLength={300} value={hal} onChange={(event) => setHal(event.target.value)} /></div>
            <div><label htmlFor="create-tujuan" className="label">Tujuan Surat <span className="text-red-500">*</span></label><input id="create-tujuan" className="input" required maxLength={500} value={tujuanSurat} onChange={(event) => setTujuanSurat(event.target.value)} /></div>
            <div className="grid items-end gap-4 sm:grid-cols-3">
              <div><label htmlFor="create-month" className="label">Bulan</label><select id="create-month" className="input" value={month} required onChange={(event) => changeMonth(Number(event.target.value))}><option value="" disabled>Pilih bulan</option>{MONTH_NAMES.map((name, index) => <option key={name} value={index + 1}>{name}</option>)}</select></div>
              <div><label htmlFor="create-date" className="label">Tanggal surat (WIB)</label><input id="create-date" className="input" type="date" min="2026-01-01" max="2026-12-31" required value={date} onChange={(event) => changeDate(event.target.value)} /></div>
              <div><button type="button" className="btn-secondary" onClick={async () => { const current = await reloadOptions(); if (current) changeDate(current.today); }}>HARI INI</button></div>
            </div>
            {/* <p className="text-xs text-slate-500">Tahun selain 2026 belum didukung.</p> */}
            {emergencyAvailable && <div className="space-y-3 rounded-md border border-amber-300 bg-amber-50 p-3"><label className="flex items-start gap-2 text-sm text-amber-900"><input type="checkbox" className="mt-1" checked={emergencyConfirmed} onChange={(event) => setEmergencyConfirmed(event.target.checked)} />Saya mengonfirmasi penggunaan nomor darurat bersufiks untuk tanggal {date}. Tidak ada alokasi manual.</label><div><label htmlFor="create-emergency-reason" className="label">Alasan nomor darurat</label><textarea id="create-emergency-reason" className="input" required={emergencyConfirmed} maxLength={500} rows={2} value={emergencyReason} onChange={(event) => setEmergencyReason(event.target.value)} /></div></div>}
            <button type="submit" className="btn-primary" disabled={submitting || !kdSurat || (emergencyAvailable && (!emergencyConfirmed || !emergencyReason.trim())) || (!canManage && fullDate === date)}>{submitting ? 'Mendaftarkan surat…' : emergencyAvailable ? 'Daftarkan dengan nomor darurat' : 'Daftarkan surat'}</button>
          </fieldset>
        </form>
        {canManage && <div className="mt-6 border-t border-slate-200 pt-4"><h3 className="font-semibold text-navy-900">Tambah KD Satker</h3><div className="mt-2 flex flex-wrap items-end gap-3"><div className="min-w-0 flex-1"><label htmlFor="new-satker" className="label">Nama satker baru</label><input id="new-satker" className="input" maxLength={100} value={satkerName} disabled={addingSatker} onChange={(event) => setSatkerName(event.target.value)} /></div><button type="button" className="btn-secondary" disabled={addingSatker} onClick={() => void addSatker()}>{addingSatker ? 'Menambahkan…' : 'Tambah satker'}</button></div>{catalogFeedback && <p role={catalogFeedback.error ? 'alert' : 'status'} className={`mt-2 text-sm ${catalogFeedback.error ? 'text-red-600' : 'text-emerald-700'}`}>{catalogFeedback.message}</p>}</div>}
      </section>
    </div>
  );
}
