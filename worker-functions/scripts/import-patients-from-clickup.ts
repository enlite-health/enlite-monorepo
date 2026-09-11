#!/usr/bin/env ts-node
/**
 * import-patients-from-clickup.ts
 *
 * Carga PONTUAL manual (decisão 11/09/2026 — sem sync automático); dry-run por padrão;
 * nunca agendar.
 *
 * A plataforma é a fonte da verdade do paciente — não existe mais webhook nem reconciliador
 * ClickUp→paciente (removidos nesta mesma decisão). Este script é a ÚNICA ferramenta de carga
 * do ClickUp que resta, e roda MANUALMENTE, numa sessão de terminal, quando alguém decide
 * puxar 1 ou N cards. Nunca colocar em Cloud Scheduler / cron / CI.
 *
 * Paginates the ClickUp list "Estado de Pacientes" (901304883903) — ou busca UMA task por id
 * com `--task-id` — e upserta cada task como paciente via PatientService.upsertFromClickUp(),
 * pelo MESMO motor que o webhook (removido) usava: SyncPatientFromClickUpTaskUseCase. Com
 * `--apply`, também sincroniza "Tipo de Patología" → CID-11 (spec 016 F4, decisão do Gabriel
 * 11/09/2026) — dry-run nunca grava diagnóstico.
 *
 * ── Pre-requisites ────────────────────────────────────────────────────────────
 *   - CLICKUP_API_TOKEN set in environment (Secret Manager em prod, sessão local em dev)
 *   - DATABASE_URL set (required with --apply, optional otherwise)
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *   set -a && source worker-functions/.env && set +a
 *   cd worker-functions
 *   npx ts-node -r tsconfig-paths/register scripts/import-patients-from-clickup.ts --limit 3
 *   npx ts-node -r tsconfig-paths/register scripts/import-patients-from-clickup.ts --apply
 *   npx ts-node -r tsconfig-paths/register scripts/import-patients-from-clickup.ts --apply --status busqueda --limit 10
 *   npx ts-node -r tsconfig-paths/register scripts/import-patients-from-clickup.ts --task-id 86abq2pzg --apply
 *
 * ── Flags ─────────────────────────────────────────────────────────────────────
 *   (nenhuma)          dry-run (DEFAULT) — loga o que aconteceria; nenhuma escrita no DB
 *   --apply            grava no banco — ÚNICA flag que sai do dry-run
 *   --task-id <id>     carga pontual de UMA task específica (GET direto, sem paginar a lista) —
 *                      cobre o caso antes servido por resync-one-clickup-task.ts (removido)
 *   --limit N          processa só as N primeiras tasks (default: todas)
 *   --status X,Y,Z     filtra tasks por status.status (comma-separated)
 *   --verbose          imprime o PatientServiceUpsertInput inteiro por task
 */

/* eslint-disable no-console */

import { Pool } from 'pg';
import { ClickUpFieldResolver } from '../src/modules/integration/infrastructure/clickup/ClickUpFieldResolver';
import { ClickUpPatientMapper } from '../src/modules/integration/infrastructure/clickup/ClickUpPatientMapper';
import type { ClickUpTask } from '../src/modules/integration/infrastructure/clickup/ClickUpTask';
import { SyncPatientFromClickUpTaskUseCase } from '../src/modules/integration/application/SyncPatientFromClickUpTaskUseCase';
import {
  PatientSourceLabelRepository,
  PatientInsuranceVerifiedRepository,
  PatientDeviceTypeRepository,
} from '../src/modules/case';
// spec 016 F4 — mesma construção que ClickUpPatientWebhookController.getDiagnosisMapper()
// fazia (webhook removido 11/09/2026): decisão do Gabriel, a carga manual passa a sincronizar
// diagnóstico também. Repositório JÁ ESCOPADO a DiagnosisSource.CLICKUP por construtor
// (contrato de arquitetura da spec 016) — este script é fisicamente incapaz de tocar uma
// linha PANEL.
import { ClickUpDiagnosisMapper } from '../src/modules/diagnosis/infrastructure/clickup/ClickUpDiagnosisMapper';
import { ClickUpDiagnosisLabelRepository } from '../src/modules/diagnosis/infrastructure/clickup/ClickUpDiagnosisLabelRepository';
import { ClickUpDiagnosisRejectionRepository } from '../src/modules/diagnosis/infrastructure/clickup/ClickUpDiagnosisRejectionRepository';
import { PatientDiagnosisService } from '../src/modules/diagnosis/application/PatientDiagnosisService';
import { PostgresPatientDiagnosisRepository } from '../src/modules/diagnosis/infrastructure/PostgresPatientDiagnosisRepository';
import { DiagnosisSource } from '../src/modules/diagnosis/domain/DiagnosisSource';
import { createTerminologyPort } from '../src/modules/terminology/infrastructure/TerminologyPortFactory';
import {
  checkExistingTaskIds,
  processDryRun,
  type DryRunCounters,
} from './import-patients-dry-run';
import { parseImportPatientsFlags } from './import-patients-from-clickup-flags';

