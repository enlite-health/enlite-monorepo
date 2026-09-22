import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';

interface SlideOverPanelProps {
  /** Controla se o painel está visível (translate-x-0) ou fora da viewport (translate-x-full). */
  isOpen: boolean;
  /**
   * Fecha de verdade, sem pergunta nenhuma. Chamado por Esc/overlay/botão X quando `onRequestClose`
   * não é passado. Continua sendo o único jeito de fechar quando o conteúdo não tem nada a
   * perder (mantém o comportamento anterior, sem quebrar quem já usa este componente assim).
   */
  onClose: () => void;
  /**
   * Ponto de interceptação (spec 022, T216/T220): quando fornecido, Esc/overlay/botão X chamam
   * ISTO em vez de `onClose` direto — quem fornece decide se pergunta antes de fechar (ex.:
   * rascunho não vazio no `MessageComposer`, via `useConfirmDiscardClose`). Sem esta prop, o
   * comportamento é o de sempre: fecha direto.
   */
  onRequestClose?: () => void;
  /**
   * `false` (default): SEM overlay — o resto da tela continua interativo. É o caso do
   * painel de chat (spec 022): a operadora precisa seguir usando a ficha do paciente
   * com o painel aberto ao lado.
   * `true`: overlay `bg-black/50` bloqueando o resto da tela, como os drawers de edição.
   */
  modal?: boolean;
  children: ReactNode;
  /** `aria-label` do painel (role="dialog"). */
  ariaLabel: string;
  /** Largura do painel — classe Tailwind `max-w-*`. Default `max-w-md`. */
  widthClassName?: string;
  /** `data-testid` do painel; default `slide-over-panel`. */
  testId?: string;
  /**
   * `aria-label` do botão de fechar (X), no canto superior direito do painel. Sem esta prop, o
   * botão NÃO é renderizado (o único caminho de saída continua sendo o Esc, como antes) — quem
   * precisa de um caminho de fechamento explícito (T220) passa esta prop.
   */
  closeAriaLabel?: string;
}

/**
 * Painel deslizante lateral, extraído do CSS repetido em 7 drawers de edição
 * (ver `PatientClinicalEditDrawer.tsx:205-213` e research.md §1 da spec 022).
 *
 * NÃO substitui os 7 drawers existentes — decisão fechada da spec 022 (D-20):
 * a unificação deles é fora de escopo. Este componente nasce para o painel de
 * chat interno por paciente, que precisa do modo não-modal (`modal={false}`).
 */
export function SlideOverPanel({
  isOpen,
  onClose,
  onRequestClose,
  modal = false,
  children,
  ariaLabel,
  widthClassName = 'max-w-md',
  testId = 'slide-over-panel',
  closeAriaLabel,
}: SlideOverPanelProps): JSX.Element {
  const requestClose = onRequestClose ?? onClose;

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, requestClose]);

  return (
    <>
      {modal && (
        <div
          className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-300 ${isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
          onClick={requestClose}
          data-testid={`${testId}-backdrop`}
        />
      )}
      <div
        role="dialog"
        aria-modal={modal}
        aria-label={ariaLabel}
        // 🔒 `h-dvh` (não `h-screen`/`100vh`) — ajustes de UI B5, achado "Enviar cortado embaixo":
        // `100vh` no mobile conta a altura da JANELA inteira, incluindo a área que a barra de
        // endereço do browser ainda pode cobrir — o painel ficava MAIOR que o espaço realmente
        // visível, empurrando o rodapé (compositor) pra fora da tela. `100dvh` (dynamic viewport
        // height, Tailwind >= 3.4, suportado por browsers modernos — admin interno, nunca cliente
        // externo) sempre bate com o que está DE FATO visível.
        className={`fixed top-0 right-0 h-dvh z-50 w-full ${widthClassName} bg-white shadow-2xl rounded-tl-[32px] rounded-bl-[32px] flex flex-col transition-transform duration-300 ease-in-out ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}
        data-testid={testId}
      >
        {closeAriaLabel && (
          <button
            type="button"
            onClick={requestClose}
            aria-label={closeAriaLabel}
            data-testid={`${testId}-close-btn`}
            className="absolute top-3 right-3 z-10 text-slate-400 hover:text-slate-700 transition-colors p-1 rounded"
          >
            <X className="w-5 h-5" />
          </button>
        )}
        {children}
      </div>
    </>
  );
}
