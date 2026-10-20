import type { sheets_v4 } from 'googleapis';

export const REGISTER_FILLED_NUMBER_COLOR = '#FFE599';
export const REGISTER_EMPTY_NUMBER_COLOR = '#EA9999';
export const REGISTER_YEAR = 2026;
export const REGISTER_MONTHS = ['JANUARI', 'FEBRUARI', 'MARET', 'APRIL', 'MEI', 'JUNI', 'JULI', 'AGUSTUS', 'SEPTEMBER', 'OKTOBER', 'NOVEMBER', 'DESEMBER'] as const;
export type RegisterCell = string | number | boolean | null;
export interface ImportedRegisterRow { number: string; date: string; values: RegisterCell[]; occupied: boolean }
export interface RegisterDay { letter_date: string; revision: number | string; synced_revision: number | string; fixed_reservation: boolean; closed: boolean; tail_trimmed?: boolean }
export interface RegisterDocument { id: number; title: string; surat_number: string; letter_date: string | null; metadata: Record<string, unknown> }
export interface RegisterSlot { number: string; letter_date: string; base_number: number; suffix_index: number; document_id: number | null; values: RegisterCell[] | null }
export interface RegisterBlock { date: string; headingRow: number; headerRow: number; dataRow: number; count: number }

export function normalizeRegisterNumber(value: unknown): string | null {
  const text = String(value ?? '').trim().replace(/^\.+/, '');
  if (!text) return null;
  if (!/^[1-9]\d*(?:\.(?:[a-z]+|[1-9]\d*))?$/.test(text)) return null;
  return text;
}

export function parseClassifications(rows: unknown[][]): { code: string; description: string }[] {
  const result = new Map<string, string>();
  for (const row of rows) {
    for (let column = 0; column < 4; column++) {
      const code = String(row[column] ?? '').trim().replace(/^\./, '');
      if (!/^\d{3}(?:\.\d+){0,3}$/.test(code)) continue;
      const description = String(row[column + 1] ?? '').trim();
      if (!description || /^\d{3}(?:\.\d+){0,3}$/.test(description)) throw new Error(`Klasifikasi ${code} tidak memiliki uraian.`);
      const previous = result.get(code);
      if (previous && previous !== description) throw new Error(`Uraian klasifikasi ${code} tidak konsisten.`);
      result.set(code, description);
    }
  }
  return [...result].map(([code, description]) => ({ code, description }));
}

