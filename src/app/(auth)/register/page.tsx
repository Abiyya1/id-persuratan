'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';

/**
 * Public registration.
 *
 * Success always lands on the same "pending approval" screen -- the server
 * never sets a session for a pending account, so there is nothing to redirect
 * to. The rules shown here are enforced server-side; this is only so the user
 * is not surprised by a rejection.
 */
export default function RegisterPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  // Mirrors validateUsername / validatePasswordStrength on the server.
  const usernameError =
    username.length > 0 && username.length < 3
      ? 'Minimal 3 karakter.'
      : username.length > 0 && !/^[a-zA-Z0-9._-]+$/.test(username)
        ? 'Hanya huruf, angka, titik, garis bawah, dan tanda hubung.'
        : null;

  const passwordError =
    password.length > 0 && password.length < 8
      ? 'Minimal 8 karakter.'
      : password.length > 0 && (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password))
        ? 'Harus mengandung minimal satu huruf dan satu angka.'
        : null;

  const mismatch = confirm.length > 0 && confirm !== password;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    // Fail fast on client-side rules so the obvious mistakes cost no round trip.
    if (usernameError || passwordError || mismatch) return;

    setSubmitting(true);

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? 'Pendaftaran gagal.');
        return;
      }

      setDone(true);
    } catch {
      setError('Tidak dapat menghubungi server. Periksa koneksi Anda dan coba lagi.');
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="card animate-fade-in p-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-2xl">
          ⏳
        </div>
        <h1 className="text-xl font-bold text-navy-900">Pendaftaran diterima</h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-600">
          Akun <span className="font-semibold">{username}</span> menunggu
          persetujuan administrator. Anda dapat masuk setelah akun
          disetujui.
        </p>
        <Link href="/login" className="btn-primary mt-6 w-full">
          Ke halaman masuk
        </Link>
      </div>
    );
  }

  return (
    <div className="card animate-fade-in p-8">
      <h1 className="text-xl font-bold text-navy-900">Ajukan akun</h1>
      <p className="mt-1 text-sm text-slate-600">
        Akun baru memiliki peran <span className="font-medium">Pengguna</span> dan
        memerlukan persetujuan.
      </p>

      {error && (
        <div
          role="alert"
          className="mt-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800"
        >
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="mt-6 space-y-4" noValidate>
        <div>
          <label htmlFor="username" className="label">
            Nama pengguna
          </label>
          <input
            id="username"
            type="text"
            autoComplete="username"
            required
            autoFocus
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            aria-describedby="username-hint"
          />
          <p id="username-hint" className="mt-1 text-xs text-slate-500">
            3–50 karakter. Huruf, angka, titik, garis bawah, dan tanda hubung.
          </p>
          {usernameError && <p className="mt-1 text-xs text-red-600">{usernameError}</p>}
        </div>

        <div>
          <label htmlFor="password" className="label">
            Kata sandi
          </label>
          <input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-describedby="password-hint"
          />
          <p id="password-hint" className="mt-1 text-xs text-slate-500">
            Minimal 8 karakter, dengan huruf dan angka.
          </p>
          {passwordError && <p className="mt-1 text-xs text-red-600">{passwordError}</p>}
        </div>

        <div>
          <label htmlFor="confirm" className="label">
            Konfirmasi kata sandi
          </label>
          <input
            id="confirm"
            type="password"
            autoComplete="new-password"
            required
            className="input"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          {mismatch && <p className="mt-1 text-xs text-red-600">Konfirmasi kata sandi tidak cocok.</p>}
        </div>

        <button
          type="submit"
          disabled={submitting || Boolean(usernameError || passwordError || mismatch)}
          className="btn-primary w-full"
        >
          {submitting ? 'Mengirim...' : 'Kirim pengajuan'}
        </button>
      </form>

      <p className="mt-6 border-t border-slate-200 pt-4 text-center text-sm text-slate-600">
        Akun sudah disetujui?{' '}
        <Link href="/login" className="font-medium text-navy-700 hover:underline">
          Masuk
        </Link>
      </p>
    </div>
  );
}
