import { logger } from '@shared/logging';
import type { IPeriskopeTicketService } from '../domain/IPeriskopeTicketService';
import type { PeriskopeNoteService } from '../infrastructure/PeriskopeNoteService';
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
  /** Nota interna postada no chat 1-1 do candidato (só visível no Periskope). */
  noteCreated: boolean;
}

/** Motivo truncado: o grupo precisa de 1 linha, não do contexto do caso. */
const REASON_MAX = 200;

/**
 * Prefixo do assunto do ticket — é o texto MAIS visível na fila do Periskope.
 *
 * Era `Handover Luz`. Trocado a pedido do Gabriel (02/09/2026): quem trabalha
 * essa fila é o time de recrutamento, que não é técnico, e "handover" é jargão
 * nosso. O nome novo segue o vocabulário que a org já usa em ticket
 * (`Pendiente datos de registro en APP`) e diz o estado da pessoa, não o nome
 * do mecanismo.
 */
const TICKET_SUBJECT_PREFIX = 'Pendiente respuesta del equipo';

/**
 * `4` = Urgent na escala do Periskope (1 Low · 2 Medium · 3 High · 4 Urgent).
 *
 * Sem este campo o ticket nasce em **0**, abaixo de tudo: medido em 02/09/2026,
 * os 22 handovers da Luz dos últimos 30 dias estavam TODOS em `priority 0`,
 * enquanto os tickets criados pelo próprio Periskope usam 1, 2 e 3 — por isso
 * afundavam na fila sem ninguém ver (17 dos 22 seguiam `open`).
 *
 * ⚠️ Escolha deliberada do Gabriel ("o mais urgente possível"): hoje NINGUÉM na
 * org usa 4, então o handover da Luz passa a ficar acima de todo o resto da
 * fila. Se isso virar ruído, o degrau natural é 3.
 */
const TICKET_PRIORITY = '4' as const;

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
    /**
     * Opcional de propósito: sem ele o handover segue igual ao de antes (grupo
     * + ticket). Nota é ADIÇÃO, nunca pré-requisito — se o serviço não estiver
     * configurado (`PERISKOPE_NOTE_AUTHOR` ausente), ele mesmo devolve `false`.
     */
    private readonly noteService?: PeriskopeNoteService,
  ) {}

  async execute(input: NotifyHandoverInput): Promise<NotifyHandoverResult> {
    if (process.env.HANDOVER_NOTIFY_ENABLED !== 'true') {
      return {
        skipped: true,
        groupNotified: false,
        ticketCreated: false,
        noteCreated: false,
      };
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
      `${TICKET_SUBJECT_PREFIX} — ${reason}`.slice(0, 120),
      { priority: TICKET_PRIORITY },
    );

    // Nota interna no chat 1-1 do candidato. É o canal que NÃO passa pelo
    // WhatsApp ("only visible on Periskope, not sent to WhatsApp", doc oficial),
    // então sobrevive ao número do Periskope cair — que é justamente por que o
    // aviso no grupo falha. Carrega o motivo INTEIRO, sem o corte de 200 chars
    // que o ticket e o grupo impõem.
    const noteCreated = this.noteService
      ? await this.noteService.mirrorAsNote(
          input.workerPhone,
          this.buildNote(input),
        )
      : false;

    logger.info(
      {
        conversationId: input.conversationId,
        team: input.team,
        groupNotified,
        ticketCreated,
        noteCreated,
      },
      '[NotifyHandover] handover_notify',
    );

    return { skipped: false, groupNotified, ticketCreated, noteCreated };
  }

  /**
   * Texto da nota interna. Sem link do Chatwoot de propósito: o time de
   * recrutamento não tem acesso a ele (o aviso no grupo manda esse link e ele é
   * morto para quem o recebe). PII (nome/telefone) fica só aqui, no chat da
   * própria pessoa dentro da ferramenta do time — nunca no log.
   */
  private buildNote(input: NotifyHandoverInput): string {
    return [
      `🔔 Luz derivó esta conversación a ${TEAM_LABEL[input.team]}.`,
      `Persona: ${input.workerName?.trim() || 'sin nombre'} — ${input.workerPhone}`,
      `Motivo: ${input.reason}`,
    ].join('\n');
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
