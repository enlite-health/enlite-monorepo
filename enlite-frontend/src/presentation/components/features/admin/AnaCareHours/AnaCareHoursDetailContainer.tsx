/**
 * Container REAL do detalhe — busca via hook (`useAnaCareHoursPatient`) e liga as ações de
 * escrita (validar turno/lote, contestar) ao serviço injetado, com refetch automático após cada
 * uma. Portado de `repos/infra/_worktrees/proto-anacare-horas/.../AnaCareHoursDetailContainer.tsx`
 * com 3 ajustes:
 *  - `validator: Validator` REMOVIDO da prop — quem validou é a sessão autenticada no backend
 *    (contrato HTTP fixo da fase 1), nunca um payload que o front monta.
 *  - `handleContestShift` ganha `reason` (1.5b).
 *  - célula `anacare_hours:validate` (D344) — sem ela, `useActionGate` desabilita
 *    validar/validar-lote/contestar com o motivo visível (mesmo padrão de `useActionGate`/
 *    `ActionButton`, D269 — fail-open só quando o engine ABAC está OFF).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { Text } from '@presentation/components/atoms/Text';
import { useAnaCareHoursPatient } from '@hooks/admin/useAnaCareHoursPatient';
import { useActionGate } from '@presentation/hooks/useCellAccess';
import { AnaCareHoursDetailPage } from './AnaCareHoursDetailPage';
import { AnaCareHoursServiceError, type AnaCareHoursService } from './AnaCareHoursService';
import type { AnaCareShift, ContestReason } from './types';
import type { BlockReasonMode, SinCheckinHoursMode } from './selectors';

interface AnaCareHoursDetailContainerProps {
  service: AnaCareHoursService;
  month: string;
  patientId: string;
  onBack: () => void;
  sinCheckinHoursMode?: SinCheckinHoursMode;
  blockReasonMode?: BlockReasonMode;
}

export function AnaCareHoursDetailContainer({
  service,
  month,
  patientId,
  onBack,
  sinCheckinHoursMode,
  blockReasonMode,
}: AnaCareHoursDetailContainerProps): JSX.Element {
  const { t } = useTranslation();
  const { snapshot, isLoading, error, refetch } = useAnaCareHoursPatient(service, month, patientId);
  const [actionError, setActionError] = useState<string | null>(null);
  const validateGate = useActionGate('anacare_hours', 'validate');

  function describeError(err: unknown, fallback: string): string {
    return err instanceof AnaCareHoursServiceError ? err.message : fallback;
  }

  async function handleValidateShift(shift: AnaCareShift): Promise<void> {
    if (!validateGate.allowed) return;
    try {
      setActionError(null);
      await service.validateShift({ shiftId: shift.id });
      refetch();
    } catch (err) {
      setActionError(describeError(err, t('admin.anacareHours.error.validateShift')));
    }
  }

  async function handleValidateBatch(shiftIds: string[]): Promise<void> {
    if (!validateGate.allowed) return;
    try {
      setActionError(null);
      await service.validateBatch({ shiftIds });
      refetch();
    } catch (err) {
      setActionError(describeError(err, t('admin.anacareHours.error.validateBatch')));
    }
  }

  async function handleContestShift(shiftId: string, reason: ContestReason, note: string): Promise<void> {
    if (!validateGate.allowed) return;
    try {
      setActionError(null);
      await service.contestShift({ shiftId, reason, note: note.trim() ? note.trim() : undefined });
      refetch();
    } catch (err) {
      setActionError(describeError(err, t('admin.anacareHours.error.contestShift')));
    }
  }

  if (isLoading && !snapshot) {
    return (
      <PageContainer>
        <Text color="muted" data-testid="anacare-hours-detail-loading">
          {t('admin.anacareHours.detail.loading')}
        </Text>
      </PageContainer>
    );
  }

  if (error) {
    return (
      <PageContainer>
        <Text className="!text-red-600" data-testid="anacare-hours-detail-error">
          {error === 'FONTE_NAO_CONFIGURADA' ? t('admin.anacareHours.error.sourceNotConfigured') : error}
        </Text>
      </PageContainer>
    );
  }

  if (!snapshot) {
    return <PageContainer>{null}</PageContainer>;
  }

  return (
    <>
      {actionError && (
        <div className="px-6 pt-4">
          <Text className="!text-red-600" data-testid="anacare-hours-action-error">
            {actionError}
          </Text>
        </div>
      )}
      <AnaCareHoursDetailPage
        snapshot={snapshot}
        patientId={patientId}
        onBack={onBack}
        onValidateShift={handleValidateShift}
        onValidateBatch={handleValidateBatch}
        onContestShift={handleContestShift}
        sinCheckinHoursMode={sinCheckinHoursMode}
        blockReasonMode={blockReasonMode}
        disableActionsReason={validateGate.denied ? t('admin.anacareHours.error.noValidateCell') : undefined}
      />
    </>
  );
}
