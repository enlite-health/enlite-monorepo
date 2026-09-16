/**
 * Container REAL do detalhe — busca via hook (`useAnaCareHoursPatient`) e liga as ações de
 * escrita (validar turno/lote, contestar) ao serviço injetado, com refetch automático após cada
 * uma. Porte PRD (`feat/anacare-horas-prd-allowlist`): sem ABAC no `main`, não há célula/gate por
 * ação — a MESMA allowlist de e-mail do backend (`requireAnaCareHoursAllowlist`) já cobre leitura
 * e escrita, então as ações ficam sempre habilitadas aqui; a checagem real é o 403 do servidor.
 * `validator: Validator` também não existe na prop — quem validou é a sessão autenticada no
 * backend (contrato HTTP fixo da fase 1), nunca um payload que o front monta.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { Text } from '@presentation/components/atoms/Text';
import { useAnaCareHoursPatient } from '@hooks/admin/useAnaCareHoursPatient';
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

  // D3 (revisão de conformidade, 15/09): antes mostrava `err.message`, que é o `code` cru vindo do
  // backend (ex. "JA_VALIDADO") — texto ilegível pro usuário. Agora traduz por CÓDIGO
  // (`error.byCode.<CODE>`), com o texto genérico da tela como fallback do i18n.
  function describeError(err: unknown, fallback: string): string {
    if (!(err instanceof AnaCareHoursServiceError)) return fallback;
    return t(`admin.anacareHours.error.byCode.${err.code}`, fallback);
  }

  // D-cobertura (conserto de conformidade, 15/09): SEM guarda de `validateGate.allowed` aqui — ao
  // contrário de `handleValidateBatch`/`handleContestShift`, este handler só tem UMA porta de
  // entrada (o botão "Validar" da linha, em `ProviderGroup`/`ShiftRows`), e esse botão já nasce
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

  async function handleValidateBatch(shiftIds: string[]): Promise<void> {
    try {
      setActionError(null);
      await service.validateBatch({ shiftIds });
      refetch();
    } catch (err) {
      setActionError(describeError(err, t('admin.anacareHours.error.validateBatch')));
    }
  }

  async function handleContestShift(shiftId: string, reason: ContestReason, note: string): Promise<void> {
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
      />
    </>
  );
}
