import { useCallback, useState } from 'react';

interface UseConfirmDiscardCloseArgs {
  /** true quando o formulário do drawer tem mudança não salva. */
  isDirty: boolean;
  /** Fecha o drawer de verdade (a mesma função que já existia antes desta hook — animação +
   * timeout + `onClose` do pai). Chamado direto pelo SALVAR (nunca pergunta) e por
   * `confirmDiscard` (o usuário confirmou que quer perder a mudança). */
  onConfirmedClose: () => void;
}

interface UseConfirmDiscardCloseResult {
  /** true quando a confirmação "¿Descartar los cambios?" está sendo exibida. */
  confirmingClose: boolean;
  /** Pedido de fechar vindo de Esc / backdrop / botão X — NUNCA do Salvar. Fecha direto se
   * `isDirty` for false; se `isDirty` for true, abre a confirmação em vez de fechar. */
  requestClose: () => void;
  /** "Seguir editando" — fecha só a confirmação, o drawer continua aberto, nada é descartado. */
  keepEditing: () => void;
  /** "Descartar cambios" — fecha a confirmação E o drawer (chama `onConfirmedClose`). */
  confirmDiscard: () => void;
  /** Passthrough — usado pelo caller para o fluxo de SALVAR, que nunca pergunta. */
  onConfirmedClose: () => void;
}

/**
 * Spec 014 (US-D4, lex D4 AUTORIZADO sem condição): drawers de edição da ficha não perdem
 * trabalho — fechar por Esc/backdrop/X com o formulário `dirty` pede confirmação; sem mudança
 * fecha direto; salvar nunca pergunta. Extraído UMA vez (grep dos 8 drawers de edição em
 * `PatientDetail/edit/` — todos repetiam o MESMO padrão de `handleClose` ligado a Esc/backdrop/X)
 * em vez de copiar a lógica em cada um.
 */
export function useConfirmDiscardClose({
  isDirty,
  onConfirmedClose,
}: UseConfirmDiscardCloseArgs): UseConfirmDiscardCloseResult {
  const [confirmingClose, setConfirmingClose] = useState(false);

  const requestClose = useCallback((): void => {
    if (isDirty) {
      setConfirmingClose(true);
      return;
    }
    onConfirmedClose();
  }, [isDirty, onConfirmedClose]);

  const keepEditing = useCallback((): void => {
    setConfirmingClose(false);
  }, []);

  const confirmDiscard = useCallback((): void => {
    setConfirmingClose(false);
    onConfirmedClose();
  }, [onConfirmedClose]);

  return { confirmingClose, requestClose, keepEditing, confirmDiscard, onConfirmedClose };
}
