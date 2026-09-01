import { useCallback, useRef, useEffect } from 'react';

/**
 * Hook that debounces auto-save calls on blur/change events.
 * Uses a ref for saveFn so it always invokes the latest closure.
 */
export function useAutoSave(
  saveFn: () => Promise<void>,
  delay = 500,
  onError?: (error: unknown) => void,
): () => void {
  const saveFnRef = useRef(saveFn);
  saveFnRef.current = saveFn;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const isSavingRef = useRef(false);
  const pendingSaveRef = useRef(false);

  const executeSave = useCallback(async () => {
    if (isSavingRef.current) {
      pendingSaveRef.current = true;
      return;
    }

    isSavingRef.current = true;
    try {
      await saveFnRef.current();
    } catch (error) {
      console.error('[AutoSave] Failed:', error);
      onErrorRef.current?.(error);
    } finally {
      isSavingRef.current = false;
      if (pendingSaveRef.current) {
        pendingSaveRef.current = false;
        executeSave();
      }
    }
  }, []);

  const triggerSave = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(executeSave, delay);
  }, [executeSave, delay]);

  // Ao desmontar, o save pendente é ENVIADO, não descartado.
  //
  // A versão anterior só fazia `clearTimeout`, e isso perdia dado de verdade: quem
  // mexe num campo e troca de aba (ou fecha a página) dentro da janela de debounce
  // ficava sem gravação nenhuma — sem erro, sem aviso. Como estas telas não têm botão
  // Guardar, o autosave é a ÚNICA chance de persistir; descartá-lo é perder o que a
  // pessoa acabou de digitar.
  //
  // `executeSave` usa refs (nunca estado do componente), então rodar depois do
  // unmount é seguro. O erro é engolido de propósito: não há mais tela para mostrar
  // toast, e deixar a promise rejeitar viraria unhandled rejection.
  useEffect(() => {
    return () => {
      if (!timeoutRef.current) return;
      clearTimeout(timeoutRef.current);
      timeoutRef.current = undefined;
      void executeSave().catch(() => undefined);
    };
  }, [executeSave]);

  return triggerSave;
}
