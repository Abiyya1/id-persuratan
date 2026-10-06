# Sidebar Navigation Layout Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the top navigation bar with a fixed left sidebar used by every role, while keeping the identity cluster (user icon, username/role, Sign out) at the top right of the content area exactly as it appears today, with the Sign out button recoloured red.

**Architecture:** A new `AppShell` client component owns both halves of the chrome: a fixed left sidebar (brand, then nav) and a right-aligned header row above the page content. A new `(portal)` route group holds every authenticated page, so the session check and shell render in exactly one place. `AppNav` is deleted — the sidebar replaces it for all roles.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, Tailwind CSS 3.

---

## Decisions made in this plan (challenge these if you disagree)

**1. A plain `user` sees "My Documents" in the sidebar; admins see "Documents".**
The sidebar you asked for lists Documents / User Management / Audit Log — but those are management sections a `user` cannot reach (`/admin` redirects them). A `user` only has `/dashboard`. Their single nav item is therefore labelled "My Documents" to avoid confusion with the admin list. Change the `NAV_ITEMS` label in Task 1 if you want it to read "Documents" everywhere.

**2. The sidebar has no bottom cluster.**
Your new instruction moves the profile link out of the sidebar bottom and up beside the username. So the sidebar is brand + nav only, and the identity/sign-out row lives in the content column's top right.

**3. The identity row is sticky inside the content column.**
It looks like the bar in your image — white background, right-aligned — but it sits to the right of the sidebar and does not scroll away, so Sign out stays reachable on a long table. This is the only behavioural change from the current bar; the contents and layout are otherwise untouched.

**4. A route group, so the shell renders once.**
`src/app/(portal)/layout.tsx` owns the session check and the shell. Without it, three pages each duplicate ~8 lines of wrapper and session check. Moving `dashboard` and `profile` into the group does not change their URLs.

**5. `router.refresh()` stays in the sign-out handler.**
Without it Next serves a cached server component for the previous route and the user briefly sees a page they just lost access to.

---

## Critical context before you start

### The project has no git repository

`git rev-parse` returns `fatal: not a git repository`. Every task ends in a commit, so **Task 0 initializes git**. Do not skip it.

`.gitignore` already excludes `node_modules`, `.next`, `.env.local`, `.vercel`. **Verify `.env.local` is ignored before the first commit.** It holds your real Supabase service-role key (which bypasses RLS) and your Google private key. If it is not ignored, stop and fix that first.

### There is no React test runner

`npm test` runs `scripts/unit-test.mjs`, which tests **pure functions only** — validators, CSV escaping, private-key un-escaping — by extracting them from source with regex and `new Function`.

**You cannot write a failing unit test for JSX layout, and you should not add a test framework to do it.** That is scope creep for a layout change.

Verification for every task is the existing gate:

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # eslint src --max-warnings=0
npm run build        # must compile
```

Plus real browser checks in Task 7, including computed-style assertions. Do not claim a visual change works without looking at it.

### Existing structure you are changing

| File | Role today |
|---|---|
| `src/components/AppNav.tsx` | Horizontal topbar. Used by 3 pages. **Deleted in this plan.** |
| `src/app/admin/page.tsx` | Session check, `<AppNav active="admin">`, `<AdminPortal>`. |
| `src/app/profile/page.tsx` | Session check, `<AppNav active="profile">`, `<ProfileForm>`. |
| `src/app/dashboard/page.tsx` | Session check, `<AppNav active="dashboard">`, `<DocumentPortal>`. |
| `src/components/AdminPortal.tsx` | Owns `useState` tab state, Realtime, queue badge, export, resync. Tab strip is lines 273–334. |
| `src/app/(auth)/` | Existing route group for login/register. Your `(portal)` group is separate and unaffected. |

### Access rules you must preserve

- `User Management` is **superadmin-only** in the UI; `/api/superadmin/users` enforces it independently. Hiding the link is UX, not security.
- `src/middleware.ts` redirects a plain `user` away from `/admin`. Do not weaken it.
- `Audit Log` is admin + superadmin. `user` accounts get neither.
- Do not let the sidebar render for unauthenticated visitors; pages `redirect('/login')` first.

---

### Task 0: Initialize git and confirm secrets are ignored

**Files:**
- Create: `.git/` (via `git init`)
- Verify: `.gitignore`

**Step 1: Verify .env.local is ignored before anything else**

```bash
git init
git check-ignore -v .env.local
```

Expected: a line naming `.gitignore` and the `.env.local` pattern. **If it prints nothing, stop** and add `.env.local` to `.gitignore`.

**Step 2: Confirm what would be staged**

```bash
git add -A --dry-run
```

Expected: no `.env.local`, no `node_modules`, no `.next`. Skim for anything else surprising.

**Step 3: First commit**

```bash
git add -A
git commit -m "chore: initial commit of document ID management system"
```

---

### Task 1: Build AppShell

The core deliverable. Sidebar on the left, identity row at the top right of the content column.

**Files:**
- Create: `src/components/AppShell.tsx`

**Step 1: Write the file**

```tsx
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
```

**Step 2: Verify**

```bash
npm run typecheck && npm run lint
```

Expected: both clean.

**Step 3: Commit**

```bash
git add src/components/AppShell.tsx
git commit -m "feat: add AppShell with sidebar and top-right identity row"
```

---

### Task 2: Create the (portal) route group

The shell renders once, in a layout, rather than being repeated per page.

**Files:**
- Create: `src/app/(portal)/layout.tsx`

**Step 1: Write it**

```tsx
import { redirect } from 'next/navigation';
import { getFreshSession } from '@/lib/auth';
import { AppShell } from '@/components/AppShell';

