/**
 * Botão "Enviar" de UM dia (dentro de `DayGroup`) — lança a prestação do dia no Axonico via
 * `useSendComprobanteToAxonico`. Puramente controlado pelo que o hook devolve, mesmo padrão de
 * `AnaCareHoursSyncButton` (apresentação sem laço/rede aqui).
 *
 * As 4 condições de habilitação (decisão do Gabriel, 19/09) vêm PRONTAS em `eligibility`
 * (`selectors.ts:axonicoDayEligibility`, dono único do cálculo) — este componente só formata,
 * mostrando UMA explicação por motivo ativo (nunca só o primeiro).
 */
import { useTranslation } from 'react-i18next';
import { Button } from '@presentation/components/atoms/Button';
import { Text } from '@presentation/components/atoms/Text';
import { useSendComprobanteToAxonico } from '@hooks/admin/useSendComprobanteToAxonico';
import type { AxonicoComprobanteService, EnviarComprobanteAxonicoCommand } from './AxonicoComprobanteService';
import type { AxonicoBlockReason } from './selectors';

interface AxonicoSendControlProps {
  date: string;
  service: AxonicoComprobanteService;
  eligibility: { eligible: boolean; reasons: AxonicoBlockReason[] };
  command: EnviarComprobanteAxonicoCommand;
  /** Retrato desatualizado / célula ausente — desabilita IGUAL às outras ações do dia, motivo já formatado por quem chama. */
  disableActions: boolean;
}

const REASON_ORDER: AxonicoBlockReason[] = ['notValidated', 'missingCheckInOut', 'fractionalHours', 'missingDocument'];

export function AxonicoSendControl({ date, service, eligibility, command, disableActions }: AxonicoSendControlProps): JSX.Element {
  const { t } = useTranslation();
  const { status, result, error, send } = useSendComprobanteToAxonico(service);
  const isSending = status === 'sending';
  const isDisabled = disableActions || !eligibility.eligible || isSending;

  if (status === 'enviado' && result) {
    return (
      <Text size="xs" className="!text-green-700" data-testid={`anacare-hours-day-sent-${date}`}>
        {t('admin.anacareHours.dayGroup.axonico.sentLabel', { numero: result.numeroComprobante })}
      </Text>
    );
  }

  if (status === 'duplicado' && result) {
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
          onClick={() => send(command)}
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
    </div>
  );
}
