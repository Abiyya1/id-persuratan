import Link from 'next/link';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-br from-navy-900 via-navy-800 to-slate-900 px-4 py-12">
      <div className="w-full max-w-md">
        <Link href="/" className="mb-6 flex items-center justify-center gap-2">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-white text-sm font-bold text-navy-800">
            ID
          </span>
          <span className="text-sm font-semibold text-white">Pengelola Nomor Surat</span>
        </Link>

        {children}
      </div>
    </main>
  );
}
