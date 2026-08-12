/**
 * worker-onboarding-journey.e2e.test.ts
 *
 * Teste de JORNADA CONTÍNUA: simula uma pessoa real fazendo todo o fluxo de
 * onboarding + postulação, provando o liga/desliga do gate de elegibilidade.
 *
 * Execução contínua (soak):
 *   JOURNEY_ITERATIONS=5 npx jest --config jest.config.e2e.js tests/e2e/worker-onboarding-journey.e2e.test.ts
 *
 * Endpoints reais usados (nunca mock de banco):
 *   - POST /api/workers/init                      → cria worker (InitWorkerUseCase)
 *   - PUT  /api/workers/me/general-info           → salva INFO (SavePersonalInfoUseCase → recalculateStatus)
 *   - PUT  /api/workers/me/service-area           → salva service_area (SaveServiceAreaUseCase → recalculateStatus)
 *   - PUT  /api/workers/me/availability           → salva availability (SaveAvailabilityUseCase → recalculateStatus)
 *   - POST /api/workers/me/documents/save         → salva doc por doc (UploadWorkerDocumentsUseCase → recalculateStatus)
 *   - POST /api/worker-applications/track-channel → postula (WorkerApplicationsController → assertWorkerCanApply)
 *   - GET  /api/admin/recruitment/blocked-attempts → visão de operadores (RecruitmentBlockedController)
 *
 * Banco: real (Docker via DATABASE_URL). Zero mocks.
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';
import {
  JourneyWorker,
  JourneyVacancy,
  createWorker,
  createVacancyFixture,
  getWorkerToken,
  savePersonalInfo,
  saveServiceArea,
  saveAvailability,
  saveDocuments,
  tryApply,
  getBlockedAttempt,
  getWorkerStatus,
  cleanupJourneyData,
  DOCS_NON_AT,
  DOCS_AT_FULL,
} from './worker-onboarding-journey.helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const ITERATIONS = parseInt(process.env.JOURNEY_ITERATIONS ?? '1', 10);

// ── Núcleo da jornada ────────────────────────────────────────────────────────

/**
 * runWorkerJourney executa um ciclo completo de 4 etapas para dois workers
 * distintos (wA e wB), verificando o gate de elegibilidade em cada transição.
 *
 * A função é idempotente: cria seus próprios workers/vagas e limpa ao final.
 *
 * @param iterIdx índice da iteração (para tags únicas em logs)
 */
