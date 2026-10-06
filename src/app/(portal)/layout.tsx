import { redirect } from 'next/navigation';
import { getFreshSession } from '@/lib/auth';
import { AppShell } from '@/components/AppShell';

/**
 * Layout for every authenticated page.
 *
 * Owns the single session check and the single shell render, so /dashboard,
 * /profile and /admin/* cannot drift apart. Pages that need the user id (the
 * documents portal, user management, profile) still call getFreshSession() --
 * that is a read, not a second auth decision. Pages that need nothing from the
 * session (the admin documents and audit pages) skip it entirely.
 *
 * A child page's own `if (!user)` guard is not actually dead code, even though
 * this layout already redirects: TypeScript cannot see across the layout
 * boundary, so the check is required for it to compile.
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
