/**
 * FormModal — UMA modal por container para "novo"/"editar" das telas de obra social (pedido do Gabriel, 058a).
 * Casca centrada no molde das modais da casa (`ContestModal`/`DiscardChangesConfirm`: overlay `bg-black/40` + cartão branco) com o
 * mesmo aviso de descarte dos drawers da ficha do paciente (`useConfirmDiscardClose` + `DiscardChangesConfirm`): fechar por X, Esc,
 * clique fora ou Cancelar com o formulário alterado pergunta; sem alteração fecha direto. Salvar nunca pergunta (o pai desmonta a modal).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { useConfirmDiscardClose } from '@hooks/admin/useConfirmDiscardClose';
import { DiscardChangesConfirm } from '@presentation/components/features/admin/PatientDetail/edit/DiscardChangesConfirm';

/** Modais abertas, da mais antiga à mais nova: só a do topo trata o Esc e ela fica por cima (o "Ir para Dados gerais" abre Dados gerais SOBRE o contrato em edição). */
const openStack: symbol[] = [];

interface Props {
  title: string;
  /** `true` quando o formulário tem alteração não gravada. */
  isDirty: boolean;
  /** Fecha de verdade (o pai desmonta a modal). */
  onClose: () => void;
  /** Durante o envio, nenhuma saída é aceita. */
  busy?: boolean;
  testId: string;
  /** Largura do cartão — classe `max-w-*`. */
  widthClassName?: string;
  /** O conteúdo recebe `requestClose` para o botão Cancelar passar pelo mesmo aviso do X/Esc/fora. */
  children: (requestClose: () => void) => ReactNode;
}

export function FormModal({ title, isDirty, onClose, busy = false, testId, widthClassName = 'max-w-2xl', children }: Props): JSX.Element {
  const { t } = useTranslation();
  const { confirmingClose, requestClose, keepEditing, confirmDiscard } = useConfirmDiscardClose({ isDirty, onConfirmedClose: onClose });
  const guarded = (): void => { if (!busy) requestClose(); };
  const id = useRef(Symbol('form-modal'));
  const [layer] = useState(() => 50 + openStack.length);

  useEffect(() => {
    const mine = id.current;
    openStack.push(mine);
    return () => { openStack.splice(openStack.indexOf(mine), 1); };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !confirmingClose && openStack[openStack.length - 1] === id.current) guarded(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmingClose, busy, isDirty, onClose]);

  return (
    <>
      {confirmingClose && <DiscardChangesConfirm onKeepEditing={keepEditing} onDiscard={confirmDiscard} />}
      <div className="fixed inset-0 flex items-center justify-center bg-black/40 p-4" style={{ zIndex: layer }} data-testid={`${testId}-overlay`} onClick={guarded}>
        <div
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className={`bg-white rounded-2xl shadow-xl w-full ${widthClassName} max-h-[90vh] flex flex-col`}
          data-testid={testId}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-slate-100 shrink-0">
            <Heading level={3} weight="semibold" color="primary">{title}</Heading>
            <button type="button" onClick={guarded} aria-label={t('admin.insuranceProviders.detail.close')} className="text-slate-500 hover:text-slate-800 transition-colors p-1 rounded cursor-pointer" data-testid={`${testId}-close`}>
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="overflow-y-auto px-6 py-5 flex flex-col gap-4">{children(guarded)}</div>
        </div>
      </div>
    </>
  );
}
