/**
 * useUnsavedChangesGuard — fase 4 (`completar-vacante-em-rascunho`, F27).
 *
 * Guarda de saída genérica: sair de um passo com alterações não gravadas pede UMA confirmação;
 * limpo não pergunta; gravou e saiu não pergunta. Sem autosave (decisão do Gabriel, F27).
 *
 * ⚠️ NÃO usa `useBlocker`/`unstable_useBlocker` do react-router: essa API exige um "data router"
 * (`createBrowserRouter` + `RouterProvider`) e lança um invariant error fora desse contexto. Este
 * app monta as rotas com `<BrowserRouter>` puro (`src/presentation/App.tsx:134,295` — única
 * ocorrência de router no app, sem `createBrowserRouter` em lugar nenhum). `useBlocker` quebraria
 * a página inteira em runtime. Plano adaptado (Passo 0 da fase-4.md previa isto como risco): a
 * guarda cobre o que dá para cobrir sem data router —
 *   - `beforeunload` — fechar a aba / recarregar com alteração não gravada (prompt NATIVO do
 *     browser, texto não customizável — é a limitação da própria API).
 *   - `guardedAction` — o botão "Volver" (e qualquer navegação programática própria da tela)
 *     chama isto ANTES de navegar; só essa navegação é interceptada.
 * Navegação por OUTRA rota (ex. um link da sidebar, botão voltar do browser) não é interceptada
 * por este hook — cobri-la exigiria migrar o app inteiro para um data router, fora do escopo desta
 * fase. Ver DESVIOS DO PLANO no fecho.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseUnsavedChangesGuardResult {
  /** Marca o estado observado como tendo alteração não gravada. */
  markDirty: () => void;
  /** Marca o estado observado como limpo (gravado, ou nunca alterado). */
  markClean: () => void;
  /** Roda `action` na hora se limpo; se sujo, abre a confirmação e só roda `action` se o
   *  operador confirmar a saída. */
  guardedAction: (action: () => void) => void;
  /** Se a confirmação deve estar visível. */
  isConfirmOpen: boolean;
  /** Confirma sair sem gravar — roda a ação pendente e fecha a confirmação. */
  confirmDiscard: () => void;
  /** Cancela — continua editando, fecha a confirmação sem rodar a ação pendente. */
  cancelDiscard: () => void;
}

export function useUnsavedChangesGuard(): UseUnsavedChangesGuardResult {
  const isDirtyRef = useRef(false);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const pendingActionRef = useRef<(() => void) | null>(null);

  const markDirty = useCallback(() => {
    isDirtyRef.current = true;
  }, []);

  const markClean = useCallback(() => {
    isDirtyRef.current = false;
  }, []);

  const guardedAction = useCallback((action: () => void) => {
    if (!isDirtyRef.current) {
      action();
      return;
    }
    pendingActionRef.current = action;
    setIsConfirmOpen(true);
  }, []);

  const confirmDiscard = useCallback(() => {
    isDirtyRef.current = false;
    setIsConfirmOpen(false);
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    action?.();
  }, []);

  const cancelDiscard = useCallback(() => {
    setIsConfirmOpen(false);
    pendingActionRef.current = null;
  }, []);

  // Fechar a aba / recarregar com alteração não gravada — prompt nativo do browser.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!isDirtyRef.current) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  return { markDirty, markClean, guardedAction, isConfirmOpen, confirmDiscard, cancelDiscard };
}
