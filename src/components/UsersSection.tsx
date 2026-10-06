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
