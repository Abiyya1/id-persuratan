import { SheetRegister } from '@/components/SheetRegister';
import { getRegisterToday } from '@/lib/letter-fields';
import { REGISTER_YEAR } from '@/lib/register-sheet';

export default function SheetRegisterPage() {
  const today = getRegisterToday();
  const month = Number(today.slice(5, 7));
  const day = Math.min(Number(today.slice(8, 10)), new Date(Date.UTC(REGISTER_YEAR, month, 0)).getUTCDate());

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-navy-900">Register Surat</h1>
        <p className="mt-1 text-sm text-slate-600">Lihat register surat langsung dari Google Sheets, termasuk nomor yang belum terpakai. Semua sel hanya baca.</p>
      </div>
      <SheetRegister initialMonth={month} initialDay={day} />
    </>
  );
}
