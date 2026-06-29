import { useToastStore } from '@presentation/stores/toastStore';

/**
 * Retorna `showToast(message, type?, key?)` para disparar notificações flutuantes.
 * O `<Toaster />` (montado em App) renderiza e auto-descarta os toasts.
 */
export function useToast(): ReturnType<typeof useToastStore.getState>['showToast'] {
  return useToastStore((state) => state.showToast);
}
