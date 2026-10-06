'use client';

import { useState, type FormEvent } from 'react';

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
      setUsernameMsg({ kind: 'error', text: 'That is already your username.' });
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
        text: res.ok ? 'Username updated.' : (data.error ?? 'Could not update username.'),
      });

      if (res.ok) setUsername(clean);
    } catch {
      setUsernameMsg({ kind: 'error', text: 'Could not reach the server.' });
    } finally {
      setSavingUsername(false);
    }
  }

  async function savePassword(e: FormEvent) {
    e.preventDefault();
    setPasswordMsg(null);

    if (newPassword !== confirmPassword) {
      setPasswordMsg({ kind: 'error', text: 'New passwords do not match.' });
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
          text: data.error ?? 'Could not change password.',
        });
        return;
      }

      setPasswordMsg({ kind: 'success', text: 'Password changed.' });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch {
      setPasswordMsg({ kind: 'error', text: 'Could not reach the server.' });
    } finally {
      setSavingPassword(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* ---- Identity ------------------------------------------------------ */}
      <section className="card p-6">
        <h2 className="text-lg font-semibold text-navy-900">Account</h2>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-sm text-slate-500">Username</dt>
            <dd className="mt-0.5 font-medium text-slate-900">{initialUsername}</dd>
          </div>
          <div>
            <dt className="text-sm text-slate-500">Role</dt>
            <dd className="mt-0.5 font-medium capitalize text-slate-900">{role}</dd>
          </div>
        </dl>
      </section>

      {/* ---- Username ------------------------------------------------------ */}
      <section className="card p-6">
        <h2 className="text-lg font-semibold text-navy-900">Change username</h2>

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
              New username
            </label>
            <input
              id="new-username"
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              maxLength={50}
            />
            <p className="mt-1 text-xs text-slate-500">
              3-50 characters. Letters, numbers, dot, underscore, hyphen.
            </p>
          </div>

          <button
            type="submit"
            disabled={savingUsername}
            className="btn-primary"
          >
            {savingUsername ? 'Saving...' : 'Update username'}
          </button>
        </form>
      </section>

      {/* ---- Password ------------------------------------------------------ */}
      <section className="card p-6">
        <h2 className="text-lg font-semibold text-navy-900">Change password</h2>

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
              Current password
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
                New password
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
                Confirm new password
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
            At least 8 characters, with a letter and a number.
          </p>

          <button type="submit" disabled={savingPassword} className="btn-primary">
            {savingPassword ? 'Changing...' : 'Change password'}
          </button>
        </form>
      </section>
    </div>
  );
}
