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
