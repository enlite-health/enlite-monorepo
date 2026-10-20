/**
 * FormModal — UMA modal por container para "novo"/"editar" das telas de obra social (pedido do Gabriel, 058a).
 * Reproduz o molde das modais de FORMULÁRIO da casa (`PatientCreateModal`, `WorkerEditModal`, `VacancyModal`): backdrop `bg-black/50 z-40`
 * com transição de opacidade, painel `max-w-xl` colado à direita (`rounded-l-[32px]`, `shadow-2xl`, desliza), cabeçalho com título + X,
 * corpo rolável (`px-8 py-6`). Diferença pedida: RODAPÉ FIXO com as ações e o erro do envio (sempre visíveis, só o corpo rola).
 * Aviso de descarte = o dos drawers da ficha (`useConfirmDiscardClose` + `DiscardChangesConfirm`): fechar por X, Esc, fora ou Cancelar
 * com o formulário alterado pergunta; sem alteração fecha direto. Salvar nunca pergunta (o pai desmonta a modal).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { useConfirmDiscardClose } from '@hooks/admin/useConfirmDiscardClose';
import { DiscardChangesConfirm } from '@presentation/components/features/admin/PatientDetail/edit/DiscardChangesConfirm';

/** Modais abertas, da mais antiga à mais nova: só a do topo trata o Esc e ela fica por cima (o "Ir para Dados gerais" abre Dados gerais SOBRE o contrato em edição). */
const openStack: symbol[] = [];
const CLOSE_MS = 300;

interface Props {
  title: string;
  /** `true` quando o formulário tem alteração não gravada. */
  isDirty: boolean;
  /** Fecha de verdade (o pai desmonta a modal). */
  onClose: () => void;
  /** Durante o envio, nenhuma saída é aceita. */
  busy?: boolean;
  testId: string;
  /** Corpo rolável. */
  children: ReactNode;
  /** Rodapé fixo: erro do envio + Cancelar/Salvar. Recebe `requestClose` para o Cancelar passar pelo mesmo aviso do X/Esc/fora. */
  footer: (requestClose: () => void) => ReactNode;
}

export function FormModal({ title, isDirty, onClose, busy = false, testId, children, footer }: Props): JSX.Element {
  const { t } = useTranslation();
  const [show, setShow] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const handleClose = useCallback((): void => {
    setShow(false);
    timer.current = setTimeout(onClose, CLOSE_MS);
  }, [onClose]);
  const { confirmingClose, requestClose, keepEditing, confirmDiscard } = useConfirmDiscardClose({ isDirty, onConfirmedClose: handleClose });
  const guarded = (): void => { if (!busy) requestClose(); };
  const id = useRef(Symbol('form-modal'));
  const [layer] = useState(() => openStack.length * 2);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setShow(true));
    return () => { cancelAnimationFrame(raf); clearTimeout(timer.current); };
  }, []);

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
      <div
        className={`fixed inset-0 bg-black/50 transition-opacity duration-300 ${show ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        style={{ zIndex: 40 + layer }}
        onClick={guarded}
        data-testid={`${testId}-overlay`}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`fixed top-0 right-0 h-screen w-full max-w-xl bg-white shadow-2xl rounded-tl-[32px] rounded-bl-[32px] flex flex-col transition-transform duration-300 ease-in-out ${show ? 'translate-x-0' : 'translate-x-full'}`}
        style={{ zIndex: 50 + layer }}
        data-testid={testId}
      >
        <div className="flex items-center justify-between px-8 py-5 border-b border-slate-100 shrink-0">
          <Heading level={3} weight="semibold" color="primary">{title}</Heading>
          <button type="button" onClick={guarded} aria-label={t('admin.insuranceProviders.detail.close')} className="text-slate-400 hover:text-slate-700 transition-colors p-1 rounded cursor-pointer" data-testid={`${testId}-close`}>
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-8 py-6 flex flex-col gap-5">{children}</div>
        <div className="shrink-0 border-t border-slate-100 px-8 py-4 flex flex-col gap-3" data-testid={`${testId}-footer`}>{footer(guarded)}</div>
      </div>
    </>
  );
}
