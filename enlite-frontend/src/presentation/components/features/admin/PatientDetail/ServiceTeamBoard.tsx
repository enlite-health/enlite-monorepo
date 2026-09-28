import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { ActionButton } from '@presentation/components/features/access';
import { KanbanBoardShell, type KanbanColumnSpec } from '@presentation/components/features/admin/Kanban/KanbanBoardShell';
import { RejectionReasonSelect } from '@presentation/components/features/admin/Kanban/RejectionReasonSelect';
import { SubstitutionDayModal } from './SubstitutionDayModal';
import {
  SERVICE_TEAM_COLUMN_IDS,
  SERVICE_TEAM_REJECT_REASONS,
  SERVICE_TEAM_REVERT_REASONS,
  type ServiceTeam,
  type ServiceTeamMember,
  type ServiceTeamColumnId,
} from '@domain/entities/ServiceTeam';

interface ServiceTeamBoardProps {
  team: ServiceTeam;
  onReject: (workerId: string, reasonCategory: string) => void;
  onRevert: (workerId: string, reasonCategory: string) => void;
  onSubstitute: (allocationId: string, date: string, substituteWorkerId: string | null) => void;
  actionError: string | null;
}

/** `YYYY-MM-DD` → `DD/MM` (mesma conta de `SubstitutionDayModal.tsx`; sem `Date` do driver). */
function formatDDMM(dateIso: string): string {
  const [, month, day] = dateIso.split('-');
  return `${day}/${month}`;
}

/** Cor do marcador de cada coluna, só por TOKEN do tema (critério 15/27). */
const COLUMN_COLOR: Record<ServiceTeamColumnId, string> = {
  SELECTED_FOR_SERVICE: 'bg-primary',
  IN_SERVICE: 'bg-turquoise',
  REJECTED_FOR_SERVICE: 'bg-cancelled',
};

/** Qual lista de `ServiceTeam` alimenta cada coluna — a MESMA chave da DX-10.8. */
const TEAM_KEY_OF_COLUMN: Record<ServiceTeamColumnId, 'selected' | 'inService' | 'rejected'> = {
  SELECTED_FOR_SERVICE: 'selected',
  IN_SERVICE: 'inService',
  REJECTED_FOR_SERVICE: 'rejected',
};

interface PendingReason {
  kind: 'reject' | 'revert';
  workerId: string;
}

/**
 * Quadro C — DX-10.10 (2). 3 colunas CALCULADAS (nunca uma tabela própria de membros): o time
 * só muda pela ação de rejeitar/reverter, nunca por arrasto — por isso todas as colunas nascem
 * `droppable: false`, `isDragDisabled` é sempre `true` e `onDrop` é no-op. Reusa `KanbanBoardShell`
 * (mecânica das colunas) e `RejectionReasonSelect` (o mesmo modal de motivo do quadro B,
 * generalizado na Fase 4, DX-4.10) — nenhum hook de permissão novo, o gate é o `ActionButton`.
 */
