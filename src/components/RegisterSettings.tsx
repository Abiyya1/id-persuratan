'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { CLOSING_UNUSED_MAX, FUTURE_DAILY_MAX, DAY_TARGET_MAX, validateRegisterDefaults, validateRegisterDayTarget, validateRegisterSettings, type RegisterSettings as Settings } from '@/lib/register-settings';

export function RegisterSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [closing, setClosing] = useState('');
  const [daily, setDaily] = useState('');
  const [date, setDate] = useState('');
  const [total, setTotal] = useState('');
  const [editingDate, setEditingDate] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const applySettings = useCallback((next: Settings) => {
    setSettings(next);
    setClosing(String(next.closingUnusedMinimum));
    setDaily(String(next.futureDailyTotal));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/register/settings', { cache: 'no-store' });
      const data: unknown = await response.json();
      if (!response.ok) throw new Error(data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : 'Pengaturan belum dapat dimuat.');
      applySettings(validateRegisterSettings(data));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pengaturan belum dapat dimuat.');
    } finally {
      setLoading(false);
    }
  }, [applySettings]);

  useEffect(() => { void load(); }, [load]);

  async function save(method: 'PUT' | 'POST' | 'DELETE', body: unknown) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/register/settings', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
      const data: unknown = await response.json();
      if (!response.ok) throw new Error(data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : 'Pengaturan belum dapat disimpan.');
      applySettings(validateRegisterSettings(data));
      if (method !== 'PUT') { setDate(''); setTotal(''); setEditingDate(null); }
      setMessage(method === 'DELETE' ? 'Rencana tanggal berhasil dihapus. Nomor yang sudah ada tidak berubah.' : 'Pengaturan berhasil disimpan. Nomor belum dialokasikan; rencana digunakan saat pendaftaran atau penutupan tanggal.');
    } catch (err) {
      setError(`${err instanceof Error ? err.message : 'Permintaan gagal.'} Jika koneksi terputus, muat ulang untuk memastikan apakah perubahan telah tersimpan.`);
    } finally { setBusy(false); }
  }

  function saveDefaults(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try { void save('PUT', validateRegisterDefaults({ closingUnusedMinimum: Number(closing), futureDailyTotal: Number(daily) })); }
    catch (err) { setMessage(''); setError(err instanceof Error ? err.message : 'Nilai pengaturan tidak valid.'); }
  }
  function saveTarget(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings) return;
    try { void save('POST', validateRegisterDayTarget({ date, total: Number(total) }, settings.today)); }
    catch (err) { setMessage(''); setError(err instanceof Error ? err.message : 'Rencana tanggal tidak valid.'); }
  }

  const selectedLocked = settings?.dayTargets.some((target) => target.date === date && target.locked) ?? false;
  const disabled = busy || loading;
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-slate-600">Pengaturan tidak mengubah nomor yang sudah ditetapkan dan tidak langsung mengalokasikan nomor atau memperbarui Google Sheets.</p>
        <button type="button" className="btn-secondary shrink-0" onClick={() => void load()} disabled={disabled}>Muat ulang</button>
      </div>
      {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {message && <p role="status" className="rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-700">{message}</p>}
      {loading && <p role="status" className="text-sm text-slate-500">Memuat pengaturan dari server...</p>}
      {settings && <>
        <form onSubmit={saveDefaults} className="card space-y-4 p-6">
          <h2 className="text-lg font-semibold text-navy-900">Pengaturan bawaan</h2>
          <p className="text-sm text-slate-600">Berlaku untuk tanggal yang belum ditetapkan dan tidak memiliki rencana khusus. Tanggal yang sudah ditutup tetap memakai jumlah sebelumnya.</p>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label htmlFor="closing-minimum" className="label">Minimum nomor kosong saat penutupan</label>
              <input id="closing-minimum" className="input" type="number" min="1" max={CLOSING_UNUSED_MAX} step="1" required value={closing} onChange={(event) => setClosing(event.target.value)} disabled={disabled} aria-describedby="closing-help" />
              <p id="closing-help" className="mt-1 text-xs text-slate-500">1–50 nomor kosong; bukan total nomor tanggal tersebut.</p>
            </div>
            <div>
              <label htmlFor="future-daily-total" className="label">Total nomor harian mendatang</label>
              <input id="future-daily-total" className="input" type="number" min="1" max={FUTURE_DAILY_MAX} step="1" required value={daily} onChange={(event) => setDaily(event.target.value)} disabled={disabled} aria-describedby="daily-help" />
              <p id="daily-help" className="mt-1 text-xs text-slate-500">1–150 nomor biasa per tanggal yang dilewati saat pendaftaran ke tanggal mendatang.</p>
            </div>
          </div>
          <button type="submit" className="btn-primary" disabled={disabled}>{busy ? 'Memproses...' : 'Simpan pengaturan bawaan'}</button>
        </form>
        <form onSubmit={saveTarget} className="card space-y-4 p-6">
          <h2 className="text-lg font-semibold text-navy-900">{editingDate ? 'Ubah rencana tanggal' : 'Rencana nomor per tanggal'}</h2>
          <p className="text-sm text-slate-600">Total 1–400 nomor biasa (terpakai dan kosong), tidak termasuk nomor darurat bersufiks. Rencana menggantikan pengaturan bawaan pada tanggal tersebut dan digunakan saat pendaftaran atau penutupan.</p>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label htmlFor="target-date" className="label">Tanggal rencana (WIB)</label>
              <input id="target-date" className="input" type="date" min={settings.today > '2026-01-01' ? settings.today : '2026-01-01'} max="2026-12-31" required value={date} onChange={(event) => setDate(event.target.value)} disabled={disabled || editingDate !== null} />
            </div>
            <div>
              <label htmlFor="target-total" className="label">Total nomor biasa pada tanggal pilihan</label>
              <input id="target-total" className="input" type="number" min="1" max={DAY_TARGET_MAX} step="1" required value={total} onChange={(event) => setTotal(event.target.value)} disabled={disabled || selectedLocked} />
            </div>
          </div>
          {selectedLocked && <p className="text-sm text-amber-700">Tanggal ini terkunci dan total rencana tidak dapat diubah. Pengaturannya masih dapat dihapus melalui daftar tanpa mengubah nomor yang sudah ada.</p>}
          <div className="flex gap-3">
            <button type="submit" className="btn-primary" disabled={disabled || selectedLocked || settings.today > '2026-12-31'}>{busy ? 'Memproses...' : 'Simpan rencana tanggal'}</button>
            {editingDate && <button type="button" className="btn-secondary" disabled={disabled} onClick={() => { setEditingDate(null); setDate(''); setTotal(''); }}>Batal mengubah</button>}
          </div>
        </form>
        <section className="card overflow-hidden" aria-labelledby="plans-heading">
          <div className="space-y-2 border-b border-slate-200 p-6">
            <h2 id="plans-heading" className="text-lg font-semibold text-navy-900">Rencana tersimpan</h2>
            <p className="text-sm text-slate-600">Tanggal terkunci jika sudah lewat, ditutup atau ditetapkan, atau ada rentang nomor pada tanggal setelahnya. Total tidak boleh lebih kecil dari jumlah nomor biasa yang sudah ada. Rencana dapat dihapus meskipun tanggalnya terkunci atau sudah lewat; penghapusan hanya menghapus pengaturan, tidak mengurangi nomor yang sudah disiapkan.</p>
          </div>
          {settings.dayTargets.length === 0 ? <p className="p-6 text-sm text-slate-500">Belum ada rencana tanggal khusus.</p> : <div className="overflow-x-auto"><table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500"><tr><th className="px-6 py-3">Tanggal (WIB)</th><th className="px-6 py-3">Total nomor biasa</th><th className="px-6 py-3">Status</th><th className="px-6 py-3">Tindakan</th></tr></thead>
            <tbody className="divide-y divide-slate-200">{settings.dayTargets.map((target) => <tr key={target.date}>
              <td className="px-6 py-3">{target.date}</td><td className="px-6 py-3">{target.total}</td><td className="px-6 py-3">{target.locked ? 'Terkunci' : 'Direncanakan'}</td>
              <td className="px-6 py-3"><div className="flex gap-2">
                <button type="button" className="btn-secondary btn-sm" disabled={disabled || target.locked} aria-label={`Ubah rencana ${target.date}`} onClick={() => { setDate(target.date); setTotal(String(target.total)); setEditingDate(target.date); setMessage(''); }}>Ubah</button>
                <button type="button" className="btn-danger btn-sm" disabled={disabled} aria-label={`Hapus rencana ${target.date}`} onClick={() => { if (window.confirm(`Hapus rencana nomor tanggal ${target.date}? Menghapus rencana tidak mengurangi nomor yang sudah disiapkan.`)) void save('DELETE', { date: target.date }); }}>Hapus</button>
              </div></td>
            </tr>)}</tbody>
          </table></div>}
        </section>
      </>}
    </div>
  );
}
