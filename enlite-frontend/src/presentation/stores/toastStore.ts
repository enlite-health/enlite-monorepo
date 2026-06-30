import { create } from 'zustand';

export type ToastType = 'success' | 'error';

export interface Toast {
  id: number;
  /** Chave de deduplicação — toasts com a mesma key se substituem (e o timer reinicia). */
  key: string;
  message: string;
  type: ToastType;
}

interface ToastState {
  toasts: Toast[];
  /**
   * Exibe um toast. Toasts com a mesma `key` se substituem em vez de empilhar
   * — útil para o autosave (salva em cada blur), evitando uma pilha de
   * "guardado con éxito" idênticos. Sem `key`, deduplica por `type:message`.
   */
  showToast: (message: string, type?: ToastType, key?: string) => void;
  dismissToast: (id: number) => void;
}

let counter = 0;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  showToast: (message, type = 'success', key) =>
    set((state) => {
      const dedupeKey = key ?? `${type}:${message}`;
      const remaining = state.toasts.filter((toast) => toast.key !== dedupeKey);
      counter += 1;
      return { toasts: [...remaining, { id: counter, key: dedupeKey, message, type }] };
    }),
  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}));
