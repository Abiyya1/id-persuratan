import { redirect } from 'next/navigation';
import { getFreshSession } from '@/lib/auth';
import { DocumentSearch } from '@/components/DocumentSearch';

export default async function DocumentsPage() {
  const user = await getFreshSession();
  if (!user) redirect('/login');
  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-navy-900">Cari Surat</h1>
        <p className="mt-1 text-sm text-slate-600">
          {user.role === 'user' ? 'Cari dan kelola surat yang Anda buat.' : 'Cari dan kelola seluruh surat yang dibuat melalui aplikasi.'}
          {' '}Nomor dan tanggal surat yang tersisa tidak berubah. Setelah pengosongan Sheets dikonfirmasi, penghapusan surat terakhir membersihkan seluruh sisa nomor kosong di akhir register; nomor di tengah tersedia kembali pada tanggal aslinya.
        </p>
      </div>
      <DocumentSearch />
    </>
  );
}
