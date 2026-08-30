import type { PoolClient } from 'pg';

/**
 * FunnelStageEventEmitter — o movimento da tarjeta vira EVENTO de domínio
 * (PEND-14 / DEC-12). Até aqui só o webhook da Talentum emitia
 * `funnel_stage.qualified`; arrastar o card gravava a etapa em silêncio, e a
 * "Luz conectada ao movimento da tarjeta" (Marcel, 26/08) não tinha onde se
 * conectar.
 *
 * Regras:
 *   - só quando a etapa MUDA (mover para a mesma coluna não é evento);
 *   - o INSERT roda no MESMO client da transação do movimento — se a etapa
 *     não gravar, o evento não nasce; se nascer, a etapa gravou;
 *   - nome do evento = `funnel_stage.<etapa em minúsculas>` — QUALIFIED cai no
 *     `QualifiedInterviewHandler` existente, as demais no `StageMessageHandler`;
 *   - o payload leva quem moveu (`actorUid`) e a origem: é a autoria que a
 *     trilha (funnel_stage_message_log) registra.
 * A publicação no Pub/Sub é feita DEPOIS do COMMIT por quem chamou (o evento
 * fica `pending` e a varredura de segurança o reprocessa se a publicação falhar).
 */

/**
 * As 9 etapas do funil — fonte ÚNICA (tupla `as const` para o `z.enum` do
 * OpenAPI e a validação do moveEncuadre usarem a MESMA lista).
 */
export const FUNNEL_STAGES = [
  'INVITED', 'PRE_SCREENING', 'IN_PROGRESS', 'COMPLETED', 'QUALIFIED', 'IN_DOUBT', 'CONFIRMED', 'SELECTED', 'REJECTED',
] as const;

export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export function isFunnelStage(value: unknown): value is FunnelStage {
  return typeof value === 'string' && (FUNNEL_STAGES as readonly string[]).includes(value);
}

export function funnelStageEventName(stage: FunnelStage): string {
  return `funnel_stage.${stage.toLowerCase()}`;
}

export interface EmitFunnelStageEventInput {
  workerId: string;
  jobPostingId: string;
  previousStage: string | null;
  targetStage: FunnelStage;
  actorUid: string | null;
  source: 'kanban';
}

/**
 * Insere o evento (dentro da transação) e devolve o id — ou null quando a
 * etapa não mudou.
 */
export async function emitFunnelStageEvent(
  client: PoolClient,
  input: EmitFunnelStageEventInput,
): Promise<string | null> {
  if (input.previousStage === input.targetStage) return null;
  const result = await client.query<{ id: string }>(
    `INSERT INTO domain_events (event, payload) VALUES ($1, $2::jsonb) RETURNING id`,
    [
      funnelStageEventName(input.targetStage),
      JSON.stringify({
        workerId: input.workerId,
        jobPostingId: input.jobPostingId,
        previousStage: input.previousStage,
        source: input.source,
        actorUid: input.actorUid,
      }),
    ],
  );
  return result.rows[0]?.id ?? null;
}
