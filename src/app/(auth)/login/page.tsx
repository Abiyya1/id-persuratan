'use client';

import { Suspense, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';

/**
 * Login form.
 *
 * Reads ?reason= from middleware so the pending/rejected/forbidden states
 * surface as an explicit banner. Without the Suspense boundary below,
 * useSearchParams would force the whole page to client-render.
 */
function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const reason = searchParams.get('reason');
  const nextPath = searchParams.get('next');

  // Banner copy for each reason middleware can send.
  const banners: Record<string, string> = {
    pending: 'Akun Anda menunggu persetujuan administrator.',
    rejected: 'Akun Anda ditolak. Hubungi administrator.',
    forbidden: 'Halaman tersebut memerlukan akses administrator.',
  };

  const banner = reason ? banners[reason] : null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? 'Gagal masuk.');
        return;
      }

      // Honour ?next= so a deep link survives the login detour, but never let
      // it become an open redirect -- only same-site paths are allowed.
      const target =
        nextPath && nextPath.startsWith('/') && !nextPath.startsWith('//')
          ? nextPath
          : data.redirectTo ?? '/dashboard';

      router.push(target);
      router.refresh();
    } catch {
      setError('Tidak dapat menghubungi server. Periksa koneksi Anda dan coba lagi.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card animate-fade-in p-8">
      <h1 className="text-xl font-bold text-navy-900">Masuk</h1>
      <p className="mt-1 text-sm text-slate-600">
        Masukkan nama pengguna dan kata sandi untuk mengakses aplikasi.
      </p>

      {banner && (
        <div
          role="status"
          className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
        >
          {banner}
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mt-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800"
        >
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <div>
          <label htmlFor="username" className="label">
            Nama pengguna
          </label>
          <input
            id="username"
            name="username"
            type="text"
            autoComplete="username"
            required
            autoFocus
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>

        <div>
          <label htmlFor="password" className="label">
            Kata sandi
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <button type="submit" disabled={submitting} className="btn-primary w-full">
          {submitting ? 'Sedang masuk...' : 'Masuk'}
        </button>
      </form>

      <p className="mt-6 border-t border-slate-200 pt-4 text-center text-sm text-slate-600">
        Belum punya akun?{' '}
        <Link href="/register" className="font-medium text-navy-700 hover:underline">
          Ajukan akses
        </Link>
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="card p-8">
          <p className="text-center text-sm text-slate-500">Memuat...</p>
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
