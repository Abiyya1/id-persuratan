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
        <h1 className="text-2xl font-bold text-navy-900">Profil</h1>
        <p className="mt-1 text-sm text-slate-600">
          Perbarui nama pengguna atau ganti kata sandi Anda.
        </p>
      </div>

      <div className="mx-auto max-w-2xl">
        <ProfileForm initialUsername={user.username} role={user.role} />
      </div>
    </>
  );
}
