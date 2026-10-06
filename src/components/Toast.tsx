'use client';

/**
 * Transient status banner for operation results.
 *
 * Extracted because AdminPortal and UsersTab both render the identical block;
 * duplicated markup drifts. UsersTab additionally needs a `className` so its
 * toast can carry bottom margin inside the page stack.
 */
export function Toast({
  toast,
  onDismiss,
  className = '',
}: {
  toast: { kind: 'success' | 'error'; text: string } | null;
  onDismiss: () => void;
  className?: string;
}) {
  if (!toast) return null;

  return (
    <div
      role="status"
      className={`flex items-start justify-between rounded-md border p-3 text-sm ${className} ${
        toast.kind === 'success'
          ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
          : 'border-red-300 bg-red-50 text-red-800'
      }`}
    >
      <span>{toast.text}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="ml-3 font-bold opacity-60 hover:opacity-100"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

export type ToastState = { kind: 'success' | 'error'; text: string } | null;
