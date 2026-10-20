'use client';

import { useCallback, useEffect, useId, useState } from 'react';

export type RegisterOptions = {
  classifications: { code: string; description: string }[];
  satkers: { id: string; name: string }[];
  today: string;
  year: number;
};

export function useRegisterOptions() {
  const [options, setOptions] = useState<RegisterOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/documents/options', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Tidak dapat memuat klasifikasi dan katalog satker.');
      if (!Array.isArray(data.classifications) || !data.classifications.length ||
          !Array.isArray(data.satkers) || !data.satkers.length ||
          !/^2026-\d{2}-\d{2}$/.test(data.today) || data.year !== 2026) {
        throw new Error('Klasifikasi, katalog satker, atau tanggal server tidak tersedia untuk 2026.');
      }
      setOptions(data as RegisterOptions);
      return data as RegisterOptions;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Tidak dapat menghubungi server.');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  return { options, error, loading, reload };
}

/** Only an exact catalog code is emitted; search text is never submitted. */
export function ClassificationInput({ id, options, value, onChange, disabled = false }: {
  id: string;
  options: RegisterOptions['classifications'];
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
}) {
  const listId = useId();
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const selected = options.find((option) => option.code === value);
  const hierarchy = selected ? options
    .filter((option) => selected.code === option.code || selected.code.startsWith(`${option.code}.`))
    .sort((a, b) => a.code.length - b.code.length) : [];
  const invalid = !disabled && query.length > 0 && !selected;
  const filtered = options.filter((option) =>
    `${option.code} ${option.description}`.toLocaleLowerCase('id').includes(query.trim().toLocaleLowerCase('id')),
  );

  function choose(code: string) {
    onChange(code);
    setQuery(code);
    setOpen(false);
    setActive(-1);
  }

  return (
    <div className="relative min-w-0">
      <label htmlFor={id} className="label">KD Surat <span className="text-red-500">*</span></label>
      <input
        id={id}
        className="input"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        aria-describedby={`${id}-help`}
        aria-invalid={invalid}
        autoComplete="off"
        required
        disabled={disabled}
        value={query}
        placeholder="Cari kode atau uraian klasifikasi"
        onFocus={() => setOpen(true)}
        onBlur={() => { setOpen(false); setActive(-1); }}
        onChange={(event) => {
          const text = event.target.value;
          setQuery(text);
          onChange(options.find((option) => option.code === text.trim())?.code ?? '');
          setOpen(true);
          setActive(-1);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
            if (!filtered.length) { setActive(-1); return; }
            const next = event.key === 'ArrowDown'
              ? Math.min(active + 1, filtered.length - 1)
              : Math.max(active - 1, 0);
            setActive(next);
            document.getElementById(`${listId}-${next}`)?.scrollIntoView({ block: 'nearest' });
          } else if (event.key === 'Enter' && open && active >= 0 && filtered[active]) {
            event.preventDefault();
            choose(filtered[active].code);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            setOpen(false);
            setActive(-1);
          }
        }}
      />
      <p id={`${id}-help`} className={`mt-1 text-xs [overflow-wrap:anywhere] ${invalid ? 'text-red-600' : 'text-slate-500'}`}>
        {selected ? hierarchy.map((option, index) => (
          <span key={option.code} className="block" style={{ paddingInlineStart: `${index * 0.75}rem` }}>
            {option.code === selected.code
              ? <strong className="font-semibold text-slate-700">{option.code} {option.description}</strong>
              : `${option.code} ${option.description}`}
          </span>
        )) : 'Pilih kode yang terdaftar.  '}
      </p>
      {open && !disabled && (
        <ul id={listId} role="listbox" aria-label="Klasifikasi surat" className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-slate-200 bg-white shadow-lg">
          {filtered.map((option, index) => (
            <li
              key={option.code}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={option.code === value}
              className={`cursor-pointer px-3 py-2 text-sm ${active === index ? 'bg-navy-50 text-navy-900' : 'text-slate-700 hover:bg-slate-50'}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(option.code)}
            >
              <span className="font-mono font-semibold">{option.code}</span> — {option.description}
            </li>
          ))}
          {!filtered.length && <li role="presentation" className="px-3 py-3 text-sm text-slate-500">Tidak ada klasifikasi yang cocok.</li>}
        </ul>
      )}
    </div>
  );
}
