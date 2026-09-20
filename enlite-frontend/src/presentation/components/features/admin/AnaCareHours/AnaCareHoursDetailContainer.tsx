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
 *  - `onRefresh={refetch}` (16/09) — o botão "Actualizar" do detalhe refaz a MESMA busca do mês
 *    (`useAnaCareHoursPatient` já busca o mês inteiro numa chamada só); navegar de semana NÃO
 *    passa por aqui, é filtro em memória dentro de `AnaCareHoursDetailPage`.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { Text } from '@presentation/components/atoms/Text';
import { useAnaCareHoursPatient } from '@hooks/admin/useAnaCareHoursPatient';
import { useActionGate } from '@presentation/hooks/useCellAccess';
import { AnaCareHoursDetailPage } from './AnaCareHoursDetailPage';
import { AnaCareHoursServiceError, type AnaCareHoursService } from './AnaCareHoursService';
import type { AxonicoComprobanteService } from './AxonicoComprobanteService';
import type { AnaCarePatientDocumentService } from './AnaCarePatientDocumentService';
import type { AnaCareShift, ContestReason } from './types';
import type { BlockReasonMode, SinCheckinHoursMode } from './selectors';

interface AnaCareHoursDetailContainerProps {
  service: AnaCareHoursService;
  /** Serviço do envio ao Axonico (botão "Enviar" de cada dia) — só REPASSADO, este container não chama nem reage a ele. */
  axonicoService: AxonicoComprobanteService;
  /** Serviço do registro de documento do paciente (modal do DNI, 19/09) — só REPASSADO, mesmo padrão de `axonicoService`. */
  patientDocumentService: AnaCarePatientDocumentService;
  month: string;
  patientId: string;
  onBack: () => void;
  sinCheckinHoursMode?: SinCheckinHoursMode;
  blockReasonMode?: BlockReasonMode;
}

export function AnaCareHoursDetailContainer({
  service,
  axonicoService,
  patientDocumentService,
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

  // D3 (revisão de conformidade, 15/09): antes mostrava `err.message`, que é o `code` cru vindo do
  // backend (ex. "JA_VALIDADO") — texto ilegível pro usuário. Agora traduz por CÓDIGO
  // (`error.byCode.<CODE>`), com o texto genérico da tela como fallback do i18n.
  function describeError(err: unknown, fallback: string): string {
    if (!(err instanceof AnaCareHoursServiceError)) return fallback;
    return t(`admin.anacareHours.error.byCode.${err.code}`, fallback);
  }

  // D-cobertura (conserto de conformidade, 15/09): SEM guarda de `validateGate.allowed` aqui — ao
  // contrário de `handleValidateBatch`/`handleContestShift`, este handler só tem UMA porta de
  // entrada (o botão "Validar" da linha, em `DayGroup`/`ShiftRow`), e esse botão já nasce
  // `disabled={disableActions}` no MESMO render em que `validateGate.allowed` é lido — não há
  // modal intermediário nem janela de corrida em que o botão fique habilitado com o gate negado.
  // `disabled` em elemento nativo bloqueia o evento `click` no próprio DOM (medido: `fireEvent
  // .click` num `<button disabled>` não dispara `onClick`), então a guarda era ramo morto —
  // removida em vez de marcada `v8 ignore`, mesmo padrão do comentário D5 em `ShiftRows`.
  async function handleValidateShift(shift: AnaCareShift): Promise<void> {
    try {
      setActionError(null);
      await service.validateShift({ shiftId: shift.id });
      refetch();
    } catch (err) {
      setActionError(describeError(err, t('admin.anacareHours.error.validateShift')));
    }
  }

  // Ao contrário de `handleValidateShift`, ESTA guarda é ALCANÇÁVEL: o botão que abre
  // `ValidateBatchModal` nasce `disabled={disableActions}`, mas o botão "Confirmar" DENTRO do
  // modal não é — se o gate virar negado enquanto o modal já está aberto (ex. permissão
  // revogada em outra aba, refetch de authz), o confirmar chega aqui sem guarda de UI. Testado em
  // AnaCareHoursDetailContainer.test.tsx ("guarda de corrida — lote").
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

  // Mesma corrida de `handleValidateBatch`: o botão que ABRE `ContestModal` é `disabled`, mas o
  // "Confirmar" de dentro do modal só checa `canConfirm` (motivo escolhido, nota dentro do
  // limite) — não o gate. Testado em AnaCareHoursDetailContainer.test.tsx ("guarda de corrida —
  // contestar").
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
        axonicoService={axonicoService}
        patientDocumentService={patientDocumentService}
        onValidateShift={handleValidateShift}
        onValidateBatch={handleValidateBatch}
        onContestShift={handleContestShift}
        onRefresh={refetch}
        sinCheckinHoursMode={sinCheckinHoursMode}
        blockReasonMode={blockReasonMode}
        disableActionsReason={validateGate.denied ? t('admin.anacareHours.error.noValidateCell') : undefined}
      />
    </>
  );
}
