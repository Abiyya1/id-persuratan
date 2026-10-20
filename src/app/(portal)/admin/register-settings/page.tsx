import { RegisterSettings } from '@/components/RegisterSettings';

export default function AdminRegisterSettingsPage() {
  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-navy-900">Pengaturan Nomor Surat</h1>
        <p className="mt-1 text-sm text-slate-600">Atur cadangan bawaan dan rencanakan total nomor biasa untuk tanggal tertentu pada tahun 2026.</p>
      </div>
      <RegisterSettings />
    </>
  );
}
