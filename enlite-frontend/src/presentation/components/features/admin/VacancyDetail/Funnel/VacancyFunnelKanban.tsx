import { useCallback, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { KanbanBoard } from '@presentation/components/features/admin/Kanban/KanbanBoard';
import { useWJAFunnel, MoveEncuadreError } from '@hooks/admin/useWJAFunnel';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { InviteBlockedError, blockedReasonMessage } from '@infrastructure/http/AdminMessagingApiService';
import type { EncuadreRole } from '@domain/entities/EncuadreRole';

interface VacancyFunnelKanbanProps {
  vacancyId: string;
}

export function VacancyFunnelKanban({
  vacancyId,
}: VacancyFunnelKanbanProps): JSX.Element {
  const { t } = useTranslation();
  const { data, isLoading, error, refetch, moveEncuadre, rejectBlocked, unrejectBlocked } =
    useWJAFunnel(vacancyId);
  const [moveError, setMoveError] = useState<MoveEncuadreError | null>(null);

  /**
   * ⚠️ Repassar TODOS os argumentos. Função com menos parâmetros é atribuível a um tipo
   * com mais em TypeScript, então esquecer um argumento aqui não gera erro de compilação —
   * ele simplesmente some no caminho. Foi o que aconteceu com o agendamento: o modal
   * coletava data e hora, e o PUT saía sem elas. Só o e2e no navegador pegou.
   */
  const handleMove = useCallback(
    async (
      encuadreId: string,
      targetStage: string,
      rejectionReasonCategory?: string,
      role?: EncuadreRole,
      schedule?: { interviewDate: string; interviewTime: string; interviewMeetLink?: string },
    ) => {
      const err = await moveEncuadre(encuadreId, targetStage, rejectionReasonCategory, role, schedule);
      setMoveError(err);
      return err;
    },
    [moveEncuadre],
  );

  const handleRejectBlocked = useCallback(
    async (blockedId: string, rejectionReasonCategory: string) => {
      const err = await rejectBlocked(blockedId, rejectionReasonCategory);
      setMoveError(err);
      return err;
    },
    [rejectBlocked],
  );

  /**
   * "Reenviar" da tarjeta (REQ-08): mesmo endpoint do convite, com `resend: true`
   * (o backend troca as travas de convite pelo cooldown de reenvio). Recusa 422
   * vira mensagem localizada no card; sucesso recarrega o funil (último envio).
   */
  const handleResendInvite = useCallback(
    async (workerId: string): Promise<string | null> => {
      try {
        await AdminApiService.sendVacancyMatchInvite(workerId, vacancyId, { resend: true });
        await refetch();
        return null;
      } catch (err) {
        if (err instanceof InviteBlockedError) return blockedReasonMessage(err.code, err.detail, t);
        return err instanceof Error && err.message ? err.message : t('admin.messaging.statusErrorFallback');
      }
    },
    [vacancyId, refetch, t],
  );

  const handleUnrejectBlocked = useCallback(
    async (blockedId: string) => {
      const err = await unrejectBlocked(blockedId);
      setMoveError(err);
      return err;
    },
    [unrejectBlocked],
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Sub-header with refresh */}
      <div className="flex items-center justify-between">
        {data && (
          <Text size="xs" color="secondary">
            {data.totalEncuadres} {t('admin.vacancyDetail.funnelView.kanban.totalEncuadres')}
          </Text>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isLoading}
          className="ml-auto"
        >
          <RefreshCw
            className={`w-4 h-4 mr-1.5 ${isLoading ? 'animate-spin' : ''}`}
            aria-hidden="true"
          />
          {t('admin.vacancyDetail.funnelView.kanban.refresh')}
        </Button>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
          <Text size="sm" color="inherit" className="text-red-700">
            {error}
          </Text>
        </div>
      )}

      {/* Move error — bloqueio por elegibilidade ou outro problema */}
      {moveError && (
        <div
          role="alert"
          data-testid="kanban-move-error"
          className="flex items-start gap-3 bg-amber-50 border border-amber-300 rounded-xl p-4"
        >
          <div className="flex-1">
            <Text size="sm" weight="semibold" color="inherit" className="text-amber-900">
              {moveError.code === 'WORKER_NOT_ELIGIBLE'
                ? t('admin.vacancyDetail.funnelView.kanban.workerNotEligibleTitle', {
                    defaultValue: 'No se puede mover este worker',
                  })
                : t('admin.vacancyDetail.funnelView.kanban.moveErrorTitle', {
                    defaultValue: 'No se pudo mover el encuadre',
                  })}
            </Text>
            <Text size="sm" color="inherit" className="text-amber-800 mt-1">
              {moveError.code === 'WORKER_NOT_ELIGIBLE'
                ? t(`admin.vacancyDetail.funnelView.kanban.workerEligibilityReason.${moveError.reason}`, {
                    defaultValue: moveError.workerStatus
                      ? `Worker no apto (status=${moveError.workerStatus}). Cadastro o documentos incompletos.`
                      : 'Worker no apto. Verifique cadastro y documentos.',
                  })
                : moveError.message}
            </Text>
          </div>
          <button
            type="button"
            onClick={() => setMoveError(null)}
            aria-label={t('common.dismiss', { defaultValue: 'Cerrar' })}
            className="text-amber-700 hover:text-amber-900"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Loading */}
      {isLoading && !data && (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      )}

      {/* Board */}
      {data?.stages && (
        <KanbanBoard
          stages={data.stages}
          vacancyId={vacancyId}
          onMove={handleMove}
          onRejectBlocked={handleRejectBlocked}
          onUnrejectBlocked={handleUnrejectBlocked}
          onResendInvite={handleResendInvite}
        />
      )}
    </div>
  );
}
