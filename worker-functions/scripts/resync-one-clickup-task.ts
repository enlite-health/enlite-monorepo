#!/usr/bin/env ts-node
/**
 * resync-one-clickup-task.ts
 *
 * Re-sincroniza UMA task do ClickUp pelo caminho de produção
 * (mesmo SyncPatientFromClickUpTaskUseCase que o webhook usa).
 *
 * Motivo de existir: quando um CASE_NUMBER_CONFLICT é resolvido no ClickUp
 * (ex.: o card que ocupava o número indevidamente foi renumerado), o card que
 * ficou com case_number=NULL não é reprocessado — o webhook só dispara para o
 * card que mudou. Este script força esse reprocesso, com raio de ação de 1 linha.
 *
 * Pré-requisitos: CLICKUP_API_TOKEN e DATABASE_URL no ambiente.
 * Para espelhar também os chat IDs de WhatsApp (Chat ID Familia/Equipo →
 * patient_chat_ids), exportar PATIENT_CHAT_IDS_CLICKUP_SYNC_ENABLED=true —
 * sem a flag esse passo é um no-op silencioso.
 *
 * Uso:
 *   npx ts-node -r tsconfig-paths/register scripts/resync-one-clickup-task.ts <taskId> [--live]
 *   (sem --live = dry-run: mostra o que seria gravado e não escreve)
 */

/* eslint-disable no-console */

import { ClickUpFieldResolver } from '../src/modules/integration/infrastructure/clickup/ClickUpFieldResolver';
import { ClickUpPatientMapper } from '../src/modules/integration/infrastructure/clickup/ClickUpPatientMapper';
import type { ClickUpTask } from '../src/modules/integration/infrastructure/clickup/ClickUpTask';
import { SyncPatientFromClickUpTaskUseCase } from '../src/modules/integration/application/SyncPatientFromClickUpTaskUseCase';

const LIST_ID = '901304883903'; // Estado de Pacientes
const CLICKUP_API_BASE = 'https://api.clickup.com/api/v2';
const TAG = '[resync-one-clickup-task]';

const argv = process.argv.slice(2);
const taskId = argv.find(a => !a.startsWith('--'));
const isLive = argv.includes('--live');

const CLICKUP_TOKEN = process.env.CLICKUP_API_TOKEN;

async function main(): Promise<void> {
  if (!taskId) {
    console.error(`${TAG} ERROR: informe o taskId. Ex: ... resync-one-clickup-task.ts 86abq2pzg --live`);
    process.exit(1);
  }
  if (!CLICKUP_TOKEN) {
    console.error(`${TAG} ERROR: CLICKUP_API_TOKEN não está no ambiente.`);
    process.exit(1);
  }
  if (isLive && !process.env.DATABASE_URL) {
    console.error(`${TAG} ERROR: DATABASE_URL é obrigatório em --live.`);
    process.exit(1);
  }

  // 1. Busca a task individual (mesma chamada que o webhook faz)
  const res = await fetch(`${CLICKUP_API_BASE}/task/${taskId}`, {
    headers: { Authorization: CLICKUP_TOKEN },
  });
  if (!res.ok) {
    throw new Error(`ClickUp GET /task/${taskId} falhou: HTTP ${res.status} ${res.statusText}`);
  }
  const task = (await res.json()) as ClickUpTask;

  console.log(`${TAG} task=${task.id} status=${task.status?.status} list=${(task as any).list?.id}`);

  if ((task as any).list?.id !== LIST_ID) {
    console.error(`${TAG} ABORTADO: task não pertence à lista Estado de Pacientes (${LIST_ID}).`);
    process.exit(1);
  }

  // 2. Mapeia (mostra o case_number que seria gravado)
  const resolver = await ClickUpFieldResolver.fromList(LIST_ID, { token: CLICKUP_TOKEN });
  const mapper = new ClickUpPatientMapper(resolver);
  const mapped = mapper.map(task);
  console.log(`${TAG} case_number mapeado = ${(mapped as any)?.caseNumber ?? 'null'}`);
  console.log(`${TAG} status mapeado      = ${(mapped as any)?.status ?? 'null'}`);

  if (!isLive) {
    console.log(`${TAG} DRY-RUN — nada foi gravado. Rode com --live para persistir.`);
    return;
  }

  // 3. Executa o UseCase de produção
  const {
    PatientService, PatientSourceLabelRepository, PatientInsuranceVerifiedRepository, PatientDeviceTypeRepository,
  } = await import('@modules/case');
  // Spec 012 T001c: mesmas deps do webhook (ClickUpPatientWebhookController) — o caminho de
  // produção precisa gravar cru, cobertura múltipla e dispositivo também na ressincronização manual.
  const useCase = new SyncPatientFromClickUpTaskUseCase({
    mapper,
    patientService:        new PatientService(),
    sourceLabelRepository: new PatientSourceLabelRepository(),
    insuranceRepository:   new PatientInsuranceVerifiedRepository(),
    deviceTypeRepository:  new PatientDeviceTypeRepository(),
  });
  const result = await useCase.execute(task);
  console.log(`${TAG} RESULTADO: ${JSON.stringify(result, null, 2)}`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(`${TAG} Fatal:`, err);
    process.exit(1);
  });