export function parseRegisterHeading(value: unknown, month: number): string | null {
  const text = String(value ?? '').trim().toUpperCase();
  if (!text) return null;
  let match = text.match(/(?:^|\D)(\d{1,2})[\s/-]+(\d{1,2})[\s/-]+(\d{4})(?:$|\D)/);
  let day: number;
  let parsedMonth: number;
  let year: number;
  if (match) { day = Number(match[1]); parsedMonth = Number(match[2]); year = Number(match[3]); }
  else {
    match = text.match(new RegExp(`(?:^|\\D)(\\d{1,2})\\s+(${REGISTER_MONTHS.join('|')})(?:\\s+(\\d{4}))?(?:$|\\D)`));
    if (!match) return null;
    day = Number(match[1]); parsedMonth = REGISTER_MONTHS.indexOf(match[2] as typeof REGISTER_MONTHS[number]) + 1; year = Number(match[3] ?? REGISTER_YEAR);
  }
  const date = new Date(Date.UTC(year, parsedMonth - 1, day));
  if (year !== REGISTER_YEAR || parsedMonth !== month || date.getUTCDate() !== day || date.getUTCMonth() !== parsedMonth - 1) throw new Error(`Tanggal judul register tidak sesuai: ${text}`);
  return `${year}-${String(parsedMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Heading anchors vary between B (JULI) and C (AGUSTUS); numbered data rows are never headings. */
export function parseRegisterHeadingRow(row: unknown[], month: number): string | null {
  if (normalizeRegisterNumber(row[3])) return null;
  let heading: string | null = null;
  for (const cell of row.slice(0, 12)) {
    const candidate = parseRegisterHeading(cell, month);
    if (!candidate) continue;
    if (heading && heading !== candidate) throw new Error('Judul tanggal pada baris register tidak konsisten.');
    heading = candidate;
  }
  return heading;
}

export function parseRegisterRows(rows: unknown[][], month: number): ImportedRegisterRow[] {
  const result: ImportedRegisterRow[] = [];
  const seen = new Set<string>();
  let date: string | null = null;
  for (const row of rows) {
    const heading = parseRegisterHeadingRow(row, month);
    if (heading) { date = heading; continue; }
    const number = normalizeRegisterNumber(row[3]);
    if (!number) {
      const candidate = String(row[3] ?? '').trim();
      if (/^\.*\d/.test(candidate)) throw new Error(`Nomor surat tidak valid: ${candidate}`);
      continue;
    }
    if (!date) throw new Error(`Nomor surat ${number} tidak memiliki judul tanggal.`);
    if (seen.has(number)) throw new Error(`Nomor surat ${number} muncul lebih dari sekali.`);
    seen.add(number);
    const values = Array.from({ length: 12 }, (_, index) => (row[index] ?? '') as RegisterCell);
    result.push({ number, date, values, occupied: isRegisterRowOccupied(values) });
  }
  return result;
}
export function isRegisterRowOccupied(values: readonly unknown[]): boolean {
  return [1, 6, 7].some((index) => String(values[index] ?? '').trim() !== '') || values.slice(8, 12).some((value) => {
    const marker = String(value ?? '').trim().toUpperCase();
    return marker !== '' && marker !== 'FALSE';
  });
}

export function registerNumberFill(values: readonly unknown[]): string | null {
  return normalizeRegisterNumber(values[3]) ? isRegisterRowOccupied(values) ? REGISTER_FILLED_NUMBER_COLOR : REGISTER_EMPTY_NUMBER_COLOR : null;
}

export function registerNumberCellFormat(format: sheets_v4.Schema$CellFormat | null | undefined, values: readonly unknown[]): sheets_v4.Schema$CellFormat | undefined {
  const fill = registerNumberFill(values);
  if (!fill) return format ?? undefined;
  const rgbColor = { red: parseInt(fill.slice(1, 3), 16) / 255, green: parseInt(fill.slice(3, 5), 16) / 255, blue: parseInt(fill.slice(5, 7), 16) / 255 };
  return { ...format, backgroundColor: rgbColor, backgroundColorStyle: { rgbColor } };
}


export function registerSlotValues(slot: RegisterSlot, document?: RegisterDocument): RegisterCell[] {
  if (document) {
    if (document.surat_number !== slot.number || document.letter_date !== slot.letter_date) throw new Error(`Dokumen ${document.id} tidak sesuai dengan slot nomor ${slot.number}.`);
    const meta = document.metadata;
    return ['', String(meta.kdSurat ?? ''), '/', slot.number, '/', String(meta.kdSatker ?? ''), document.title, String(meta.tujuanSurat ?? ''), ...['CAT', 'SRIKANDI', 'EOFFICE', 'MANUAL'].map((ket) => meta.ket === ket)];
  }
  if (slot.document_id !== null) throw new Error(`Dokumen ${slot.document_id} untuk slot nomor ${slot.number} tidak ditemukan.`);
  const values = slot.values?.length ? Array.from({ length: 12 }, (_, index) => slot.values?.[index] ?? '') : ['', '', '/', slot.number, '/', '', '', '', false, false, false, false];
  if (normalizeRegisterNumber(values[3]) !== slot.number) values[3] = slot.number;
  return values;
}

export function buildRegisterProjection(days: RegisterDay[], slots: RegisterSlot[], documents: RegisterDocument[]) {
  const byId = new Map(documents.map((document) => [document.id, document]));
  const rows: RegisterCell[][] = [];
  const blocks: RegisterBlock[] = [];
  const seen = new Set<string>();
  const orderedDays = [...days].sort((a, b) => a.letter_date.localeCompare(b.letter_date));
  for (const day of orderedDays) {
    const daySlots = slots.filter((slot) => slot.letter_date === day.letter_date).sort((a, b) => a.base_number - b.base_number || a.suffix_index - b.suffix_index);
    if (day.tail_trimmed && !daySlots.length) continue;
    const headingRow = rows.length;
    const date = new Date(`${day.letter_date}T12:00:00+07:00`);
    const heading = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(date).toUpperCase();
    rows.push([heading, ...Array<RegisterCell>(11).fill('')]);
    rows.push(['NO', 'KD SURAT', '/', 'NOMOR SURAT', '/', 'KD SATKER', 'HAL', 'TUJUAN SURAT', 'KET.', '', '', '']);
    rows.push(['', '', '', '', '', '', '', '', 'CAT', 'SRIKANDI', 'EOFFICE', 'MANUAL']);
    for (const slot of daySlots) {
      if (seen.has(slot.number)) throw new Error(`Nomor register ${slot.number} muncul lebih dari sekali.`);
      seen.add(slot.number);
      const values = registerSlotValues(slot, slot.document_id === null ? undefined : byId.get(slot.document_id));
      if (!slot.values?.length || slot.document_id !== null) values[0] = rows.length - headingRow - 2;
      rows.push(values);
    }
    blocks.push({ date: day.letter_date, headingRow, headerRow: headingRow + 1, dataRow: headingRow + 3, count: daySlots.length });
  }
  if (slots.some((slot) => !days.some((day) => day.letter_date === slot.letter_date))) throw new Error('Slot nomor tidak memiliki tanggal register.');
  return { rows, blocks };
}
