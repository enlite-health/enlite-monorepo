/**
 * Aviso de vaga publicada quando um campo do serviço contratado que ela lê muda
 * (vaga-le-do-servico-contratado, F3; migration 509 `vacancy_source_change_notices`).
 *
 * A tabela NÃO guarda valor antigo nem novo: o dado tem dona (o serviço) e copiá-lo seria outra fonte.
 * Log: só `{ jobPostingId, field }` — nunca horário, nunca dado de paciente.
 *
 * `recordSourceChange` é o ponto reutilizável: as fases 5 (`providers_needed`) e 6 (`age_range`) chamam o MESMO
 * com o `field` delas. Nesta fase só `schedule` dispara (via `recordScheduleChange`).
 */
import type { Pool, PoolClient } from 'pg';
import { logger } from '@shared/logging';
import { liveVacancySql } from './liveVacancyOfService';

/** Conjunto fechado — o mesmo do CHECK `vscn_field_check` da migration 509. */
export const SOURCE_CHANGE_FIELDS = ['schedule', 'providers_needed', 'age_range'] as const;
export type SourceChangeField = (typeof SOURCE_CHANGE_FIELDS)[number];

export function isSourceChangeField(value: string): value is SourceChangeField {
  return (SOURCE_CHANGE_FIELDS as readonly string[]).includes(value);
}

interface SlotLike {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

/** Forma canônica do horário: slots como texto, ordenados — reenviar o mesmo conteúdo em outra ordem NÃO é mudança. */
function canonicalSchedule(value: unknown): string {
  const slots = (value ?? []) as SlotLike[];
  return slots
    .map((s) => `${s.dayOfWeek}|${s.startTime}|${s.endTime}`)
    .sort()
    .join(';');
}

/**
 * Lê (e trava, `FOR UPDATE`) o horário ATUAL do serviço, na transação do PATCH. `undefined` quando o PATCH não
 * toca o horário (nada a ler). Serviço inexistente → `null` (o UPDATE seguinte falha e a transação desfaz).
 */
export async function captureScheduleBefore(cli: PoolClient, serviceId: string, patched: unknown): Promise<unknown> {
  if (patched === undefined) return undefined;
  const { rows } = await cli.query<{ schedule: unknown }>(
    'SELECT schedule FROM patient_contracted_services WHERE id = $1 FOR UPDATE',
    [serviceId],
  );
  return rows[0]?.schedule ?? null;
}

/** Grava o aviso de `schedule` se (e só se) o horário normalizado mudou. No-op quando o PATCH não toca o horário. */
export async function recordScheduleChange(
  cli: PoolClient,
  serviceId: string,
  before: unknown,
  patched: unknown,
): Promise<void> {
  if (patched === undefined) return;
  if (canonicalSchedule(before) === canonicalSchedule(patched)) return;
  await recordSourceChange(cli, serviceId, 'schedule');
}

/**
 * Uma linha por vaga PUBLICADA e viva do serviço (`is_draft = false`; "viva" = `liveVacancySql`, o vocabulário da F2).
 * Aviso já aberto para (vaga, campo) → só atualiza `changed_at` (índice único parcial `uq_vscn_open_per_vacancy_field`).
 * `cli` TEM de ser o client com identidade da transação do PATCH (`withActorContext`), nunca `connect()` cru.
 */
export async function recordSourceChange(cli: PoolClient, serviceId: string, field: SourceChangeField): Promise<string[]> {
  const { rows } = await cli.query<{ job_posting_id: string }>(
    `INSERT INTO vacancy_source_change_notices (job_posting_id, field)
     SELECT jp.id, $2
       FROM job_postings jp
      WHERE jp.contracted_service_id = $1 AND jp.is_draft = false AND ${liveVacancySql('jp.')}
     ON CONFLICT (job_posting_id, field) WHERE acknowledged_at IS NULL DO UPDATE SET changed_at = now()
     RETURNING job_posting_id`,
    [serviceId, field],
  );
  for (const r of rows) logger.info({ jobPostingId: r.job_posting_id, field }, '[vacancy-source-change] notice recorded');
  return rows.map((r) => r.job_posting_id);
}

/** "Marcar como atendido": fecha o aviso aberto. `false` = não havia aviso aberto (vaga sem aviso ou inexistente). */
export async function acknowledgeNotice(
  db: Pool | PoolClient,
  jobPostingId: string,
  field: SourceChangeField,
  actorUid: string,
): Promise<boolean> {
  const { rows } = await db.query(
    `UPDATE vacancy_source_change_notices SET acknowledged_at = now(), acknowledged_by = $3
      WHERE job_posting_id = $1 AND field = $2 AND acknowledged_at IS NULL
      RETURNING id`,
    [jobPostingId, field, actorUid],
  );
  if (rows.length === 0) return false;
  logger.info({ jobPostingId, field }, '[vacancy-source-change] notice acknowledged');
  return true;
}
