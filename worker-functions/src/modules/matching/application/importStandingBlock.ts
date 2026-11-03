import type { PoolClient } from 'pg';
import { IMPORT_REMINDER_EVENT, decideStandingBlock, type StandingBlockDecision } from '../domain/importBlockPolicy';
import { isHumanReason } from './importNoticeSupport';
import type { AdmissionLogger } from './AdmissionMessagingService';
import type { ImportNaming, ImportSource, ImportSubject } from './ports/ImportPorts';
import type { SubjectTrail } from './ports/PostCallPorts';
import type { TactiqTokenProvider } from './ports/TactiqPorts';

/** Evento da trilha quando o vínculo refeito reabre o item (spec 083, DF-8). `kind` é TEXT livre, sem migration. */
export const IMPORT_REOPENED_EVENT = 'import_reopened';

export interface StandingBlockDeps<S extends ImportSubject> {
  repo: ImportSource<S>;
  events: SubjectTrail;
  tokens: TactiqTokenProvider;
  naming: ImportNaming;
  log: AdmissionLogger;
  /** Transação CURTA (estado + trilha juntos), a mesma do serviço. */
  inTx: <T>(fn: (cli: PoolClient) => Promise<T>) => Promise<T>;
  /**
   * Aviso no app (spec 083, Fase 3): roda DENTRO da transação do lembrete, para o aviso e o evento nascerem ou morrerem juntos.
   * Ausente = no-op.
   */
  onReminder?: (cli: PoolClient, info: { n: number; reason: string; blockedAt: Date; endedAt: Date; subject: S }) => Promise<void>;
}

/**
 * Pré-passo de um item `blocked` por motivo que SÓ uma pessoa resolve (`no_link`/`wrong_account`, spec 083 D-3): decide ANTES de
 * qualquer chamada externa (token, MCP, cofre, Vertex). Só lê a trilha e `tactiq_links`.
 *  - `proceed`: segue o fluxo normal (item reaberto para `waiting`, hora de expirar, ou motivo que não é humano);
 *  - `blocked`: lembrete gravado ou nada a fazer nesta rodada; o chamador devolve `'blocked'` sem tocar em mais nada.
 * Reabrir muda `a.import_status` para `waiting`: se o fluxo bloquear de novo, `setBlocked` vê uma TRANSIÇÃO (1 evento + 1 log) e o
 * contador de lembretes recomeça (ele conta só o que veio depois do último `import_blocked`).
 */
export async function standingHumanBlock<S extends ImportSubject>(
  d: StandingBlockDeps<S>,
  a: S,
  now: Date,
  endedAt: Date,
): Promise<'proceed' | 'blocked'> {
  const last = await d.repo.lastBlockedEvent(a.id);
  const reason = last?.reason;
  if (!last || !isHumanReason(reason)) return 'proceed';
  const [remindersSent, linkedSinceBlock] = await Promise.all([
    d.repo.countRemindersSince(a.id, last.at),
    d.tokens.hasLinkedSince(a.host_email, last.at),
  ]);
  const decision = decideStandingBlock({ now, endedAt, blockedAt: last.at, remindersSent, linkedSinceBlock });
  return applyDecision(d, a, { at: last.at, reason }, { decision, remindersSent, endedAt });
}

type LastBlock = { at: Date; reason: string };

async function applyDecision<S extends ImportSubject>(
  d: StandingBlockDeps<S>,
  a: S,
  last: LastBlock,
  ctx: { decision: StandingBlockDecision; remindersSent: number; endedAt: Date },
): Promise<'proceed' | 'blocked'> {
  switch (ctx.decision) {
    case 'reopen':
      await reopen(d, a);
      return 'proceed';
    case 'expire':
      return 'proceed';
    case 'remind':
      await remind(d, a, last, ctx.remindersSent + 1, ctx.endedAt);
      return 'blocked';
    case 'wait':
      return 'blocked';
    default: {
      const _exhaustive: never = ctx.decision;
      return _exhaustive;
    }
  }
}

async function reopen<S extends ImportSubject>(d: StandingBlockDeps<S>, a: S): Promise<void> {
  await d.inTx(async (cli) => {
    await d.repo.setState(a.id, 'waiting', cli);
    await d.events.append({ appointmentId: a.id, kind: IMPORT_REOPENED_EVENT, outcome: 'waiting', reason: 'link_changed' }, cli);
  });
  a.import_status = 'waiting';
  d.log.info({ [d.naming.idKey]: a.id, reason: 'link_changed' }, `${d.naming.prefix}.import_reopened`);
}

async function remind<S extends ImportSubject>(d: StandingBlockDeps<S>, a: S, last: LastBlock, n: number, endedAt: Date): Promise<void> {
  await d.inTx(async (cli) => {
    await d.events.append({ appointmentId: a.id, kind: IMPORT_REMINDER_EVENT, outcome: 'reminder', reason: last.reason, ref: { n } }, cli);
    await d.onReminder?.(cli, { n, reason: last.reason, blockedAt: last.at, endedAt, subject: a });
  });
  d.log.error({ [d.naming.idKey]: a.id, reason: last.reason, reminder: n }, `${d.naming.prefix}.import_blocked`);
}