// ── Constants ──────────────────────────────────────────────────────────────────

const LIST_ID = '901304883903'; // Estado de Pacientes
const CLICKUP_API_BASE = 'https://api.clickup.com/api/v2';
const SCRIPT_TAG = '[import-patients-from-clickup]';

// ── Arg parsing ───────────────────────────────────────────────────────────────

const flags        = parseImportPatientsFlags(process.argv.slice(2));
const isDryRun      = !flags.apply;
const limit         = flags.limit;
const statusFilter  = flags.statusFilter;
const isVerbose     = flags.verbose;
const singleTaskId  = flags.taskId;

// ── Env validation ─────────────────────────────────────────────────────────────

const CLICKUP_TOKEN = process.env.CLICKUP_API_TOKEN;
if (!CLICKUP_TOKEN) {
  console.error(`${SCRIPT_TAG} ERROR: CLICKUP_API_TOKEN is not set in environment.`);
  process.exit(1);
}

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

if (!isDryRun && !process.env.DATABASE_URL) {
  console.error(`${SCRIPT_TAG} ERROR: DATABASE_URL is required with --apply.`);
  process.exit(1);
}

// ── ClickUp fetch ─────────────────────────────────────────────────────────────

interface TasksPage {
  tasks: ClickUpTask[];
  last_page: boolean;
}

