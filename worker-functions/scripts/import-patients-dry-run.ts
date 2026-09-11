/**
 * import-patients-dry-run.ts
 *
 * Dry-run helpers for import-patients-from-clickup.ts.
 * Extracted to keep the main script within the 400-line limit.
 *
 * In dry-run mode the UseCase is never called (it would write to DB).
 * Instead, this module replicates the skip logic and classifies each task
 * as would-create / would-update based on a pre-fetched existingIds set.
 *
 * C1 do parecer do lex (11/09/2026): esta ferramenta roda DENTRO de sessões do Claude — o
 * stdout entra no CONTEXTO do LLM. Texto clínico e PII (nome, especialidade, dependência,
 * responsável) NUNCA podem aparecer aqui, nem em `--verbose`. Em TODO modo, só nome de campo +
 * presença/tamanho (nunca o valor) + ids de task/paciente + contagens.
 */

/* eslint-disable no-console */

import { Pool } from 'pg';
import type { ClickUpTask } from '../src/modules/integration/infrastructure/clickup/ClickUpTask';
import type { ClickUpPatientMapper } from '../src/modules/integration/infrastructure/clickup/ClickUpPatientMapper';
import { classifyMapperNullReason } from '../src/modules/integration/application/SyncPatientFromClickUpTaskUseCase';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DryRunCounters {
  processed: number;
  skippedNoName: number;
  skippedSubtask: number;
  skippedMapper: number;
  wouldCreate: number;
  wouldUpdate: number;
}

// ── DB helper ─────────────────────────────────────────────────────────────────

export async function checkExistingTaskIds(
  pool: Pool,
  taskIds: string[],
): Promise<Set<string>> {
  if (taskIds.length === 0) return new Set();
  const { rows } = await pool.query<{ clickup_task_id: string }>(
    `SELECT clickup_task_id FROM patients WHERE clickup_task_id = ANY($1)`,
    [taskIds],
  );
  return new Set(rows.map(r => r.clickup_task_id));
}

// ── Redação (C1 do parecer do lex) ───────────────────────────────────────────────

/**
 * Nome do campo + presença/tamanho — NUNCA o valor. `string` vira `presente(len=N)`, array vira
 * `presente(n=N)`, objeto/número/booleano viram `presente` (não há como vazar dado num booleano
 * de presença). `null`/`undefined` vira `ausente`. Usado tanto pela linha padrão (sempre
 * impressa) quanto por `--verbose` — as DUAS eram os dois achados do gate (item 2 e item 5).
 */
function presenca(value: unknown): string {
  if (value === null || value === undefined) return 'ausente';
  if (Array.isArray(value)) return `presente(n=${value.length})`;
  if (typeof value === 'string') return `presente(len=${value.length})`;
  return 'presente';
}

/** `--verbose`: nome de CADA campo do payload mapeado + presença/tamanho — nunca o valor
 *  (substituiu `JSON.stringify(input)`, que vazava diagnóstico/nome/especialidade em texto
 *  livre — achado do gate, item 2). */
function resumoDeCamposRedigido(input: Record<string, unknown>): string {
  return Object.entries(input)
    .map(([campo, valor]) => `${campo}:${presenca(valor)}`)
    .join(', ');
}

// ── Per-task processor ────────────────────────────────────────────────────────

export function processDryRun(
  task: ClickUpTask,
  i: number,
  total: number,
  mapper: ClickUpPatientMapper,
  existingIds: Set<string>,
  counters: DryRunCounters,
  isVerbose: boolean,
): void {
  const num = `[${i + 1}/${total}]`;

  if (task.parent !== null) {
    counters.skippedSubtask++;
    return;
  }

  let input: ReturnType<ClickUpPatientMapper['map']>;
  try {
    input = mapper.map(task);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ERROR  task=${task.id} msg=mapper threw: ${msg}`);
    return;
  }

  if (input === null) {
    const reason = classifyMapperNullReason(task);
    if (reason === 'SKIPPED_NO_PATIENT_NAME') {
      console.log(`  ${num} task=${task.id} status=${task.status.status} → SKIPPED (no patient name)`);
      counters.skippedNoName++;
    } else {
      console.log(`  ${num} task=${task.id} status=${task.status.status} → SKIPPED (mapper returned null)`);
      counters.skippedMapper++;
    }
    return;
  }

  counters.processed++;

  const isUpdate = existingIds.has(task.id);
  if (isUpdate) counters.wouldUpdate++; else counters.wouldCreate++;

  const action = existingIds.size > 0
    ? (isUpdate ? 'would UPDATE' : 'would CREATE')
    : 'would UPSERT';

  // C1 do parecer do lex: nunca nome, especialidade, dependência ou responsável em texto —
  // só presença. `input.responsibles` é uma lista; a presença de ALGUM responsável basta.
  const resumo = [
    `hasFirstName=${presenca(input.firstName) !== 'ausente'}`,
    `hasLastName=${presenca(input.lastName) !== 'ausente'}`,
    `hasDependency=${presenca(input.dependencyLevel) !== 'ausente'}`,
    `serviceTypeCount=${input.serviceType?.length ?? 0}`,
    `hasSpecialty=${presenca(input.clinicalSpecialty) !== 'ausente'}`,
    `hasResponsible=${(input.responsibles?.length ?? 0) > 0}`,
  ].join(', ');

  console.log(`  ${num} task=${task.id} status=${task.status.status} → ${action}`);
  console.log(`         ${resumo}`);

  if (isVerbose) {
    console.log(`         campos: ${resumoDeCamposRedigido(input as unknown as Record<string, unknown>)}`);
  }
}
