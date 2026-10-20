import 'server-only';
import { getSupabaseAdmin } from './supabase';
import { readExistingRegister, describeSheetsError, sheetsUserMessage } from './google-sheets';
import { getRegisterToday } from './letter-fields';
import { AuthError } from './auth';

/** Imports the existing B:M ledger once; SQL serializes concurrent first requests. */
export async function ensureLetterRegister(): Promise<void> {
  const db = getSupabaseAdmin();
  const { data: state, error } = await db.from('register_state').select('initialized').eq('id', 1).maybeSingle<{ initialized: boolean }>();
  if (error || !state) throw new Error('Migrasi register surat belum tersedia. Jalankan supabase/migrations/20261006_letter_register.sql pada Supabase.');
  if (state.initialized) return;
  let rows;
  try {
    rows = await readExistingRegister();
  } catch (error) {
    console.error('[letter-register] source import failed:', describeSheetsError(error));
    throw new Error(sheetsUserMessage(error));
  }
  const initialized = await db.rpc('initialize_letter_register', { p_rows: rows, p_today: getRegisterToday() });
  if (initialized.error) {
    console.error('[letter-register] import failed:', initialized.error.message);
    if (initialized.error.message.startsWith('REGISTER_CONFLICT') || initialized.error.message.startsWith('TARGET_TOO_SMALL')) {
      throw new AuthError('Rencana jumlah nomor bertentangan dengan rentang impor. Hubungi administrator untuk meninjau atau menghapus rencana di Pengaturan Nomor Surat; nomor yang sudah ada tidak diubah.', 409);
    }
    throw new Error('Tidak dapat mengimpor register surat. Periksa konfigurasi dan migrasi Supabase.');
  }
}