async function fetchOneTask(taskId: string): Promise<ClickUpTask> {
  const res = await fetch(`${CLICKUP_API_BASE}/task/${taskId}`, {
    headers: { Authorization: CLICKUP_TOKEN as string },
  });
  if (!res.ok) {
    throw new Error(`ClickUp GET /task/${taskId} failed: HTTP ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as ClickUpTask;
}

async function fetchPage(page: number): Promise<TasksPage> {
  const url =
    `${CLICKUP_API_BASE}/list/${LIST_ID}/task` +
    `?page=${page}&archived=false&subtasks=false&include_closed=true`;

  const res = await fetch(url, {
    headers: { Authorization: CLICKUP_TOKEN as string },
  });

  if (!res.ok) {
    throw new Error(`ClickUp /task API failed: HTTP ${res.status} ${res.statusText} (page ${page})`);
  }

  return (await res.json()) as TasksPage;
}

async function fetchAllTasks(): Promise<ClickUpTask[]> {
  console.log(`${SCRIPT_TAG} Fetching ClickUp list ${LIST_ID}...`);
  const all: ClickUpTask[] = [];
  let page = 0;

  while (true) {
    const { tasks, last_page } = await fetchPage(page);
    all.push(...tasks);
    console.log(`  page ${page}: +${tasks.length} tasks (total ${all.length})`);

    if (last_page || tasks.length === 0) break;
    page++;
  }

  return all;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Lazy-load PatientService (imports DatabaseConnection → needs DATABASE_URL).
  // Only with --apply; avoids a DB connection in pure dry-run.
  let useCase: SyncPatientFromClickUpTaskUseCase | null = null;
  let pool: Pool | null = null;

  if (!isDryRun) {
    const { PatientService } = await import('@modules/case');
    const patientService = new PatientService();
    const resolver = await ClickUpFieldResolver.fromList(LIST_ID, { token: CLICKUP_TOKEN as string });
    const mapper = new ClickUpPatientMapper(resolver);
    // spec 016 F4 — decisão do Gabriel (11/09/2026): a carga manual passa a sincronizar
    // "Tipo de Patología" → CID-11 também, MESMA construção que o webhook fazia
    // (ClickUpPatientWebhookController.getDiagnosisMapper(), removido). Nunca loga texto
    // clínico — persistDiagnosis (dentro do use case) só emite nome de campo e contagem (C1).
    const diagnosisMapper = new ClickUpDiagnosisMapper(
      new ClickUpDiagnosisLabelRepository(),
      new ClickUpDiagnosisRejectionRepository(),
      new PatientDiagnosisService(
        createTerminologyPort(process.env),
        new PostgresPatientDiagnosisRepository(DiagnosisSource.CLICKUP),
      ),
    );
    useCase = new SyncPatientFromClickUpTaskUseCase({
      mapper, patientService,
      // Task 2.3 — o cru vai junto do derivado, também no caminho de recuperação manual.
      sourceLabelRepository: new PatientSourceLabelRepository(),
      // Spec 012 T001c: as deps são OBRIGATÓRIAS no use case (fiação que ninguém liga não
      // existe) — `scripts/` está fora do tsconfig e por isso o compilador não acusou aqui.
      insuranceRepository:   new PatientInsuranceVerifiedRepository(),
      deviceTypeRepository:  new PatientDeviceTypeRepository(),
      diagnosisMapper,
    });
    pool = new Pool({ connectionString: DATABASE_URL });
  }

  // ── --task-id: carga pontual de UMA task, sem paginar a lista ────────────────
  if (singleTaskId !== null) {
    console.log(`${SCRIPT_TAG} --task-id=${singleTaskId} — carga pontual, sem paginação.`);
    const task = await fetchOneTask(singleTaskId);
    console.log(`${SCRIPT_TAG} task=${task.id} status=${task.status?.status} list=${(task as unknown as { list?: { id?: string } }).list?.id}`);

    if ((task as unknown as { list?: { id?: string } }).list?.id !== LIST_ID) {
      console.error(`${SCRIPT_TAG} ABORTADO: task não pertence à lista Estado de Pacientes (${LIST_ID}).`);
      process.exit(1);
    }

    if (isDryRun) {
      const resolver = await ClickUpFieldResolver.fromList(LIST_ID, { token: CLICKUP_TOKEN as string });
      const mapper = new ClickUpPatientMapper(resolver);
      const mapped = mapper.map(task);
      console.log(`${SCRIPT_TAG} case_number mapeado = ${(mapped as { caseNumber?: number } | null)?.caseNumber ?? 'null'}`);
      console.log(`${SCRIPT_TAG} DRY-RUN — nada foi gravado. Rode com --apply para persistir.`);
      return;
    }

    const result = await useCase!.execute(task);
    console.log(`${SCRIPT_TAG} RESULTADO: ${JSON.stringify(result, null, 2)}`);
    if (pool) await pool.end();
    if (result.kind === 'ERROR') process.exit(1);
    return;
  }

  // For dry-run with DATABASE_URL available we can classify create vs update.
  let dryRunPool: Pool | null = null;
  let dryRunMapper: ClickUpPatientMapper | null = null;
  if (isDryRun) {
    try {
      dryRunPool = new Pool({ connectionString: DATABASE_URL });
    } catch {
      // Not critical — dry-run will report "would upsert" without classification
    }
    const resolver = await ClickUpFieldResolver.fromList(LIST_ID, { token: CLICKUP_TOKEN as string });
    dryRunMapper = new ClickUpPatientMapper(resolver);
  }

  // Step 1: Fetch all tasks
  const allTasks = await fetchAllTasks();
  console.log(`Fetched ${allTasks.length} tasks.\n`);

  // Step 2: Apply status filter
  const filteredTasks = statusFilter.length > 0
    ? allTasks.filter(t => statusFilter.includes(t.status.status.toLowerCase()))
    : allTasks;

  // Step 3: Apply limit
  const tasksToProcess = limit !== null ? filteredTasks.slice(0, limit) : filteredTasks;

  const modeStr   = isDryRun ? 'dry-run=true' : 'APPLY (DB writes enabled)';
  const limitStr  = limit !== null ? `limit=${limit}` : 'no limit';
  const statusStr = statusFilter.length > 0 ? `status=${statusFilter.join(',')}` : 'all statuses';
  console.log(`Processing with flags: ${modeStr} ${limitStr} ${statusStr}`);

  // Step 4: Pre-classify for dry-run (SELECT existing task IDs)
  let existingIds = new Set<string>();
  if (isDryRun && dryRunPool) {
    const taskIds = tasksToProcess.filter(t => t.parent === null).map(t => t.id);
    try {
      existingIds = await checkExistingTaskIds(dryRunPool, taskIds);
    } catch {
      // DB not reachable — skip classification
    }
  }

  // Step 5: Process tasks
  let processed = 0;
  let skippedNoName = 0;
  let skippedSubtask = 0;
  let skippedMapper = 0;
  let wouldCreate = 0;
  let wouldUpdate = 0;
  let created = 0;
  let updated = 0;
  let flaggedCreated = 0;
  let flaggedUpdated = 0;
  let caseNumberConflicts = 0;
  let errors = 0;

  for (let i = 0; i < tasksToProcess.length; i++) {
    const task = tasksToProcess[i];
    const num  = `[${i + 1}/${tasksToProcess.length}]`;

    if (isDryRun) {
      const counters: DryRunCounters = {
        processed, skippedNoName, skippedSubtask, skippedMapper, wouldCreate, wouldUpdate,
      };
      processDryRun(task, i, tasksToProcess.length, dryRunMapper!, existingIds, counters, isVerbose);
      ({ processed, skippedNoName, skippedSubtask, skippedMapper, wouldCreate, wouldUpdate } = counters);
      continue;
    }

    // --apply — delegate entirely to the UseCase
    const result = await useCase!.execute(task);

    switch (result.kind) {
      case 'SKIPPED_SUBTASK':
        skippedSubtask++;
        break;

      case 'SKIPPED_NO_PATIENT_NAME':
        console.log(`  ${num} task=${result.taskId} → SKIPPED (no patient name)`);
        skippedNoName++;
        break;

      case 'SKIPPED_MAPPER_NULL':
        console.log(`  ${num} task=${result.taskId} → SKIPPED (mapper returned null)`);
        skippedMapper++;
        break;

      case 'ERROR':
        console.log(`  ERROR  task=${result.taskId} msg=${result.error.message}`);
        if (result.error.stack) {
          console.log(`         stack: ${result.error.stack.split('\n').slice(0, 5).join(' | ')}`);
        }
        errors++;
        break;

      case 'CASE_NUMBER_CONFLICT':
        processed++;
        caseNumberConflicts++;
        console.log(
          `  ${num} task=${result.taskId} case=${result.caseNumber ?? 'unknown'} → CONFLICT (patient persisted without case_number, needs_attention)`,
        );
        break;

      case 'CREATED':
        processed++;
        created++;
        if (result.flagged) flaggedCreated++;
        console.log(
          `  ${num} task=${result.taskId} → CREATED patient id=${result.patientId} (${result.patientName})${result.flagged ? ' [flagged]' : ''}`,
        );
        break;

      case 'UPDATED':
        processed++;
        updated++;
        if (result.flagged) flaggedUpdated++;
        console.log(
          `  ${num} task=${result.taskId} → UPDATED patient id=${result.patientId} (${result.patientName})${result.flagged ? ' [flagged]' : ''}`,
        );
        break;
    }
  }

  // Step 6: Summary
  const totalFetched = allTasks.length;
  const totalSkipped = skippedNoName + skippedSubtask + skippedMapper;

  console.log('\nSummary:');
  console.log(`  Fetched:       ${totalFetched} tasks`);
  if (statusFilter.length > 0) {
    console.log(`  After filter:  ${filteredTasks.length} tasks (status=${statusFilter.join(',')})`);
  }
  console.log(`  Processed:     ${processed}${limit !== null ? ` (limit=${limit})` : ''}`);
  console.log(`  Skipped:       ${totalSkipped} (${skippedNoName} no name, ${skippedSubtask} subtask, ${skippedMapper} mapper null)`);

  if (isDryRun) {
    if (existingIds.size > 0) {
      console.log(`  Would create:  ${wouldCreate}`);
      console.log(`  Would update:  ${wouldUpdate}`);
    } else {
      console.log(`  Would upsert:  ${processed} (DB not queried for classification)`);
    }
  } else {
    console.log(`  Created:       ${created}`);
    console.log(`  Updated:       ${updated}`);
    const totalFlagged = flaggedCreated + flaggedUpdated;
    if (totalFlagged > 0) {
      console.log(`  Flagged:       ${totalFlagged} (needs_attention=true, reason=MISSING_INFO)`);
    }
    if (caseNumberConflicts > 0) {
      console.log(`  Conflicts:     ${caseNumberConflicts} (case_number duplicate — persisted with case_number=null, needs_attention=CASE_NUMBER_CONFLICT)`);
    }
  }

  console.log(`  Errors:        ${errors}`);
  console.log(`  Mode:          ${isDryRun ? 'DRY-RUN (no DB writes)' : 'APPLY (DB writes committed)'}`);

  // Cleanup
  if (pool) await pool.end();
  if (dryRunPool) await dryRunPool.end();

  const fs = await import('fs');
  const probePath = '/tmp/clickup-fields-probe.json';
  if (fs.existsSync(probePath)) fs.unlinkSync(probePath);

  if (errors > 0 && !isDryRun) process.exit(1);
}

main().catch(err => {
  console.error(`${SCRIPT_TAG} Fatal error:`, err);
  process.exit(1);
});
