'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';

export interface NavUser {
  username: string;
  role: string;
}

/**
 * Shared top navigation for all authenticated portals.
 *
 * Renders the correct links per role: `user` sees only their portal and
 * profile, `admin`/`superadmin` also see User Management.
 */
export function AppNav({
  user,
  active,
  children,
}: {
  user: NavUser;
  active: 'dashboard' | 'admin' | 'users' | 'audit' | 'profile';
  children?: ReactNode;
}) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  const isAdmin = user.role === 'admin' || user.role === 'superadmin';
  const isSuperadmin = user.role === 'superadmin';

  async function handleLogout() {
    setSigningOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      router.push('/login');
      router.refresh();
    } finally {
      setSigningOut(false);
    }
  }

  const linkClass = (key: string) =>
    `rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
      active === key
        ? 'bg-navy-700 text-white'
        : 'text-slate-600 hover:bg-slate-100 hover:text-navy-800'
    }`;

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3">
        <Link href="/" className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-navy-700 text-xs font-bold text-white">
            ID
          </span>
          <span className="hidden text-sm font-semibold text-navy-900 sm:block">
            Document ID Manager
          </span>
        </Link>

        <nav className="flex items-center gap-1" aria-label="Main">
          {!isAdmin && (
            <Link href="/dashboard" className={linkClass('dashboard')}>
              My Documents
            </Link>
          )}

          {isAdmin && (
            <Link href="/admin" className={linkClass('admin')}>
              Management
            </Link>
          )}

          {isSuperadmin && (
            <Link href="/admin?tab=users" className={linkClass('users')}>
              Users
            </Link>
          )}

          <Link href="/profile" className={linkClass('profile')}>
            Profile
          </Link>
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <div className="hidden text-right sm:block">
            <p className="text-sm font-medium text-slate-900">{user.username}</p>
            <p className="text-xs capitalize text-slate-500">{user.role}</p>
          </div>

          {children}

          <button
            type="button"
            onClick={handleLogout}
            disabled={signingOut}
            className="btn-secondary btn-sm"
          >
            {signingOut ? 'Signing out...' : 'Sign out'}
          </button>
        </div>
      </div>
    </header>
  );
}
