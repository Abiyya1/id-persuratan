'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { REGISTER_MONTHS, REGISTER_YEAR } from '@/lib/register-sheet';
import type { SheetRegisterMonth } from '@/lib/sheet-register';

export function SheetRegister({ initialMonth, initialDay }: { initialMonth: number; initialDay: number }) {
  const router = useRouter();
  const [month, setMonth] = useState(initialMonth);
  const [day, setDay] = useState(initialDay);
  const [data, setData] = useState<SheetRegisterMonth | null>(null);
  const [error, setError] = useState<{ month: number; message: string } | null>(null);
  const [loadingMonth, setLoadingMonth] = useState<number | null>(initialMonth);
  const [accessDenied, setAccessDenied] = useState(false);
  const reload = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    let denied = false;
    let controller: AbortController | null = null;
    let timer: number | undefined;

    setData(null);
    setError(null);
    setLoadingMonth(month);

    function clearTimer() {
      window.clearTimeout(timer);
      timer = undefined;
    }

    function schedule() {
      clearTimer();
      if (active && !denied && document.visibilityState === 'visible') {
        timer = window.setTimeout(() => void load(), 10_000);
      }
    }

    async function load() {
      if (!active || denied || inFlight || document.visibilityState !== 'visible') return;
      clearTimer();
      inFlight = true;
      const request = new AbortController();
      controller = request;
      setLoadingMonth(month);
      let failureMessage = 'Tidak dapat membaca Google Sheets. Coba muat ulang.';
      try {
        const response = await fetch(`/api/register/sheet?month=${month}`, {
          cache: 'no-store',
          signal: request.signal,
        });
        if (!active || request.signal.aborted) return;
        if (response.status === 401 || response.status === 403) {
          denied = true;
          setData(null);
          setError(null);
          setAccessDenied(true);
          router.replace('/login');
          router.refresh();
          return;
        }
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          if (typeof body?.error === 'string') failureMessage = body.error;
          throw new Error(failureMessage);
        }
        const next: SheetRegisterMonth = await response.json();
        if (!active || request.signal.aborted) return;
        setData(next);
        setError(null);
      } catch {
        if (active && !request.signal.aborted) {
          setError({ month, message: failureMessage });
        }
      } finally {
        inFlight = false;
        controller = null;
        if (active) {
          setLoadingMonth(null);
          schedule();
        }
      }
    }

    function onVisibility() {
      if (document.visibilityState === 'visible') void load();
      else clearTimer();
    }

    function onFocus() {
      if (document.visibilityState === 'visible') void load();
    }

    reload.current = load;
    void load();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    return () => {
      active = false;
      clearTimer();
      controller?.abort();
      reload.current = null;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
    };
  }, [month, router]);

  const monthData = data?.month === month ? data : null;
  const currentError = error?.month === month ? error.message : null;
  const loading = loadingMonth === month || (!monthData && !currentError);
  const daysInMonth = new Date(Date.UTC(REGISTER_YEAR, month, 0)).getUTCDate();
  const date = `${REGISTER_YEAR}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const selectedDay = monthData?.days.find((item) => item.date === date);
  const rows = selectedDay?.rows.map((row, rowIndex) => (
    <tr key={row.sheetRow} style={{ height: row.height }}>
      {row.cells.map((cell, columnIndex) => {
        if (cell.covered) return null;
        const Cell = rowIndex < 3 ? 'th' : 'td';
        let height = 0;
        for (let offset = 0; offset < (cell.rowSpan ?? 1); offset++) height += selectedDay.rows[rowIndex + offset]?.height ?? 0;
        const borderHeight = Math.max(parseFloat(String(cell.style.borderTop ?? cell.style.border)) || 0, parseFloat(String(cell.style.borderBottom ?? cell.style.border)) || 0);
        const contentHeight = Math.max(0, height - Number(cell.style.paddingTop ?? 0) - Number(cell.style.paddingBottom ?? 0) - borderHeight);
        return (
          <Cell
            key={columnIndex}
            rowSpan={cell.rowSpan}
            colSpan={cell.colSpan}
            scope={rowIndex < 3 ? (cell.colSpan && cell.colSpan > 1 ? 'colgroup' : 'col') : undefined}
            title={cell.text}
            style={{ padding: '2px 3px', fontWeight: 'normal', textAlign: 'left', ...cell.style }}
          >
            <div style={{ maxHeight: contentHeight, overflow: 'hidden' }}>
            {cell.checked !== null ? (
              <input
                type="checkbox"
                checked={cell.checked}
                disabled
                readOnly
                aria-label={`Sel ${String.fromCharCode(66 + columnIndex)}${row.sheetRow}: ${cell.checked ? 'dicentang' : 'tidak dicentang'} (hanya baca)`}
                className="h-4 w-4 align-middle disabled:cursor-default"
              />
            ) : cell.text}
            </div>
          </Cell>
        );
      })}
    </tr>
  ));

  if (accessDenied) {
    return <p role="status" className="text-sm text-slate-600">Sesi berakhir atau akses tidak tersedia. Mengarahkan ke halaman masuk…</p>;
  }

  return (
    <div className="min-w-0 space-y-4">
      <section className="card p-6" aria-label="Filter register">
        <div className="flex flex-wrap items-end gap-4">
          <div className="w-48">
            <label htmlFor="sheet-register-month" className="label">Bulan ({REGISTER_YEAR})</label>
            <select
              id="sheet-register-month"
              className="input"
              value={month}
              onChange={(event) => {
                const next = Number(event.target.value);
                setDay((current) => Math.min(current, new Date(Date.UTC(REGISTER_YEAR, next, 0)).getUTCDate()));
                setMonth(next);
              }}
            >
              {REGISTER_MONTHS.map((name, index) => <option key={name} value={index + 1}>{name}</option>)}
            </select>
          </div>
          <div className="w-32">
            <label htmlFor="sheet-register-day" className="label">Tanggal (WIB)</label>
            <select id="sheet-register-day" className="input" value={day} onChange={(event) => setDay(Number(event.target.value))}>
              {Array.from({ length: daysInMonth }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}
            </select>
          </div>
          <button type="button" className="btn-secondary" disabled={loading} onClick={() => void reload.current?.()}>
            Muat ulang
          </button>
        </div>
        <p className="mt-3 text-xs text-slate-500">Hanya baca · kolom B–M · diperbarui otomatis setiap 10 detik saat halaman aktif.</p>
        <div className="mt-2 min-h-5 text-xs text-slate-500" role="status" aria-live="polite">
          {monthData && <span>Bacaan Sheets terakhir: <time dateTime={monthData.fetchedAt}>{new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(monthData.fetchedAt))} WIB</time>.</span>}
          {loading && <span>{monthData ? ' Menyegarkan…' : 'Memuat register dari Google Sheets…'}</span>}
        </div>
      </section>

      {currentError && (
        <div role="alert" className={`rounded-md border p-3 text-sm ${monthData ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-red-300 bg-red-50 text-red-800'}`}>
          {currentError}{monthData && ' Data yang ditampilkan adalah bacaan terakhir dan mungkin belum terbaru.'}
        </div>
      )}

      {monthData && !monthData.available ? (
        <div className="card p-6 text-sm text-slate-600">Lembar {REGISTER_MONTHS[month - 1]} belum tersedia di Google Sheets.</div>
      ) : monthData && !selectedDay ? (
        <div className="card p-6 text-sm text-slate-600">Tanggal {day} {REGISTER_MONTHS[month - 1]} {REGISTER_YEAR} belum tersedia di lembar ini.</div>
      ) : monthData && selectedDay ? (
        <section className="card min-w-0 overflow-hidden" aria-label={`Register ${date}`}>
          <div className="border-b border-slate-200 px-6 py-3 text-sm text-slate-600">{monthData.title} · {day} {REGISTER_MONTHS[month - 1]} {REGISTER_YEAR}</div>
          <div className="max-w-full overflow-x-auto bg-white" tabIndex={0} role="region" aria-label="Register lembar kerja, gulir mendatar untuk melihat semua kolom">
            <table
              aria-label={`Register Google Sheets ${date}, kolom B sampai M`}
              style={{ borderCollapse: 'collapse', tableLayout: 'fixed', width: monthData.widths.reduce((sum, width) => sum + width, 0), fontFamily: 'Arial, sans-serif', fontSize: '10pt', color: '#000' }}
            >
              <colgroup>{monthData.widths.map((width, index) => <col key={index} style={{ width }} />)}</colgroup>
              <thead>{rows?.slice(0, 3)}</thead>
              <tbody>{rows?.slice(3)}</tbody>
            </table>
          </div>
        </section>
      ) : !loading && currentError ? (
        <p className="text-sm text-slate-600">Register belum dapat ditampilkan. Gunakan Muat ulang untuk mencoba lagi.</p>
      ) : null}
    </div>
  );
}
