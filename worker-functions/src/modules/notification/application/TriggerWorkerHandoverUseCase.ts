import { Pool } from 'pg';
import { IMessagingService } from '../domain/IMessagingService';
import { IPeriskopeTicketService } from '../domain/IPeriskopeTicketService';
import { Result } from '@shared/utils/Result';
import { logger } from '@shared/logging';

const TWILIO_HANDOVER_SLUG = 'handover_seguimos_por_aca';
const PERISKOPE_HANDOVER_SLUG = 'handover_primer_saludo';

export interface TriggerWorkerHandoverResult {
  workerId: string;
  /** false quando o guard idempotente abortou (worker já não estava em 'twilio'). */
  flipped: boolean;
  twilioSent: boolean;
  periskopeSent: boolean;
  ticketCreated: boolean;
}

/**
 * TriggerWorkerHandoverUseCase — handover Twilio → Periskope de um worker frio.
 *
 * Disparado por InboundWhatsAppController quando o worker manda o 1º texto
 * livre não-roteável (flag PERISKOPE_HANDOVER_ENABLED) e seu
 * messaging_channel ainda é 'twilio'.
 *
 * Fluxo:
 *   1. UPDATE guard idempotente/anti-race — só flipa messaging_channel se
 *      ainda for 'twilio'. rowCount=0 (já flipado por outra requisição
 *      concorrente, ou race) → aborta silenciosamente, nenhum envio.
 *   2. Envia template de despedida via Twilio concreto (best-effort: se o
 *      template ainda não existe no banco — será criado via CRUD admin —
 *      apenas loga warning e SEGUE, não aborta o handover).
 *   3. Envia template de boas-vindas via Periskope concreto (mesma tolerância).
 *   4. Cria ticket no Periskope via IPeriskopeTicketService (best-effort por
 *      contrato — nunca lança, retorna boolean).
 *
 * Injeta os DOIS concretos explicitamente (Twilio + Periskope), NÃO o
 * RoutingMessagingService — parecer do Architect: o handover precisa
 * garantir que AMBAS as mensagens saiam pelos canais corretos,
 * independente do messaging_channel do worker já ter sido flipado no passo 1.
 */
export class TriggerWorkerHandoverUseCase {
  constructor(
    private readonly db: Pool,
    private readonly twilioMessaging: IMessagingService,
    private readonly periskopeMessaging: IMessagingService,
    private readonly ticketService: IPeriskopeTicketService,
  ) {}

  async execute(workerId: string, phone: string): Promise<Result<TriggerWorkerHandoverResult>> {
    const log = logger.child({ workerId, useCase: 'TriggerWorkerHandover' });

    const flipResult = await this.db.query<{ id: string }>(
      `UPDATE workers
       SET messaging_channel = 'periskope'
       WHERE id = $1 AND messaging_channel = 'twilio'
       RETURNING id`,
      [workerId],
    );

    if (flipResult.rowCount === 0) {
      log.info('Handover skip — worker já não está em twilio (idempotente/race)');
      return Result.ok<TriggerWorkerHandoverResult>({
        workerId,
        flipped: false,
        twilioSent: false,
        periskopeSent: false,
        ticketCreated: false,
      });
    }

    log.info('Worker flipped twilio -> periskope');

    const twilioResult = await this.twilioMessaging.sendWhatsApp({
      to: phone,
      templateSlug: TWILIO_HANDOVER_SLUG,
    });
    if (twilioResult.isFailure) {
      log.warn({ error: twilioResult.error }, 'Handover: falha ao enviar template Twilio — segue mesmo assim');
    }

    const periskopeResult = await this.periskopeMessaging.sendWhatsApp({
      to: phone,
      templateSlug: PERISKOPE_HANDOVER_SLUG,
    });
    if (periskopeResult.isFailure) {
      log.warn({ error: periskopeResult.error }, 'Handover: falha ao enviar template Periskope — segue mesmo assim');
    }

    // TODO: assignee deve receber o nome da recrutadora quando o round-robin
    // de atribuição for definido pelo produto — hoje sempre ausente.
    const ticketCreated = await this.ticketService.createTicket(phone, `Handover — worker ${workerId}`);
    if (!ticketCreated) {
      log.warn('Handover: falha ao criar ticket Periskope (best-effort, não bloqueia)');
    }

    return Result.ok<TriggerWorkerHandoverResult>({
      workerId,
      flipped: true,
      twilioSent: twilioResult.isSuccess,
      periskopeSent: periskopeResult.isSuccess,
      ticketCreated,
    });
  }
}
