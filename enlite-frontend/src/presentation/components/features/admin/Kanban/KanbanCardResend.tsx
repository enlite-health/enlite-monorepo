/**
 * KanbanCardResend — seção "Reenviar" da tarjeta (REQ-08, planning 26/08): redispara a mensagem
 * da etapa para ESTA pessoa com um clique — antes as recrutadoras arrastavam a tarjeta ida e volta.
 * Mostra o último envio, o motivo quando o backend já sabe que recusaria (D200.1: janela de 24 h,
 * botão nasce desabilitado sem 422) e o feedback de enviado/erro.
 * Extraída do KanbanCard (limite de 400 linhas) — todos os data-testid e textos são os originais.
 */
import { useTranslation } from 'react-i18next';
import { Send } from 'lucide-react';
import { formatLastSent } from './kanbanCardFormat';

export type ResendStatus = 'idle' | 'sending' | 'sent' | 'error';

export interface KanbanCardResendProps {
  onResend: () => void;
  status?: ResendStatus;
  /** Motivo localizado quando o backend recusa (422) ou falha. */
  message?: string | null;
  /** O backend já sabe que o reenvio seria recusado (janela) — botão desabilitado com o porquê. */
  blockedReason?: { code: string; until: string } | null;
  /** ISO do último envio de WhatsApp a esta candidatura (manual ou em lote); null = nunca. */
  lastMessagedAt?: string | null;
}

export function KanbanCardResend({ onResend, status = 'idle', message, blockedReason, lastMessagedAt }: KanbanCardResendProps) {
  const { t } = useTranslation();
  return (
    <div className="mt-2 flex flex-col gap-0.5" data-testid="resend-section">
      <button
        data-testid="resend-button"
        type="button"
        disabled={status === 'sending' || !!blockedReason}
        title={blockedReason ? t(`admin.messaging.blocked.${blockedReason.code}`) : undefined}
        onClick={(e) => {
          e.stopPropagation();
          onResend();
        }}
        className="w-full flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-medium text-emerald-700 hover:bg-emerald-50 transition-colors border border-transparent hover:border-emerald-200 disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:bg-transparent"
      >
        <Send className="w-3 h-3" />
        {status === 'sending' ? t('admin.kanban.resendSending') : t('admin.kanban.resendButton')}
      </button>
      <span data-testid="resend-last-sent" className="px-2 text-[10px] text-slate-500">
        {lastMessagedAt
          ? t('admin.kanban.lastSentAt', { date: formatLastSent(lastMessagedAt) })
          : t('admin.kanban.neverSent')}
      </span>
      {blockedReason && (
        <span data-testid="resend-blocked-reason" className="px-2 text-[10px] text-amber-700">
          {t(`admin.messaging.blocked.${blockedReason.code}`)}{' '}
          {t('admin.kanban.resendBlockedUntil', { date: formatLastSent(blockedReason.until) })}
        </span>
      )}
      {status === 'sent' && (
        <span data-testid="resend-feedback" className="px-2 text-[10px] text-emerald-700">
          {t('admin.kanban.resendDone')}
        </span>
      )}
      {status === 'error' && message && (
        <span data-testid="resend-feedback" role="alert" className="px-2 text-[10px] text-red-600">
          {message}
        </span>
      )}
    </div>
  );
}