export function ServiceTeamBoard({ team, onReject, onRevert, onSubstitute, actionError }: ServiceTeamBoardProps): JSX.Element {
  const { t } = useTranslation();
  const [pending, setPending] = useState<PendingReason | null>(null);
  const [substitutionMember, setSubstitutionMember] = useState<ServiceTeamMember | null>(null);

  const columns: KanbanColumnSpec[] = SERVICE_TEAM_COLUMN_IDS.map((id) => ({
    id,
    title: t(`admin.patients.detail.serviceTeam.columns.${id}`),
    color: COLUMN_COLOR[id],
    droppable: false,
  }));

  function itemsOf(columnId: string): ServiceTeamMember[] {
    return team[TEAM_KEY_OF_COLUMN[columnId as ServiceTeamColumnId]];
  }

  function handleReasonSubmit(category: string): void {
    if (!pending) return;
    if (pending.kind === 'reject') onReject(pending.workerId, category);
    else onRevert(pending.workerId, category);
    setPending(null);
  }

  return (
    <>
      <KanbanBoardShell<ServiceTeamMember>
        testId="quadro-c-board"
        columns={columns}
        itemsOf={itemsOf}
        getItemId={(member) => member.workerId}
        isDragDisabled={() => true}
        onDrop={() => {}}
        columnWidthClass="w-[250px]"
        renderCard={(member, columnId) => (
          <div
            data-testid={`service-team-card-${member.workerId}`}
            className="bg-white rounded-lg border border-gray-600 p-3 flex flex-col gap-2"
          >
            <Text as="span" size="sm" weight="medium">
              {member.displayName
                ?? t('admin.patients.detail.serviceTeam.unnamedWorker', { shortId: member.workerId.slice(-8) })}
            </Text>
            {columnId === 'REJECTED_FOR_SERVICE' && member.reasonCategory && (
              <Text as="span" size="xs" color="secondary">
                {t(`admin.patients.detail.serviceTeam.rejectOptions.${member.reasonCategory}`, member.reasonCategory)}
              </Text>
            )}
            {columnId === 'IN_SERVICE' && member.substitutionDates && member.substitutionDates.length > 0 && (
              <div data-testid="card-datas-substituicao" className="flex flex-wrap items-center gap-1">
                <Text as="span" size="xs" color="secondary">
                  {t('admin.patients.detail.serviceTeam.substitution.label')}
                </Text>
                {member.substitutionDates.map((date) => (
                  <Text
                    key={date}
                    as="span"
                    size="xs"
                    weight="medium"
                    color="primary"
                    className="rounded-full border border-gray-600 px-2"
                    aria-label={date}
                  >
                    {t('admin.patients.detail.serviceTeam.substitution.dateChip', { date: formatDDMM(date) })}
                  </Text>
                ))}
              </div>
            )}
            {/* Invariante 10: Em Atendimento não tem botão de REJEITAR — a API recusa de qualquer jeito
                (a Fase 13 dá a Em Atendimento o botão de SUBSTITUIR, abaixo — outra ação, outra célula). */}
            {columnId === 'IN_SERVICE' && member.allocations && member.allocations.length > 0 && (
              <ActionButton
                resource="patient_itinerary"
                action="update"
                variant="outline"
                size="sm"
                onClick={() => setSubstitutionMember(member)}
                data-testid={`service-team-substitute-${member.workerId}`}
              >
                {t('admin.patients.detail.serviceTeam.substituteButton')}
              </ActionButton>
            )}
            {columnId === 'SELECTED_FOR_SERVICE' && (
              <ActionButton
                resource="patient_service_team"
                action="update"
                variant="outline"
                size="sm"
                onClick={() => setPending({ kind: 'reject', workerId: member.workerId })}
                data-testid={`service-team-reject-${member.workerId}`}
              >
                {t('admin.patients.detail.serviceTeam.rejectButton')}
              </ActionButton>
            )}
            {columnId === 'REJECTED_FOR_SERVICE' && (
              <ActionButton
                resource="patient_service_team"
                action="update"
                variant="outline"
                size="sm"
                onClick={() => setPending({ kind: 'revert', workerId: member.workerId })}
                data-testid={`service-team-revert-${member.workerId}`}
              >
                {t('admin.patients.detail.serviceTeam.revertButton')}
              </ActionButton>
            )}
          </div>
        )}
      />

      {actionError && (
        <Text
          as="span"
          size="sm"
          role="alert"
          color="inherit"
          className="text-red-600"
          data-testid="quadro-c-acao-erro"
        >
          {t(
            `admin.patients.detail.serviceTeam.actionErrors.${actionError}`,
            t('admin.patients.detail.serviceTeam.actionErrors.generic'),
          )}
        </Text>
      )}

      {pending && (
        <RejectionReasonSelect
          options={pending.kind === 'reject' ? SERVICE_TEAM_REJECT_REASONS : SERVICE_TEAM_REVERT_REASONS}
          titleKey={`admin.patients.detail.serviceTeam.${pending.kind}Modal.title`}
          optionKeyPrefix={`admin.patients.detail.serviceTeam.${pending.kind}Options`}
          confirmKey={`admin.patients.detail.serviceTeam.${pending.kind}Modal.confirm`}
          cancelKey={`admin.patients.detail.serviceTeam.${pending.kind}Modal.cancel`}
          testIdPrefix={`service-team-${pending.kind}`}
          onSubmit={handleReasonSubmit}
          onCancel={() => setPending(null)}
        />
      )}

      {substitutionMember && (
        <SubstitutionDayModal
          allocations={substitutionMember.allocations ?? []}
          selected={team.selected}
          asOf={team.asOf}
          onSubmit={(allocationId, date, substituteWorkerId) => {
            onSubstitute(allocationId, date, substituteWorkerId);
            setSubstitutionMember(null);
          }}
          onCancel={() => setSubstitutionMember(null)}
        />
      )}
    </>
  );
}
