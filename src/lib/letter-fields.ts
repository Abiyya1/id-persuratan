export const REGISTER_YEAR = 2026;
export const MONTH_NAMES = ['JANUARI', 'FEBRUARI', 'MARET', 'APRIL', 'MEI', 'JUNI', 'JULI', 'AGUSTUS', 'SEPTEMBER', 'OKTOBER', 'NOVEMBER', 'DESEMBER'] as const;
export const KET_OPTIONS = ['SRIKANDI', 'EOFFICE', 'MANUAL'] as const;
export type LetterKet = typeof KET_OPTIONS[number];
export interface LetterMetadata {
  kdSurat: string;
  kdSatker: string;
  tujuanSurat: string;
  ket: LetterKet;
}
export interface LetterInput {
  date: string;
  month: number;
  hal: string;
  metadata: LetterMetadata;
  emergency: boolean;
  emergencyReason: string | null;
}

export function getRegisterToday(instant: Date = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}

export function validateLetterInput(input: unknown, today = getRegisterToday()): LetterInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Form surat tidak valid.');
  const body = input as Record<string, unknown>;
  function text(key: string, label: string, limit: number): string {
    const value = typeof body[key] === 'string' ? body[key].trim() : '';
    if (!value || value.length > limit) throw new Error(`${label} wajib diisi, maksimal ${limit} karakter.`);
    return value;
  }
  const date = text('date', 'Tanggal', 10);
  if (!/^2026-\d{2}-\d{2}$/.test(date)) throw new Error('Pilih tanggal pada tahun 2026.');
  const parsedDate = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) throw new Error('Tanggal tidak valid.');
  const month = body.month;
  if (typeof month !== 'number' || !Number.isInteger(month) || month < 1 || month > 12 || month !== Number(date.slice(5, 7))) throw new Error('Bulan harus sesuai dengan tanggal surat.');
  const kdSurat = text('kdSurat', 'KD Surat', 40);
  if (!/^\d{3}(?:\.\d+){0,3}$/.test(kdSurat)) throw new Error('Pilih KD Surat dari Acuan No Surat.');
  const kdSatker = text('kdSatker', 'KD Satker', 100);
  const hal = text('hal', 'Hal', 300);
  const tujuanSurat = text('tujuanSurat', 'Tujuan Surat', 500);
  const ket = text('ket', 'Ket.', 10);
  if (!KET_OPTIONS.some((option) => option === ket)) throw new Error('Pilih SRIKANDI, EOFFICE, atau MANUAL.');
  if (date !== today && ket !== 'MANUAL') throw new Error('Untuk tanggal selain hari ini (WIB), pilih Ket MANUAL.');
  if (body.emergency !== undefined && typeof body.emergency !== 'boolean') throw new Error('Konfirmasi nomor darurat tidak valid.');
  const emergency = body.emergency === true;
  const emergencyReason = emergency ? text('emergencyReason', 'Alasan nomor darurat', 500) : null;
  return { date, month, hal, metadata: { kdSurat, kdSatker, tujuanSurat, ket: ket as LetterKet }, emergency, emergencyReason };
}