/**
 * Layout for every authenticated page.
 *
 * Owns the single session check and the single shell render, so /dashboard,
 * /profile and /admin/* cannot drift apart. Individual pages still call
 * getFreshSession() because they need the user id and username for their own
 * rendering -- that is a read, not a second auth decision.
 */
export default async function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getFreshSession();

  if (!user) redirect('/login');

  return (
    <AppShell user={{ username: user.username, role: user.role }}>
      {children}
    </AppShell>
  );
}
```

**Step 2: Verify**

```bash
npm run typecheck
```

Expected: no errors.

**Step 3: Commit**

```bash
git add "src/app/(portal)/layout.tsx"
git commit -m "feat: add (portal) route group layout with AppShell"
```

---

### Task 3: Move dashboard and profile into the group

`git mv` preserves history. Parentheses need quoting in PowerShell.

**Files:**
- Move: `src/app/dashboard/page.tsx` → `src/app/(portal)/dashboard/page.tsx`
- Move: `src/app/profile/page.tsx` → `src/app/(portal)/profile/page.tsx`

**Step 1: Move the files**

```bash
git mv src/app/dashboard "src/app/(portal)/dashboard"
git mv src/app/profile "src/app/(portal)/profile"
```

URLs are unchanged — route groups do not appear in the path.

**Step 2: Remove AppNav from dashboard**

Open `src/app/(portal)/dashboard/page.tsx`. Delete the `AppNav` import and the `<AppNav ... />` element, and drop the now-redundant `min-h-screen` wrapper. It should read:

```tsx
import { redirect } from 'next/navigation';
import { getFreshSession } from '@/lib/auth';
import { DocumentPortal } from '@/components/DocumentPortal';

/**
 * Dashboard 1 -- User Portal.
 *
 * The shell and session check live in ../layout.tsx.
 */
export default async function DashboardPage() {
  const user = await getFreshSession();

  if (!user) redirect('/login');

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-navy-900">My Documents</h1>
        <p className="mt-1 text-sm text-slate-600">
          Submit a document to receive an atomic, duplicate-proof ID.
        </p>
      </div>

      <DocumentPortal
        userId={user.id}
        username={user.username}
        initialDocuments={[] as DocumentRow[]}
      />
    </>
  );
}
```

You need the type import too. The full import block at the top is:

```tsx
import { redirect } from 'next/navigation';
import { getFreshSession } from '@/lib/auth';
import { DocumentPortal } from '@/components/DocumentPortal';
import type { DocumentRow } from '@/lib/supabase';
```

**Step 3: Remove AppNav from profile**

`src/app/(portal)/profile/page.tsx` becomes:

```tsx
import { redirect } from 'next/navigation';
import { getFreshSession } from '@/lib/auth';
import { ProfileForm } from '@/components/ProfileForm';

