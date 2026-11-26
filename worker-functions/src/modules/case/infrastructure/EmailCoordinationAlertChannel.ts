import { EmailChannelUnavailableError, EmailService } from '@modules/identity/infrastructure/EmailService';
import type { AlertRecipient, AlertToDeliver, CoordinationAlertChannel, DeliveryOutcome } from '../application/ports/CoordinationAlertPorts';

/** Código de erro sem PII: só `code`/`name` do erro, nunca a mensagem (o SendGrid pode ecoar o endereço). */
function errorCodeOf(err: unknown): string {
  const e = err as { code?: unknown; name?: unknown };
  return String(typeof e.code === 'string' || typeof e.code === 'number' ? e.code : e.name ?? 'EMAIL_ERROR').slice(0, 64);
}

/**
 * Canal e-mail: só data, hora e link da fila (`/admin/presencia/revision`). SEM nome de prestador ou paciente, endereço ou dado clínico (o texto
 * mora no `EmailService.sendCoordinationAlert`, que só recebe o tipo, a data e a hora). O `EmailService` já barra teste/sem chave: vira
 * `SKIPPED_*`, não falha. Nunca lança: o resultado é o `DeliveryOutcome` (falha de e-mail não desfaz a in-app).
 */
export class EmailCoordinationAlertChannel implements CoordinationAlertChannel {
  readonly channel = 'EMAIL' as const;

  constructor(private readonly email: Pick<EmailService, 'sendCoordinationAlert'> = new EmailService()) {}

  async deliver(alert: AlertToDeliver, recipient: AlertRecipient): Promise<DeliveryOutcome> {
    if (!recipient.email) return { status: 'NO_ADDRESS' };
    const s = alert.shift;
    try {
      await this.email.sendCoordinationAlert(recipient.email, { kind: alert.kind, onDate: s.onDate, time: alert.kind === 'PRESENCE_OPEN_4H' ? s.endTime : s.startTime, country: s.country });
      return { status: 'SENT' };
    } catch (err) {
      if (err instanceof EmailChannelUnavailableError) return { status: err.motivo === 'ambiente de teste' ? 'SKIPPED_TEST' : 'SKIPPED_NO_KEY' };
      return { status: 'FAILED', errorCode: errorCodeOf(err) };
    }
  }
}
