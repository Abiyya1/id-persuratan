'use client';

/**
 * Transient status banner for operation results.
 *
 * Extracted because AdminPortal and UsersTab both rendered the identical
 * block; duplicated markup drifts. Both callers wrap their content in a
 * `space-y-*` stack, which already provides the gap this needs.
 */
export function Toast({
  toast,
  onDismiss,
}: {
  toast: ToastState;
  onDismiss: () => void;
}) {
  if (!toast) return null;

  return (
    <div
      role="status"
      className={`flex items-start justify-between rounded-md border p-3 text-sm ${
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
