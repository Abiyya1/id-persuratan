export const REGISTER_SETTINGS_YEAR = 2026;
export const CLOSING_UNUSED_MAX = 50;
export const FUTURE_DAILY_MAX = 150;
export const DAY_TARGET_MAX = 400;

export interface RegisterDefaults {
  closingUnusedMinimum: number;
  futureDailyTotal: number;
}
export interface RegisterDayTarget {
  date: string;
  total: number;
  locked: boolean;
}
export interface RegisterSettings extends RegisterDefaults {
  today: string;
  year: number;
  dayTargets: RegisterDayTarget[];
}
export interface DayTargetInput { date: string; total: number }

function object(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Isi pengaturan tidak valid.');
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some((key) => !keys.includes(key))) throw new Error('Isi pengaturan memuat kolom yang tidak dikenal.');
  return body;
}
function integer(value: unknown, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${label} harus berupa bilangan bulat 1 sampai ${max}.`);
  }
  return value;
}
export function validateRegisterDate(value: unknown): string {
  if (typeof value !== 'string' || !/^2026-\d{2}-\d{2}$/.test(value)) throw new Error('Pilih tanggal pada tahun 2026.');
  const parsed = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error('Tanggal tidak valid.');
  return value;
}
export function validateRegisterDefaults(input: unknown): RegisterDefaults {
  const body = object(input, ['closingUnusedMinimum', 'futureDailyTotal']);
  return {
    closingUnusedMinimum: integer(body.closingUnusedMinimum, CLOSING_UNUSED_MAX, 'Minimum nomor kosong saat penutupan'),
    futureDailyTotal: integer(body.futureDailyTotal, FUTURE_DAILY_MAX, 'Total nomor harian mendatang'),
  };
}
export function validateRegisterDayDate(input: unknown, today?: string): { date: string } {
  const body = object(input, ['date']);
  const date = validateRegisterDate(body.date);
  if (today && date < today) throw new Error('Rencana hanya dapat diubah untuk hari ini atau tanggal mendatang (WIB).');
  return { date };
}
export function validateRegisterDayTarget(input: unknown, today: string): DayTargetInput {
  const body = object(input, ['date', 'total']);
  const { date } = validateRegisterDayDate({ date: body.date }, today);
  return { date, total: integer(body.total, DAY_TARGET_MAX, 'Total nomor pada tanggal pilihan') };
}
export function validateRegisterSettings(input: unknown): RegisterSettings {
  const body = object(input, ['closingUnusedMinimum', 'futureDailyTotal', 'today', 'year', 'dayTargets']);
  const defaults = validateRegisterDefaults({ closingUnusedMinimum: body.closingUnusedMinimum, futureDailyTotal: body.futureDailyTotal });
  if (typeof body.today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.today)) throw new Error('Tanggal server tidak valid.');
  const today = new Date(`${body.today}T12:00:00Z`);
  if (!Number.isFinite(today.getTime()) || today.toISOString().slice(0, 10) !== body.today) throw new Error('Tanggal server tidak valid.');
  if (body.year !== REGISTER_SETTINGS_YEAR || !Array.isArray(body.dayTargets)) throw new Error('Respons pengaturan tidak valid.');
  const dates = new Set<string>();
  const dayTargets = body.dayTargets.map((input) => {
    const target = object(input, ['date', 'total', 'locked']);
    const date = validateRegisterDate(target.date);
    if (typeof target.locked !== 'boolean' || dates.has(date)) throw new Error('Respons rencana tanggal tidak valid.');
    dates.add(date);
    return { date, total: integer(target.total, DAY_TARGET_MAX, 'Total nomor pada tanggal pilihan'), locked: target.locked };
  });
  return { ...defaults, today: body.today, year: REGISTER_SETTINGS_YEAR, dayTargets };
}