/**
 * Profile settings for every authenticated role: change username and password.
 * Shell lives in ../layout.tsx.
 */
export default async function ProfilePage() {
  const user = await getFreshSession();
  if (!user) redirect('/login');

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-navy-900">Profile</h1>
        <p className="mt-1 text-sm text-slate-600">
          Update your username or change your password.
        </p>
      </div>

      <div className="mx-auto max-w-2xl">
        <ProfileForm initialUsername={user.username} role={user.role} />
      </div>
    </>
  );
}
```

**Step 4: Verify**

```bash
npm run typecheck && npm run lint
```

Expected: clean. If typecheck complains about `AppNav` being unused elsewhere, that is expected until Task 5.

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: move dashboard and profile into (portal) group"
```

---

### Task 4: Convert admin tabs to routes

`AppShell` links to `/admin/users` and `/admin/audit`. Those routes must exist, and `AdminPortal` must stop owning tab state or it will fight the pathname.

**Files:**
- Move: `src/app/admin/page.tsx` → `src/app/(portal)/admin/page.tsx`
- Create: `src/app/(portal)/admin/layout.tsx`
- Create: `src/app/(portal)/admin/users/page.tsx`
- Create: `src/app/(portal)/admin/audit/page.tsx`
- Create: `src/components/UsersSection.tsx`
- Modify: `src/components/AdminPortal.tsx`

**Step 1: Move the admin directory into the group**

```bash
git mv src/app/admin "src/app/(portal)/admin"
```

**Step 2: Create the admin layout (role gate)**

`src/app/(portal)/admin/layout.tsx`:

```tsx
import { redirect } from 'next/navigation';
import { getFreshSession } from '@/lib/auth';

/**
 * Restricts every /admin/* route to admin and superadmin.
 *
 * The shell itself is in ../../(portal)/layout.tsx. This is defence in depth:
 * middleware already bounces a plain user, and each page re-checks, but the
 * role gate belongs next to the routes it protects.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getFreshSession();

  if (!user) redirect('/login');
  if (user.role !== 'admin' && user.role !== 'superadmin') redirect('/dashboard');

  return <>{children}</>;
}
```

**Step 3: Rewrite the documents page**

`src/app/(portal)/admin/page.tsx`:

```tsx
import { redirect } from 'next/navigation';
import { getFreshSession } from '@/lib/auth';
import { AdminPortal } from '@/components/AdminPortal';

/**
 * Management Portal -- Documents section.
 *
 * Shell is in ../../(portal)/layout.tsx, role gate in ./layout.tsx.
 * AdminPortal no longer takes a `tab` prop; it is only rendered here.
 */
export default async function AdminDocumentsPage() {
  const user = await getFreshSession();
  if (!user) redirect('/login');

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-navy-900">Management Portal</h1>
        <p className="mt-1 text-sm text-slate-600">
          All documents, live sync status, and audit history.
        </p>
      </div>

      <AdminPortal
        currentUser={{ id: user.id, username: user.username, role: user.role }}
      />
    </>
  );
}
```

**Step 4: Create UsersSection (toast host for UsersTab)**

`UsersTab` requires an `onToast` prop. On its own page there is no sibling component providing it, so this thin client wrapper owns the toast.

`src/components/UsersSection.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { UsersTab } from './UsersTab';

/**
 * UsersTab plus the toast it reports through.
 *
 * Extracted because UsersTab is a client component that wants a toast setter,
 * and a server page cannot hold state. Previously AdminPortal owned this.
 */
export function UsersSection({ currentUserId }: { currentUserId: string }) {
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  return (
    <>
      {toast && (
        <div
          role="status"
          className={`mb-4 flex items-start justify-between rounded-md border p-3 text-sm ${
            toast.kind === 'success'
              ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
              : 'border-red-300 bg-red-50 text-red-800'
          }`}
        >
          <span>{toast.text}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            className="ml-3 font-bold opacity-60 hover:opacity-100"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      <UsersTab currentUserId={currentUserId} onToast={setToast} />
    </>
  );
}
```

**Step 5: Create the users page**

`src/app/(portal)/admin/users/page.tsx`:

```tsx
import { redirect } from 'next/navigation';
import { getFreshSession } from '@/lib/auth';
import { UsersSection } from '@/components/UsersSection';

/**
 * User Management -- superadmin only.
 *
 * The role is re-checked because the URL is typeable. /api/superadmin/users
 * refuses independently too, but failing here gives a clean redirect instead
 * of an empty panel.
 */
export default async function AdminUsersPage() {
  const user = await getFreshSession();

  if (!user) redirect('/login');
  if (user.role !== 'superadmin') redirect('/admin');

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-navy-900">User Management</h1>
        <p className="mt-1 text-sm text-slate-600">
          Approve registrations, create accounts, and assign roles.
        </p>
      </div>

      <UsersSection currentUserId={user.id} />
    </>
  );
}
```

**Step 6: Create the audit page**

`src/app/(portal)/admin/audit/page.tsx`:

```tsx
import { redirect } from 'next/navigation';
import { getFreshSession } from '@/lib/auth';
import { AuditTab } from '@/components/AuditTab';

/** Audit Log. Admin and superadmin both get this; the API enforces it too. */
export default async function AdminAuditPage() {
  const user = await getFreshSession();
  if (!user) redirect('/login');

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-navy-900">Audit Log</h1>
        <p className="mt-1 text-sm text-slate-600">
          Every document and account change, newest first.
        </p>
      </div>

      <AuditTab />
    </>
  );
}
```

**Step 7: Strip tab state out of AdminPortal.tsx**

a) Delete the `useSearchParams` import and the `type Tab` declaration.

b) Replace the signature and the tab-state block (currently lines 31–37):

```tsx
function AdminPortalInner({ currentUser }: { currentUser: CurrentUser }) {
  const isSuperadmin = currentUser.role === 'superadmin';
```

c) Delete the `useMemo` block that built `tabs` (currently lines 241–248).

d) Delete the whole tab strip `<div className="border-b border-slate-200">...</div>` (currently lines 273–334), **keeping** the Live badge, Refresh, Export CSV and Re-sync all controls. Replace that block with a plain toolbar:

