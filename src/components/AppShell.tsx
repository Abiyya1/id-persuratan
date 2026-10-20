'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useState, type ReactNode } from 'react';
import type { Role } from '@/lib/supabase';
import { ROLE_LABELS } from './Badges';

export interface ShellUser {
  username: string;
  role: Role;
}

/**
 * Nav entries in render order, filtered by role.
 *
 * All approved roles can create and search letters and read the shared register.
 */
const NAV_ITEMS: Array<{ href: string; label: string; roles: Role[] }> = [
  { href: '/dashboard', label: 'Buat Nomor Surat', roles: ['user'] },
  { href: '/admin', label: 'Buat Nomor Surat', roles: ['admin', 'superadmin'] },
  { href: '/documents', label: 'Cari Surat', roles: ['user', 'admin', 'superadmin'] },
  { href: '/register-sheet', label: 'Register Surat', roles: ['user', 'admin', 'superadmin'] },
  { href: '/admin/register-settings', label: 'Pengaturan Nomor Surat', roles: ['admin', 'superadmin'] },
  { href: '/admin/users', label: 'Permintaan Akses', roles: ['admin'] },
  { href: '/admin/users', label: 'Kelola Pengguna', roles: ['superadmin'] },
  { href: '/admin/audit', label: 'Riwayat Audit', roles: ['admin', 'superadmin'] },
];

/** Person silhouette. Inline SVG avoids an icon dependency for one glyph. */
function UserIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

/**
 * Chrome for every authenticated page: fixed left sidebar, identity row at the
 * top right of the content column.
 *
 * Active nav state comes from usePathname, never from props. That makes it
 * correct on first paint, on refresh, and on browser back -- the previous
 * implementation read ?tab= once at mount and drifted out of sync.
 *
 * The identity row is sticky inside the scrolling content column, so Sign out
 * stays reachable without scrolling to the bottom of a long table.
 */
export function AppShell({
  user,
  children,
}: {
  user: ShellUser;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  const items = NAV_ITEMS.filter((item) => item.roles.includes(user.role));

  // Inlined rather than extracted to a hook: this is the only sign-out in the
  // app, so a shared abstraction would be pure indirection.
  const signOut = useCallback(async () => {
    setSigningOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      router.push('/login');
      // Without refresh, Next serves a cached server component for the route
      // just left and the user briefly sees a page they no longer can reach.
      router.refresh();
    } catch {
      // Network-level failure only -- fetch resolves on a 4xx/5xx, so an HTTP
      // error already took the try path above. Either way the goal is the same:
      // land them on /login and let middleware decide whether the cookie is
      // really gone, rather than leaving a button that appears broken.
      router.push('/login');
    } finally {
      setSigningOut(false);
    }
  }, [router]);

  return (
    <div className="flex min-h-screen flex-col bg-slate-100 md:flex-row">
      {/* ---- Sidebar ------------------------------------------------- */}
      <aside className="flex h-auto w-full shrink-0 flex-col border-b border-slate-200 bg-white md:sticky md:top-0 md:h-screen md:w-64 md:border-b-0 md:border-r">
        <div className="flex h-16 shrink-0 items-center gap-2 border-b border-slate-200 px-4">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-navy-700 text-xs font-bold text-white">
            ID
          </span>
          <span className="text-sm font-semibold text-navy-900">Pengelola Nomor Surat</span>
        </div>

        <nav className="flex flex-wrap gap-1 p-3 md:block md:flex-1 md:space-y-1 md:overflow-y-auto" aria-label="Navigasi utama">
          {items.map((item) => {
            // Exact match for index routes, prefix for sections. Without the
            // exact check, /admin/users would also highlight "Buat Nomor Surat".
            const active = item.href === '/admin'
              ? pathname === '/admin'
              : item.href === '/dashboard'
                ? pathname === '/dashboard'
                : pathname.startsWith(item.href);

            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`block rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  active
                    ? 'bg-navy-700 text-white'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-navy-800'
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* ---- Content -------------------------------------------------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Identity row: unchanged from the old topbar except for the icon
            and the red Sign out button. */}
        <div className="sticky top-0 z-10 flex h-16 shrink-0 items-center justify-end gap-3 border-b border-slate-200 bg-white px-4 sm:px-6">
          <Link
            href="/profile"
            title="Profil"
            aria-label="Profil"
            aria-current={pathname.startsWith('/profile') ? 'page' : undefined}
            className={`rounded-md p-2 transition-colors ${
              pathname.startsWith('/profile')
                ? 'bg-slate-100 text-navy-800'
                : 'text-slate-500 hover:bg-slate-100 hover:text-navy-800'
            }`}
          >
            <UserIcon className="h-5 w-5" />
          </Link>

          <div className="text-right">
            <p className="text-sm font-medium leading-tight text-slate-900">{user.username}</p>
            <p className="text-xs leading-tight text-slate-500">{ROLE_LABELS[user.role]}</p>
          </div>

          <button
            type="button"
            onClick={() => void signOut()}
            disabled={signingOut}
            className="btn-danger"
          >
            {signingOut ? 'Sedang keluar...' : 'Keluar'}
          </button>
        </div>

        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      </div>
    </div>
  );
}
