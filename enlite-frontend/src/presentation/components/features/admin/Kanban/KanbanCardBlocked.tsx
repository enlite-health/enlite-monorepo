/**
 * KanbanCardBlocked — a seção do card na coluna BLOQUEADO.
 *
 * Extraída do KanbanCard (limite de 400 linhas do CLAUDE.md) — todos os data-testid
 * e textos existentes são os originais, para não quebrar teste nem e2e.
 *
 * O que muda aqui (D300): o motivo passou a ser recalculado no backend contra o
 * estado de HOJE, então esta seção ganhou um quarto estado — `eligible`, a pessoa
 * cujo registro já está completo. Antes ela aparecia com o rótulo velho ("registro
 * incompleto" / "worker desactivado") e a recrutadora não ligava para ela; medido
 * em produção em 08/09/2026, eram 90 pessoas prontas escondidas assim.
 *
 * `eligible` não é um bloqueio: é a ausência dele. Por isso troca a cor (verde, não
 * vermelho), some com a lista de campos faltantes (não há nenhum) e ganha a ação
 * que resolve o card — promover a tentativa a candidatura real.
 */
import { useTranslation } from 'react-i18next';
import { UserCheck } from 'lucide-react';

/** Estado vivo devolvido pelo backend. `eligible` = passaria no gate agora. */
export type BlockedLiveState =
  | 'worker_not_found'
  | 'registration_incomplete'
  | 'worker_disabled'
  | 'eligible';

export type PromoteStatus = 'idle' | 'promoting' | 'promoted' | 'error';

export interface KanbanCardBlockedProps {
  blockedReason?: string;
  /** Campos que faltam completar — só vêm preenchidos quando o motivo vivo é registro incompleto. */
  missingFields?: string[];
  attemptCount?: number;
  /** Promove ESTE card a candidatura real. Ausente = sem botão (card não elegível, ou sem permissão). */
  onPromote?: () => void;
  promoteStatus?: PromoteStatus;
  /** Motivo localizado quando o backend recusa (409) ou falha. */
  promoteMessage?: string | null;
}

export function KanbanCardBlocked({
  blockedReason,
  missingFields,
  attemptCount,
  onPromote,
  promoteStatus = 'idle',
  promoteMessage,
}: KanbanCardBlockedProps) {
  const { t } = useTranslation();
  const isEligible = blockedReason === 'eligible';

  return (
    <div className="mt-2 flex flex-col gap-1" data-testid="blocked-section">
      <span
        data-testid="blocked-badge"
        className={`inline-block px-1.5 py-0.5 rounded-full text-[10px] font-medium ${
          isEligible ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
        }`}
      >
        {isEligible ? t('admin.kanban.eligibleBadge') : t('admin.kanban.blockedBadge')}
      </span>

      {blockedReason && (
        <span data-testid="blocked-reason" className="text-[10px] text-slate-500">
          {t(`admin.blockedAttempts.reason.${blockedReason}`, { defaultValue: blockedReason })}
        </span>
      )}

      {missingFields && missingFields.length > 0 && (
        <div data-testid="blocked-missing-fields" className="flex flex-wrap gap-1 mt-0.5">
          {missingFields.map((field) => (
            <span
              key={field}
              className="inline-block px-1 py-0.5 rounded text-[9px] font-medium bg-amber-50 text-amber-700"
            >
              {t(`admin.blockedAttempts.missingField.${field}`, { defaultValue: field })}
            </span>
          ))}
        </div>
      )}

      {attemptCount !== undefined && attemptCount > 0 && (
        <span data-testid="blocked-attempt-count" className="text-[10px] text-slate-400">
          {t('admin.kanban.blockedAttemptCount', { count: attemptCount })}
        </span>
      )}

      {isEligible && onPromote && (
        <>
          <button
            data-testid="promote-button"
            type="button"
            disabled={promoteStatus === 'promoting' || promoteStatus === 'promoted'}
            onClick={(e) => {
              e.stopPropagation();
              onPromote();
            }}
            className="mt-1 w-full flex items-center justify-center gap-1 px-2 py-1 rounded-lg text-[10px] font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <UserCheck className="w-3 h-3" />
            {t(`admin.kanban.promote.${promoteStatus}`)}
          </button>
          {promoteMessage && (
            <span data-testid="promote-message" className="text-[10px] text-red-600">
              {promoteMessage}
            </span>
          )}
        </>
      )}
    </div>
  );
}