```tsx
      {/* ---- Toolbar --------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`badge ${live ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'}`}
          title={
            live
              ? 'Connected to Supabase Realtime'
              : 'Realtime not connected -- use Refresh to update manually'
          }
        >
          <span
            aria-hidden
            className={`mr-1.5 h-1.5 w-1.5 rounded-full ${live ? 'bg-emerald-500' : 'bg-slate-400'}`}
          />
          {live ? 'Live' : 'Offline'}
        </span>

        <button type="button" onClick={() => void loadDocuments()} className="btn-secondary btn-sm">
          Refresh
        </button>
        <button type="button" onClick={() => void handleExport()} className="btn-secondary btn-sm">
          Export CSV
        </button>
        <button
          type="button"
          onClick={() => void handleResyncAll()}
          disabled={resyncing}
          className="btn-primary btn-sm"
        >
          {resyncing ? 'Re-syncing...' : 'Re-sync all'}
        </button>
      </div>
```

e) Replace the panel switch at the bottom (currently lines 356–377) with just the documents panel:

```tsx
      <DocumentsTab
        documents={documents}
        loading={loading}
        search={search}
        setSearch={setSearch}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        page={page}
        setPage={setPage}
        totalPages={totalPages}
        total={total}
        onResyncOne={handleResyncOne}
      />
```

f) Replace the `Suspense` wrapper at the bottom of the file (it existed only for `useSearchParams`) with:

```tsx
export function AdminPortal({ currentUser }: { currentUser: CurrentUser }) {
  return <AdminPortalInner currentUser={currentUser} />;
}
```

Remove the now-unused `Suspense` import too.

**Step 8: Verify nothing was missed**

```bash
npm run typecheck && npm run lint
```

Expected: clean. Any error mentioning `tab`, `setTab`, or `tabs` means a deletion was missed:

```bash
grep -n "setTab\|tabs\b\|useSearchParams\|Suspense\|isSuperadmin" src/components/AdminPortal.tsx
```

`isSuperadmin` may still be referenced by the Realtime comment -- check each hit deliberately rather than deleting blindly.

**Step 9: Commit**

```bash
git add -A
git commit -m "refactor: move admin tabs from component state to routes"
```

---

### Task 5: Delete AppNav

The sidebar replaced it for every role, so it is now dead code.

**Files:**
- Delete: `src/components/AppNav.tsx`

**Step 1: Confirm nothing references it**

```bash
grep -rn "AppNav" src/
grep -rn "import.*AppNav\|<AppNav" src/
```

Expected: **zero importers or callers** from the second grep. **If any remain,
fix those files first** -- Task 3 removes the last two usages.

The first grep may still match comment-only mentions (a rationale comment in
AppShell, one in middleware). Those are fine and are not a blocker -- the real
gate is that nothing imports or renders `<AppNav`.

**Step 2: Delete it**

```bash
git rm src/components/AppNav.tsx
```

**Step 3: Verify**

```bash
npm run typecheck && npm run lint && npm run build
```

Expected: all clean, and 17 routes still in the build output (the two new admin routes replace the removed tab panels, and `/admin/users` + `/admin/audit` are new).

**Step 4: Commit**

```bash
git add -A
git commit -m "refactor: remove AppNav, sidebar replaces it for all roles"
```

---

### Task 6: Sanity-check middleware still matches the new layout

The sidebar exposes `/admin/users` and `/admin/audit` as direct links. Middleware must not fight them.

**Files:**
- Read: `src/middleware.ts`

**Step 1: Confirm admin-prefix matching covers the new routes**

```bash
grep -n "ADMIN_PREFIXES\|SUPERADMIN_PREFIXES\|startsWith" src/middleware.ts
```

Expected: `/admin` matching still covers `/admin/users` and `/admin/audit` via its `startsWith` branch. Middleware only redirects admins away from `/dashboard`, and the sidebar's "My Documents" link is `user`-only, so there is no visible link pointing at a redirect.

**Step 2: Note one thing you may want to change, but do not change it now**

Admins no longer have a "My Documents" nav entry, yet `/dashboard` still renders for them if they type it -- except middleware redirects them to `/admin`. That is consistent, just slightly strict. Changing it means editing middleware role rules, which is a behaviour change beyond this plan. Leave it.

**Step 3: No commit needed** unless Step 1 revealed a real mismatch.

---

### Task 7: Verify in a browser

Compiling is not the same as looking right. Do this.

**Step 1: Start the dev server**

```bash
npm run dev
```

**Step 2: Sign in as superadmin** at http://localhost:3000/login

**Step 3: Confirm the sidebar for superadmin**

Expected on `/admin`:
- Left sidebar, brand `ID` + "Document ID Manager" at top
- Nav below, in order: Documents, User Management, Audit Log
- Top right of the content area: user icon, then username with `superadmin` beneath, then a **red** Sign out button
- **No full-width topbar**

```js
Array.from(document.querySelectorAll('aside nav a')).map(a => a.textContent)
```

Expected: `['Documents', 'User Management', 'Audit Log']`

```js
Array.from(document.querySelectorAll('aside')).length
```

Expected: `1`

**Step 4: Confirm the identity row matches your image, left to right**

```js
(() => {
  const row = document.querySelector('aside').parentElement.lastElementChild.firstElementChild;
  return Array.from(row.children).map(e => e.tagName + ':' + (e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 24));
})()
```

Expected, in order: `A:Profile`, then `DIV:` containing username and role, then `BUTTON:Sign out`.

```js
getComputedStyle(document.querySelector('aside').parentElement.lastElementChild.firstElementChild.querySelector('button')).backgroundColor
```

Expected: `rgb(220, 38, 38)` (`red-600`). White or transparent means the class did not apply.

```js
(() => { const a = document.querySelector('aside').parentElement.lastElementChild.firstElementChild.querySelector('a'); return getComputedStyle(a).color; })()
```

The icon is `currentColor`; verify it renders as an SVG, not a broken image:

```js
document.querySelectorAll('aside').length && !!document.querySelector('aside').parentElement.lastElementChild.firstElementChild.querySelector('a svg')
```

Expected: `true`

**Step 5: Confirm routing survives a hard refresh**

- Click **Audit Log** → URL `/admin/audit`, panel renders, item highlighted
- **Hard-refresh** (Ctrl+Shift+R) → still Audit Log, table populated
  - This is the bug fixed in Task 4. Landing on Documents instead means tab state was not fully removed.
- Click **User Management** → `/admin/users`, panel renders
- Click **Documents** → `/admin`, table renders

Confirm the active highlight is not sticky on `/admin/users`:

```js
Array.from(document.querySelectorAll('aside nav a')).map(a => a.getAttribute('aria-current'))
```

Expected: `[null, 'page', null]` -- only User Management is current.

**Step 6: Confirm the user icon works**

Click it → `/profile`, sidebar still visible, icon has its active grey background, form renders.

**Step 7: Confirm the admin role branch**

Still signed in as superadmin, open `/admin/users` directly -- fine. The role gate is hard to test without a second admin; if you have one, confirm `/admin/users` redirects to `/admin` for them and the sidebar shows only Documents + Audit Log.

**Step 8: Confirm a plain user gets the sidebar**

1. Sign out
2. `/register` a new account (it will be `pending` -- correct)
3. Sign back in as superadmin → User Management → set role `user`, status `approved`
4. Sign in as that user

Expected:
- Sidebar with exactly one nav item: `My Documents`
- **No** Documents, User Management, or Audit Log
- Identity row present at top right, red Sign out
- `/dashboard` renders the create form

```js
Array.from(document.querySelectorAll('aside nav a')).map(a => a.textContent)
```

Expected: `['My Documents']`

Also confirm that typing `/admin` as this user redirects to `/dashboard`.

**Step 9: Confirm sign out works**

As superadmin, click the red button. You land on `/login`, and opening `/admin` redirects there rather than re-rendering the portal.

**Step 10: Commit any fixes found in 3–9**, one commit each.

```bash
git add -A
git commit -m "fix: <what was wrong>"
```

---

### Task 8: Update the README

**Files:**
- Modify: `README.md`

**Step 1: Add a navigation section after the roles table**

```markdown
### Navigation

Every authenticated role uses a fixed left sidebar. Plain `user` accounts see
"My Documents"; `admin` and `superadmin` see Documents, User Management and
Audit Log (filtered by role).

The identity row sits at the top right of the content area: a user icon linking
to `/profile`, the username with the role beneath it, and a red Sign out button.
The row is sticky, so it stays reachable on long tables.

Management sections are real routes (`/admin`, `/admin/users`, `/admin/audit`),
so a refresh or browser back keeps you where you were. All authenticated pages
live in the `(portal)` route group, which owns the session check and the shell.
```

**Step 2: Record what Task 7 actually confirmed**

Be honest about anything unverified:

```markdown
Sidebar layout verified in a browser: nav order per role, identity row order,
red Sign out colour, route-based section switching surviving a hard refresh,
and the plain-user branch on /dashboard.
```

**Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document sidebar navigation layout"
```

---

## Definition of done

- [ ] `npm run typecheck` clean
- [ ] `npm run lint` clean (`--max-warnings=0`)
- [ ] `npm run build` succeeds
- [ ] `src/components/AppNav.tsx` no longer exists
- [ ] `grep -rn "AppNav" src/` returns no importers or callers (comment-only mentions are fine)
- [ ] Exactly one `<aside>` on every authenticated page
- [ ] superadmin sidebar: Documents, User Management, Audit Log -- in that order
- [ ] plain `user` sidebar: My Documents only
- [ ] Identity row order: user icon, username+role, Sign out
- [ ] Sign out computes to `rgb(220, 38, 38)`
- [ ] Hard refresh on `/admin/audit` stays on Audit Log
- [ ] `/admin/users` highlights only itself in the sidebar
- [ ] Clicking the user icon lands on `/profile` with the sidebar intact
- [ ] Plain `user` typing `/admin` is redirected to `/dashboard`
- [ ] Sign out clears the session; re-visiting `/admin` redirects to `/login`
- [ ] `.env.local` was never committed (`git log --all --full-history -- .env.local` is empty)
- [ ] README updated

## Out of scope

- **A mobile or collapsible sidebar.** Fixed 256px width. A hamburger is a separate task.
- **An icon library.** The user icon is inline SVG. One glyph does not justify a dependency.
- **URL params for the filters inside Documents and Audit.** The sections are routes now; their internal search/filter state is still component state. Worth doing later.
- **Letting admins use Dashboard 1.** Middleware still redirects them to `/admin`, unchanged from today.
- **Touching `DocumentPortal`, `DocumentsTab`, `UsersTab`, or `AuditTab` internals.** They are rendered the same way, only from different parents.
