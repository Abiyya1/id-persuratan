import Link from 'next/link';

/**
 * Public landing page. Middleware lets anyone through here; the links point at
 * whichever portal matches the visitor's role.
 */
export default function HomePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-br from-navy-900 via-navy-800 to-slate-900 px-4 py-12">
      <div className="w-full max-w-2xl animate-fade-in">
        <div className="rounded-2xl bg-white/95 p-8 shadow-2xl sm:p-10">
          <div className="mb-6 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-navy-700 text-xl font-bold text-white">
            ID
          </div>

          <h1 className="text-3xl font-bold tracking-tight text-navy-900 sm:text-4xl">
            Document Labeling &amp; ID Management
          </h1>

          <p className="mt-3 text-base leading-relaxed text-slate-600">
            Atomic, duplicate-proof document numbering with automatic Google Sheets
            synchronization and a self-healing retry queue.
          </p>

          <dl className="mt-8 grid gap-4 sm:grid-cols-3">
            {[
              { k: 'Zero duplicates', v: 'Row-locked counter, not a max()+1 guess.' },
              { k: 'Never loses data', v: 'A Sheets outage costs a sync, never a document.' },
              { k: 'Self-healing', v: 'Failed rows retry every 5 minutes.' },
            ].map((item) => (
              <div key={item.k} className="rounded-lg bg-slate-50 p-4">
                <dt className="text-sm font-semibold text-navy-800">{item.k}</dt>
                <dd className="mt-1 text-sm text-slate-600">{item.v}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link href="/login" className="btn-primary flex-1">
              Sign in
            </Link>
            <Link href="/register" className="btn-secondary flex-1">
              Request an account
            </Link>
          </div>

          <p className="mt-6 border-t border-slate-200 pt-4 text-xs text-slate-500">
            New registrations are held for Superadmin approval before they can sign in.
          </p>
        </div>
      </div>
    </main>
  );
}
