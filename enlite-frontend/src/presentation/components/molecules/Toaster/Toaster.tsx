import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, AlertCircle, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { useToastStore, type Toast } from '@presentation/stores/toastStore';

const AUTO_DISMISS_MS = 3000;

function ToastItem({ toast }: { toast: Toast }): JSX.Element {
  const { t } = useTranslation();
  const dismissToast = useToastStore((state) => state.dismissToast);

  useEffect(() => {
    const timer = setTimeout(() => dismissToast(toast.id), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [toast.id, dismissToast]);

  const isError = toast.type === 'error';
  const Icon = isError ? AlertCircle : CheckCircle2;

  return (
    <div
      role="status"
      data-testid={`toast-${toast.type}`}
      className={`flex items-center gap-2 px-4 py-3 rounded-input shadow-lg border ${
        isError
          ? 'bg-red-50 border-red-200 text-red-700'
          : 'bg-green-50 border-green-200 text-green-700'
      }`}
    >
      <Icon className="w-4 h-4 shrink-0" />
      <Text as="span" size="sm" color="inherit" className="flex-1">
        {toast.message}
      </Text>
      <button
        type="button"
        onClick={() => dismissToast(toast.id)}
        aria-label={t('common.close', 'Cerrar')}
        className="opacity-60 hover:opacity-100 transition-opacity"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

/**
 * Container global de toasts (notificações flutuantes). Renderizado uma vez em
 * App via portal no `document.body`. Os toasts vêm do `toastStore`; cada um se
 * auto-descarta após {@link AUTO_DISMISS_MS}.
 */
export function Toaster(): JSX.Element | null {
  const toasts = useToastStore((state) => state.toasts);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed top-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-2 pointer-events-none [&>*]:pointer-events-auto">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>,
    document.body,
  );
}
