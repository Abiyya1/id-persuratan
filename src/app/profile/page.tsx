import { redirect } from 'next/navigation';
import { getFreshSession } from '@/lib/auth';
import { AppNav } from '@/components/AppNav';
import { ProfileForm } from '@/components/ProfileForm';

/**
 * Profile settings for every authenticated role: change username and password.
 */
export default async function ProfilePage() {
  const user = await getFreshSession();
  if (!user) redirect('/login');

  return (
    <div className="min-h-screen">
      <AppNav user={user} active="profile" />

      <main className="mx-auto max-w-2xl px-4 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-navy-900">Profile</h1>
          <p className="mt-1 text-sm text-slate-600">
            Update your username or change your password.
          </p>
        </div>

        <ProfileForm
          initialUsername={user.username}
          role={user.role}
        />
      </main>
    </div>
  );
}