async function runWorkerJourney(
  pool: Pool,
  iterIdx: number,
): Promise<void> {
  const api = createApiClient();

  const adminToken = await getMockToken(api, {
    uid: `journey-admin-${iterIdx}`,
    email: `journey-admin-${iterIdx}@e2e.local`,
    role: 'admin',
  });

  // Cada iteração tem vaga própria pra evitar colisão de unique constraints
  const vacancy: JourneyVacancy = await createVacancyFixture(
    pool,
    `iter-${iterIdx}`,
  );

  // wA — percorre INFO incompleta → docs → info completa
  let wA: JourneyWorker | undefined;
  // wB — percorre info completa → sem docs → docs
  let wB: JourneyWorker | undefined;

  try {
    // ════════════════════════════════════════════════════════════════════════
    // ETAPA 1 — Worker A: INFO incompleta E DOCS incompletos
    // ════════════════════════════════════════════════════════════════════════

    wA = await createWorker(api, `wa-${iterIdx}`);
    const tokenA = await getWorkerToken(api, wA);

    // 1a. Status inicial deve ser INCOMPLETE_REGISTER
    const statusA0 = await getWorkerStatus(pool, wA.id);
    expect(statusA0).toBe('INCOMPLETE_REGISTER');

    // 1b. Tentativa de postulação → DEVE ser barrada (403)
    const applyA0 = await tryApply(api, tokenA, vacancy.id);
    expect(applyA0.status).toBe(403);
    expect(applyA0.data.code).toBe('WORKER_NOT_ELIGIBLE');
    expect(applyA0.data.reason).toBe('registration_incomplete');

    // 1c. Linha gravada em worker_blocked_applications com missing_fields
    //     contendo TANTO campos INFO quanto docs
    const baA1 = await getBlockedAttempt(pool, wA.id, vacancy.id);
    expect(baA1).not.toBeNull();
    expect(baA1!.blocked_reason).toBe('registration_incomplete');
    expect(baA1!.attempt_count).toBe(1);

    // Deve ter campos de INFO (ex: first_name) E de docs (worker_documents)
    expect(baA1!.missing_fields).toEqual(
      expect.arrayContaining(['first_name', 'worker_documents']),
    );

    // 1d. Painel admin deve retornar esse blocked attempt
    const panelA1 = await api.get(
      `/api/admin/recruitment/blocked-attempts?workerId=${wA.id}`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(panelA1.status).toBe(200);
    const panelA1Items = panelA1.data.data as Array<{
      workerId: string;
      blockedReason: string;
      missingFields: string[];
    }>;
    const rowA1 = panelA1Items.find(r => r.workerId === wA!.id);
    expect(rowA1).toBeDefined();
    expect(rowA1!.blockedReason).toBe('registration_incomplete');
    expect(rowA1!.missingFields).toEqual(
      expect.arrayContaining(['first_name', 'worker_documents']),
    );

    // ════════════════════════════════════════════════════════════════════════
    // ETAPA 2 — Worker A: sobe TODA documentação, INFO ainda incompleta
    // ════════════════════════════════════════════════════════════════════════

    // 2a. Upload de TODOS os documentos possíveis (incluindo AT extras).
    //     Com profession=NULL no momento do upload, fn_worker_missing_fields trata
    //     o worker como AT (NULL != 'AT' = NULL em SQL → condição falsa → exige AT docs).
    //     Subir DOCS_AT_FULL garante que worker_documents saia de missing_fields
    //     independente do valor de profession, tornando o assert limpo.
    await saveDocuments(api, tokenA, DOCS_AT_FULL);

    // 2b. Status ainda INCOMPLETE_REGISTER (info falta)
    const statusA2 = await getWorkerStatus(pool, wA.id);
    expect(statusA2).toBe('INCOMPLETE_REGISTER');

    // 2c. Segunda tentativa de postulação → ainda barrada
    const applyA2 = await tryApply(api, tokenA, vacancy.id);
    expect(applyA2.status).toBe(403);

    // 2d. missing_fields agora contém SÓ campos INFO (sem worker_documents)
    const baA2 = await getBlockedAttempt(pool, wA.id, vacancy.id);
    expect(baA2).not.toBeNull();
    expect(baA2!.attempt_count).toBe(2);
    // Docs estão completos: worker_documents NÃO deve estar na lista
    expect(baA2!.missing_fields).not.toContain('worker_documents');
    // Campos de INFO devem estar presentes (info nunca foi preenchida)
    expect(baA2!.missing_fields).toEqual(
      expect.arrayContaining(['first_name']),
    );

    // 2e. Painel admin reflete novo motivo (só INFO)
    const panelA2 = await api.get(
      `/api/admin/recruitment/blocked-attempts?workerId=${wA.id}`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(panelA2.status).toBe(200);
    const panelA2Items = panelA2.data.data as Array<{
      workerId: string;
      missingFields: string[];
    }>;
    const rowA2 = panelA2Items.find(r => r.workerId === wA!.id);
    expect(rowA2!.missingFields).not.toContain('worker_documents');
    expect(rowA2!.missingFields).toEqual(
      expect.arrayContaining(['first_name']),
    );

    // ════════════════════════════════════════════════════════════════════════
    // ETAPA 3 — Worker B: INFO + service_area + availability completos, SEM docs
    // ════════════════════════════════════════════════════════════════════════

    wB = await createWorker(api, `wb-${iterIdx}`);
    const tokenB = await getWorkerToken(api, wB);

    // 3a. Completa toda INFO pessoal + service_area + availability
    //     uniqueSuffix = id do worker B garante phone/documentNumber únicos
    await savePersonalInfo(api, tokenB, wB.id);
    await saveServiceArea(api, tokenB);
    await saveAvailability(api, tokenB);

    // 3b. Status ainda INCOMPLETE_REGISTER (docs faltam)
    const statusB3 = await getWorkerStatus(pool, wB.id);
    expect(statusB3).toBe('INCOMPLETE_REGISTER');

    // 3c. Tentativa de postulação → barrada
    const applyB3 = await tryApply(api, tokenB, vacancy.id);
    expect(applyB3.status).toBe(403);
    expect(applyB3.data.reason).toBe('registration_incomplete');

    // 3d. missing_fields contém SÓ docs (nenhum campo INFO)
    const baB3 = await getBlockedAttempt(pool, wB.id, vacancy.id);
    expect(baB3).not.toBeNull();
    expect(baB3!.missing_fields).toContain('worker_documents');
    // INFO completada: nenhum campo de INFO deve aparecer
    const INFO_FIELDS = [
      'first_name', 'last_name', 'sex', 'gender', 'birth_date',
      'document_number', 'languages', 'phone', 'profession',
      'knowledge_level', 'title_certificate', 'years_experience',
      'experience_types', 'preferred_types', 'preferred_age_range',
      'worker_service_areas', 'worker_availability',
    ];
    for (const field of INFO_FIELDS) {
      expect(baB3!.missing_fields).not.toContain(field);
    }

    // 3e. Painel admin reflete motivo correto (só docs)
    const panelB3 = await api.get(
      `/api/admin/recruitment/blocked-attempts?workerId=${wB.id}`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(panelB3.status).toBe(200);
    const panelB3Items = panelB3.data.data as Array<{
      workerId: string;
      missingFields: string[];
    }>;
    const rowB3 = panelB3Items.find(r => r.workerId === wB!.id);
    expect(rowB3!.missingFields).toContain('worker_documents');
    for (const field of INFO_FIELDS) {
      expect(rowB3!.missingFields).not.toContain(field);
    }

    // ════════════════════════════════════════════════════════════════════════
    // ETAPA 4 — Completa TUDO e re-habilita ambos os workers
    // ════════════════════════════════════════════════════════════════════════

    // ── Worker B: sobe documentos → deve virar REGISTERED ──
    // Worker B já tem profession='CAREGIVER' (definida em savePersonalInfo), então
    // docs básicos (sem AT extras) são suficientes para satisfazer fn_worker_missing_fields.
    await saveDocuments(api, tokenB, DOCS_NON_AT);

    const statusB4 = await getWorkerStatus(pool, wB.id);
    expect(statusB4).toBe('REGISTERED');

    // Worker B consegue postular → 200, cria WJA INVITED
    const applyB4 = await tryApply(api, tokenB, vacancy.id);
    expect(applyB4.status).toBe(200);
    expect(applyB4.data.success).toBe(true);

    // WJA criada
    const { rows: wjaB } = await pool.query(
      `SELECT source, application_funnel_stage
       FROM worker_job_applications
       WHERE worker_id = $1 AND job_posting_id = $2`,
      [wB.id, vacancy.id],
    );
    expect(wjaB).toHaveLength(1);
    expect(wjaB[0].source).toBe('manual');
    expect(wjaB[0].application_funnel_stage).toBe('INVITED');

    // Não gerou nova blocked attempt após sucesso
    const { rows: baAfterB } = await pool.query(
      `SELECT attempt_count FROM worker_blocked_applications
       WHERE worker_id = $1 AND job_posting_id = $2`,
      [wB.id, vacancy.id],
    );
    // O attempt anterior deve permanecer (não incrementado após sucesso)
    // ou simplesmente não existir novo; de qualquer forma attempt_count não
    // deve ter aumentado além do attempt original da etapa 3
    if (baAfterB.length > 0) {
      expect(baAfterB[0].attempt_count).toBe(1);
    }

    // ── Worker A: completa INFO → deve virar REGISTERED ──
    //     uniqueSuffix = id do worker A garante phone/documentNumber únicos
    await savePersonalInfo(api, tokenA, wA.id);
    await saveServiceArea(api, tokenA);
    await saveAvailability(api, tokenA);

    const statusA4 = await getWorkerStatus(pool, wA.id);
    expect(statusA4).toBe('REGISTERED');

    // Worker A consegue postular → 200, cria WJA INVITED
    const applyA4 = await tryApply(api, tokenA, vacancy.id);
    expect(applyA4.status).toBe(200);
    expect(applyA4.data.success).toBe(true);

    const { rows: wjaA } = await pool.query(
      `SELECT source, application_funnel_stage
       FROM worker_job_applications
       WHERE worker_id = $1 AND job_posting_id = $2`,
      [wA.id, vacancy.id],
    );
    expect(wjaA).toHaveLength(1);
    expect(wjaA[0].source).toBe('manual');
    expect(wjaA[0].application_funnel_stage).toBe('INVITED');

  } finally {
    // Limpeza total: sem vazar dados entre iterações
    const workerIds = [wA?.id, wB?.id].filter((id): id is string => Boolean(id));
    await cleanupJourneyData(
      pool,
      workerIds,
      [vacancy.id],
      [vacancy.patientId],
    );
  }
}

// ── Suite principal ──────────────────────────────────────────────────────────

describe(`Worker onboarding journey — gate eligibilidade INFO vs DOCS (${ITERATIONS} iteração(ões))`, () => {
  const api = createApiClient();
  let pool: Pool;

  beforeAll(async () => {
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  // Gera um test case por iteração para que Jest reporte individualmente
  for (let i = 1; i <= ITERATIONS; i++) {
    const idx = i;
    it(
      `Iteração ${idx}/${ITERATIONS} — jornada completa (INFO+DOCS → só docs → só INFO → re-habilitado)`,
      async () => {
        await runWorkerJourney(pool, idx);
      },
      // Timeout generoso: cada iteração faz ~12 chamadas HTTP + queries
      120_000,
    );
  }
});
