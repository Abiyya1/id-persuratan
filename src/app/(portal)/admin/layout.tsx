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
