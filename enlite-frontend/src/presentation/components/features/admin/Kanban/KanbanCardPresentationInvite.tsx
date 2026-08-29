/**
 * KanbanCardPresentationInvite — botão "Invitar a reunión de presentación" (REQ-09) na tarjeta e na
 * lista de prestadores. Um clique → convite pelo WhatsApp (a Luz conduz a resposta). Mostra o
 * último convite enfileirado e o motivo quando o sistema pulou (opt-out, já convidada, config…).
 */
import { useTranslation } from 'react-i18next';
import { CalendarClock } from 'lucide-react'; // ícone já usado no KanbanCard (os mocks de lucide dos testes o conhecem)
import { formatLastSent } from './kanbanCardFormat';

export interface PresentationInviteState {
  status: 'idle' | 'sending' | 'queued' | 'skipped' | 'error';
  /** motivo do pulo (skip_reason) ou mensagem de erro */
  detail?: string | null;
}

export interface KanbanCardPresentationInviteProps {
  onInvite: () => void;
  state?: PresentationInviteState;
  lastInvitedAt?: string | null;
  compact?: boolean;
}

export function KanbanCardPresentationInvite({ onInvite, state = { status: 'idle' }, lastInvitedAt, compact = false }: KanbanCardPresentationInviteProps) {
  const { t } = useTranslation();
  const sending = state.status === 'sending';
  return (
    <div className={compact ? 'flex flex-col gap-0.5' : 'mt-1 flex flex-col gap-0.5'} data-testid="presentation-invite-section">
      <button
        data-testid="presentation-invite-button"
        type="button"
        disabled={sending}
        onClick={(e) => { e.stopPropagation(); onInvite(); }}
        className="w-full flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-medium text-indigo-700 hover:bg-indigo-50 transition-colors border border-transparent hover:border-indigo-200 disabled:opacity-60 disabled:cursor-not-allowed"
      >
        <CalendarClock className="w-3 h-3" />
        {sending ? t('admin.presentationInvite.sending') : t('admin.presentationInvite.button')}
      </button>
      <span data-testid="presentation-invite-last" className="px-2 text-[10px] text-slate-500">
        {lastInvitedAt ? t('admin.presentationInvite.lastAt', { date: formatLastSent(lastInvitedAt) }) : t('admin.presentationInvite.never')}
      </span>
      {state.status === 'queued' && (
        <span data-testid="presentation-invite-feedback" className="px-2 text-[10px] text-emerald-700">{t('admin.presentationInvite.queued')}</span>
      )}
      {state.status === 'skipped' && (
        <span data-testid="presentation-invite-feedback" className="px-2 text-[10px] text-amber-700">
          {state.detail ? t(`admin.presentationInvite.skip.${state.detail}`, state.detail) : t('admin.presentationInvite.skip.UNKNOWN')}
        </span>
      )}
      {state.status === 'error' && (
        <span data-testid="presentation-invite-feedback" className="px-2 text-[10px] text-red-600">{state.detail || t('admin.presentationInvite.error')}</span>
      )}
    </div>
  );
}
