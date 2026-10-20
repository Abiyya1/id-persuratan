'use client';

import { useState, type FormEvent } from 'react';
import { ROLE_LABELS } from './Badges';

/**
 * Username + password editor.
 *
 * The two forms are separate on purpose: changing a password requires the
 * current one, while a username change does not, and mixing them means one
 * field's validation error blocks the other.
 */
export function ProfileForm({
  initialUsername,
  role,
}: {
  initialUsername: string;
  role: string;
}) {
  const [username, setUsername] = useState(initialUsername);
  const [usernameMsg, setUsernameMsg] = useState<{
    kind: 'success' | 'error';
    text: string;
  } | null>(null);
  const [savingUsername, setSavingUsername] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordMsg, setPasswordMsg] = useState<{
    kind: 'success' | 'error';
    text: string;
  } | null>(null);
  const [savingPassword, setSavingPassword] = useState(false);

  async function saveUsername(e: FormEvent) {
    e.preventDefault();
    setUsernameMsg(null);

    const clean = username.trim();
    if (clean === initialUsername) {
      setUsernameMsg({ kind: 'error', text: 'Nama pengguna tersebut sudah Anda gunakan.' });
      return;
    }

    setSavingUsername(true);
    try {
      const res = await fetch('/api/profile/update', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: clean }),
      });

      const data = await res.json();
      setUsernameMsg({
        kind: res.ok ? 'success' : 'error',
        text: res.ok ? 'Nama pengguna diperbarui.' : (data.error ?? 'Tidak dapat memperbarui nama pengguna.'),
      });

      if (res.ok) setUsername(clean);
    } catch {
      setUsernameMsg({ kind: 'error', text: 'Tidak dapat menghubungi server.' });
    } finally {
      setSavingUsername(false);
    }
  }

  async function savePassword(e: FormEvent) {
    e.preventDefault();
    setPasswordMsg(null);

    if (newPassword !== confirmPassword) {
      setPasswordMsg({ kind: 'error', text: 'Konfirmasi kata sandi baru tidak cocok.' });
      return;
    }

    setSavingPassword(true);
    try {
      const res = await fetch('/api/profile/update', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });

      const data = await res.json();

      if (!res.ok) {
        setPasswordMsg({
          kind: 'error',
          text: data.error ?? 'Tidak dapat mengganti kata sandi.',
        });
        return;
      }

      setPasswordMsg({ kind: 'success', text: 'Kata sandi diganti.' });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch {
      setPasswordMsg({ kind: 'error', text: 'Tidak dapat menghubungi server.' });
    } finally {
      setSavingPassword(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* ---- Identity ------------------------------------------------------ */}
      <section className="card p-6">
        <h2 className="text-lg font-semibold text-navy-900">Akun</h2>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-sm text-slate-500">Nama pengguna</dt>
            <dd className="mt-0.5 font-medium text-slate-900">{initialUsername}</dd>
          </div>
          <div>
            <dt className="text-sm text-slate-500">Peran</dt>
            <dd className="mt-0.5 font-medium text-slate-900">{ROLE_LABELS[role] ?? 'Peran tidak dikenal'}</dd>
          </div>
        </dl>
      </section>

      {/* ---- Username ------------------------------------------------------ */}
      <section className="card p-6">
        <h2 className="text-lg font-semibold text-navy-900">Ganti nama pengguna</h2>

        {usernameMsg && (
          <p
            role="status"
            className={`mt-3 rounded-md border p-2.5 text-sm ${
              usernameMsg.kind === 'success'
                ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
                : 'border-red-300 bg-red-50 text-red-800'
            }`}
          >
            {usernameMsg.text}
          </p>
        )}

        <form onSubmit={saveUsername} className="mt-4 space-y-4">
          <div>
            <label htmlFor="new-username" className="label">
              Nama pengguna baru
            </label>
            <input
              id="new-username"
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              maxLength={50}
            />
            <p className="mt-1 text-xs text-slate-500">
              3–50 karakter. Huruf, angka, titik, garis bawah, dan tanda hubung.
            </p>
          </div>

          <button
            type="submit"
            disabled={savingUsername}
            className="btn-primary"
          >
            {savingUsername ? 'Menyimpan...' : 'Perbarui nama pengguna'}
          </button>
        </form>
      </section>

      {/* ---- Password ------------------------------------------------------ */}
      <section className="card p-6">
        <h2 className="text-lg font-semibold text-navy-900">Ganti kata sandi</h2>

        {passwordMsg && (
          <p
            role="status"
            className={`mt-3 rounded-md border p-2.5 text-sm ${
              passwordMsg.kind === 'success'
                ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
                : 'border-red-300 bg-red-50 text-red-800'
            }`}
          >
            {passwordMsg.text}
          </p>
        )}

        <form onSubmit={savePassword} className="mt-4 space-y-4">
          <div>
            <label htmlFor="current-password" className="label">
              Kata sandi saat ini
            </label>
            <input
              id="current-password"
              type="password"
              autoComplete="current-password"
              required
              className="input"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="new-password" className="label">
                Kata sandi baru
              </label>
              <input
                id="new-password"
                type="password"
                autoComplete="new-password"
                required
                className="input"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="confirm-password" className="label">
                Konfirmasi kata sandi baru
              </label>
              <input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                required
                className="input"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>
          </div>

          <p className="text-xs text-slate-500">
            Minimal 8 karakter, dengan huruf dan angka.
          </p>

          <button type="submit" disabled={savingPassword} className="btn-primary">
            {savingPassword ? 'Mengganti...' : 'Ganti kata sandi'}
          </button>
        </form>
      </section>
    </div>
  );
}
