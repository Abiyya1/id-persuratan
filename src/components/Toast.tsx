'use client';

/**
 * Transient status banner for operation results.
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
        aria-label="Tutup pemberitahuan"
      >
        ×
      </button>
    </div>
  );
}

export type ToastState = { kind: 'success' | 'error'; text: string } | null;
