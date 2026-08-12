import { logger } from '@shared/logging';
import type { IPeriskopeTicketService } from '../domain/IPeriskopeTicketService';
import type { PeriskopeGroupNotifyService } from '../infrastructure/PeriskopeGroupNotifyService';

export type HandoverTeam = 'recruitment' | 'community_manager';

export interface NotifyHandoverInput {
  workerPhone: string;
  workerName?: string;
  team: HandoverTeam;
  reason: string;
  conversationId: number;
}

export interface NotifyHandoverResult {
  skipped: boolean;
  groupNotified: boolean;
  ticketCreated: boolean;
}

/** Motivo truncado: o grupo precisa de 1 linha, não do contexto do caso. */
const REASON_MAX = 200;

const TEAM_LABEL: Record<HandoverTeam, string> = {
  recruitment: 'Reclutamiento',
  community_manager: 'Comunidad',
};

/**
 * NotifyHandoverUseCase — quando a Luz faz handover, o time precisa SABER, e o
 * time vive no Periskope (não no Chatwoot). Notificação determinística (sem LLM):
 * 1. mensagem no GRUPO do time no Periskope (canal primário — sempre existe);
 * 2. ticket best-effort no chat 1-1 do candidato (só existe se a org já falou
 *    com ele pelo número do Periskope).
 *
 * Kill-switch `HANDOVER_NOTIFY_ENABLED` (default OFF → prod neutro). Best-effort
 * por contrato: nunca lança; o handover no Chatwoot NUNCA depende disto.
 * PII: telefone/nome vão só na MENSAGEM (grupo interno do time); o log carrega
 * apenas conversationId/team (Ley 25.326 — nunca logar PII).
 */
export class NotifyHandoverUseCase {
  constructor(
    private readonly groupNotify: PeriskopeGroupNotifyService,
    private readonly ticketService: IPeriskopeTicketService,
  ) {}

  async execute(input: NotifyHandoverInput): Promise<NotifyHandoverResult> {
    if (process.env.HANDOVER_NOTIFY_ENABLED !== 'true') {
      return { skipped: true, groupNotified: false, ticketCreated: false };
    }

    const reason =
      input.reason.length > REASON_MAX
        ? `${input.reason.slice(0, REASON_MAX)}…`
        : input.reason;

    const groupId = this.groupIdFor(input.team);
    let groupNotified = false;
    if (groupId) {
      groupNotified = await this.groupNotify.sendToGroup(
        groupId,
        this.buildMessage(input, reason),
      );
    } else {
      logger.warn(
        { team: input.team },
        '[NotifyHandover] no group configured for team — group notify skipped',
      );
    }

    const ticketCreated = await this.ticketService.createTicket(
      input.workerPhone,
      `Handover Luz — ${reason}`.slice(0, 120),
    );

    logger.info(
      {
        conversationId: input.conversationId,
        team: input.team,
        groupNotified,
        ticketCreated,
      },
      '[NotifyHandover] handover_notify',
    );

    return { skipped: false, groupNotified, ticketCreated };
  }

  private groupIdFor(team: HandoverTeam): string | undefined {
    const id =
      team === 'recruitment'
        ? process.env.PERISKOPE_GROUP_RECRUITMENT_ID
        : process.env.PERISKOPE_GROUP_COMMUNITY_ID;
    return id && id.trim() !== '' ? id : undefined;
  }

  private buildMessage(input: NotifyHandoverInput, reason: string): string {
    const lines = [
      `🔁 *Handover de Luz → ${TEAM_LABEL[input.team]}*`,
      `${input.workerName?.trim() || 'Sin nombre'} — ${input.workerPhone}`,
      `Motivo: ${reason}`,
    ];
    const chatwootUrl = process.env.CHATWOOT_URL;
    if (chatwootUrl) {
      lines.push(
        `Conversación: ${chatwootUrl.replace(/\/$/, '')}/app/accounts/1/conversations/${input.conversationId}`,
      );
    }
    lines.push('Responder al candidato desde el número del equipo (no desde este número).');
    return lines.join('\n');
  }
}
