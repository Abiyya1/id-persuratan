'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useState, type ReactNode } from 'react';
import type { Role } from '@/lib/supabase';

export interface ShellUser {
  username: string;
  role: Role;
}

/**
 * Nav entries in render order, filtered by role.
 *
 * `user` accounts get "My Documents" (/dashboard) because that is the only
 * portal they can reach -- /admin redirects them via middleware. Admins get
 * the management sections instead.
 */
const NAV_ITEMS: Array<{ href: string; label: string; roles: Role[] }> = [
  { href: '/dashboard', label: 'My Documents', roles: ['user'] },
  { href: '/admin', label: 'Documents', roles: ['admin', 'superadmin'] },
  { href: '/admin/users', label: 'User Management', roles: ['superadmin'] },
  { href: '/admin/audit', label: 'Audit Log', roles: ['admin', 'superadmin'] },
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

  // Inlined rather than extracted to a hook: AppNav is being deleted, so this
  // has exactly one consumer and a shared abstraction would be pure indirection.
  const signOut = useCallback(async () => {
    setSigningOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      router.push('/login');
      // Without refresh, Next serves a cached server component for the route
      // just left and the user briefly sees a page they no longer can reach.
      router.refresh();
    } catch {
      // The cookie may already be gone even if the response failed. Sending
      // them to /login and letting middleware re-check beats a dead button.
      router.push('/login');
    } finally {
      setSigningOut(false);
    }
  }, [router]);

  return (
    <div className="flex min-h-screen bg-slate-100">
      {/* ---- Sidebar ------------------------------------------------- */}
      <aside className="sticky top-0 flex h-screen w-64 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-4">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-navy-700 text-xs font-bold text-white">
            ID
          </span>
          <span className="text-sm font-semibold text-navy-900">Document ID Manager</span>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto p-3" aria-label="Main">
          {items.map((item) => {
            // Exact match for index routes, prefix for sections. Without the
            // exact check, /admin/users would also highlight "Documents".
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
        <div className="sticky top-0 z-10 flex items-center justify-end gap-3 border-b border-slate-200 bg-white px-6 py-3">
          <Link
            href="/profile"
            title="Profile"
            aria-label="Profile"
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
            <p className="text-xs capitalize leading-tight text-slate-500">{user.role}</p>
          </div>

          <button
            type="button"
            onClick={() => void signOut()}
            disabled={signingOut}
            className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white
                       transition-colors hover:bg-red-700 disabled:cursor-not-allowed
                       disabled:opacity-50"
          >
            {signingOut ? 'Signing out...' : 'Sign out'}
          </button>
        </div>

        <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-8">{children}</main>
      </div>
    </div>
  );
}
