/**
 * Botão "Enviar" de UM dia (dentro de `DayGroup`) — lança a prestação do dia no Axonico via
 * `useSendComprobanteToAxonico`. Puramente controlado pelo que o hook devolve, mesmo padrão de
 * `AnaCareHoursSyncButton` (apresentação sem laço/rede aqui).
 *
 * As 4 condições de habilitação (decisão do Gabriel, 19/09) vêm PRONTAS em `eligibility`
 * (`selectors.ts:axonicoDayEligibility`, dono único do cálculo) — este componente só formata,
 * mostrando UMA explicação por motivo ativo (nunca só o primeiro).
 *
 * ⚠️ Exceção a essa leitura direta (decisão do Gabriel, 19/09, pedido literal: "se o paciente NÃO
 * TIVER DNI, ao clicar em Enviar, perguntar e registrar; depois disso não perguntar mais"): o botão
 * fica HABILITADO quando as reasons DIFERENTES de `missingDocument` estão vazias — `notValidated`,
 * `missingCheckInOut` e `fractionalHours` continuam bloqueando de verdade. Se a ÚNICA razão for
 * `missingDocument`, o clique abre `AxonicoDocumentModal` em vez de enviar direto; confirmar ali
 * registra o documento (`useRegisterAnaCarePatientDocument`) e, só depois de registrado, encadeia
 * o `send()` com o documento recém-digitado (nunca com `command.documentNumber`, que ainda reflete
 * o snapshot ANTIGO até o `onDocumentRegistered` — refetch do mês — terminar).
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@presentation/components/atoms/Button';
import { Text } from '@presentation/components/atoms/Text';
import { useSendComprobanteToAxonico } from '@hooks/admin/useSendComprobanteToAxonico';
import { useRegisterAnaCarePatientDocument } from '@hooks/admin/useRegisterAnaCarePatientDocument';
import { AxonicoDocumentModal } from './AxonicoDocumentModal';
import type { AxonicoComprobanteService, EnviarComprobanteAxonicoCommand } from './AxonicoComprobanteService';
import type { AnaCarePatientDocumentService } from './AnaCarePatientDocumentService';
import type { AxonicoBlockReason } from './selectors';

interface AxonicoSendControlProps {
  date: string;
  service: AxonicoComprobanteService;
  /** Serviço do registro de documento do paciente (modal aberto quando falta DNI) — domínio diferente do envio ao Axonico. */
  patientDocumentService: AnaCarePatientDocumentService;
  /** ↔ `AnaCarePatient.anaCareId` — obrigatório pra registrar o documento (corpo da rota exige `anaCarePatientId`). */
  anaCarePatientId: string;
  eligibility: { eligible: boolean; reasons: AxonicoBlockReason[] };
  command: EnviarComprobanteAxonicoCommand;
  /** Retrato desatualizado / célula ausente — desabilita IGUAL às outras ações do dia, motivo já formatado por quem chama. */
  disableActions: boolean;
  /** Chamado depois que o documento é registrado com sucesso — pai refaz a busca do mês (D19/09: "não perguntar mais" exige o documento aparecer no snapshot). Ausente = só o envio encadeado acontece, sem refetch. */
  onDocumentRegistered?: () => void;
}

const REASON_ORDER: AxonicoBlockReason[] = ['notValidated', 'missingCheckInOut', 'fractionalHours', 'missingDocument'];

export function AxonicoSendControl({
  date,
  service,
  patientDocumentService,
  anaCarePatientId,
  eligibility,
  command,
  disableActions,
  onDocumentRegistered,
}: AxonicoSendControlProps): JSX.Element {
  const { t } = useTranslation();
  const { status, result, error, send } = useSendComprobanteToAxonico(service);
  const { status: registerStatus, errorCode: registerErrorCode, register } = useRegisterAnaCarePatientDocument(patientDocumentService);
  const [isDocumentModalOpen, setIsDocumentModalOpen] = useState(false);
  const [pendingDocumentNumber, setPendingDocumentNumber] = useState<string | null>(null);
  const isSending = status === 'sending';
  const isRegistering = registerStatus === 'registering';
  const missingDocument = eligibility.reasons.includes('missingDocument');
  const blockedByOtherReasons = eligibility.reasons.some((reason) => reason !== 'missingDocument');
  const isDisabled = disableActions || blockedByOtherReasons || isSending;

  // Encadeamento (D19/09): só dispara o `send()` depois que ESTE registro (o que o modal acabou
  // de confirmar) termina — `pendingDocumentNumber` é o guard, nunca reage a um `registrado` de
  // uma corrida anterior que por algum motivo ainda estivesse no estado do hook.
  useEffect(() => {
    if (registerStatus !== 'registrado' || pendingDocumentNumber === null) return;
    setIsDocumentModalOpen(false);
    send({ ...command, documentNumber: pendingDocumentNumber });
    onDocumentRegistered?.();
    setPendingDocumentNumber(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerStatus, pendingDocumentNumber]);

  function handleSendClick(): void {
    if (missingDocument) {
      setIsDocumentModalOpen(true);
      return;
    }
    send(command);
  }

  function handleConfirmDocument(documentNumber: string): void {
    setPendingDocumentNumber(documentNumber);
    register({ anaCarePatientId, documentNumber });
  }

  if (status === 'enviado' && result) {
    return (
      <Text size="xs" className="!text-green-700" data-testid={`anacare-hours-day-sent-${date}`}>
        {t('admin.anacareHours.dayGroup.axonico.sentLabel', { numero: result.numeroComprobante })}
      </Text>
    );
  }

  if (status === 'duplicado' && result) {
    // Dedupe REMOTO (guard 4 do use case): o comprovante foi criado FORA do nosso registro e
    // `numeroComprobante` vem `null` — nunca interpolar `null`/`undefined` no DOM. `jaFaturado`
    // segue `true` (FOI faturado); a mensagem tem de deixar isso claro sem sugerir relançamento.
    if (result.numeroComprobante === null) {
      return (
        <Text size="xs" color="muted" data-testid={`anacare-hours-day-duplicated-no-comprobante-${date}`}>
          {t('admin.anacareHours.dayGroup.axonico.duplicatedNoComprobanteLabel')}
        </Text>
      );
    }
    return (
      <Text size="xs" color="muted" data-testid={`anacare-hours-day-duplicated-${date}`}>
        {t('admin.anacareHours.dayGroup.axonico.duplicatedLabel', { numero: result.numeroComprobante })}
      </Text>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={isDisabled}
          isLoading={isSending}
          onClick={handleSendClick}
          data-testid={`anacare-hours-send-day-${date}`}
        >
          {t('admin.anacareHours.dayGroup.sendAction')}
        </Button>
      </div>
      {!disableActions &&
        !eligibility.eligible &&
        REASON_ORDER.filter((reason) => eligibility.reasons.includes(reason)).map((reason) => (
          <Text key={reason} size="xs" className="!text-amber-700" data-testid={`anacare-hours-axonico-reason-${reason}-${date}`}>
            {t(`admin.anacareHours.dayGroup.axonico.reasons.${reason}`)}
          </Text>
        ))}
      {status === 'error' && error && (
        <Text size="xs" className="!text-red-600" data-testid={`anacare-hours-day-send-error-${date}`}>
          {error}
        </Text>
      )}
      {isDocumentModalOpen && (
        <AxonicoDocumentModal
          isSubmitting={isRegistering}
          errorCode={registerStatus === 'error' ? registerErrorCode : null}
          onConfirm={handleConfirmDocument}
          onCancel={() => setIsDocumentModalOpen(false)}
        />
      )}
    </div>
  );
}
