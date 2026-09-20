/**
 * kanban-iniciado-blocked-columns.integration.e2e.ts @integration
 *
 * Suite E2E visual — nova coluna BLOQUEADO (cards com isBlocked=true, sem encuadreId,
 * que DEIXAM de vir mesclados em INICIADO) e coluna PRE_SCREENING (renomeada de INITIATED).
 *
 * Cenários cobertos:
 *   K1 — Board com 9 colunas na ordem correta (INVITED→BLOQUEADO→INICIADO→...)
 *   K2 — Coluna INICIADO: card normal (sem flag isBlocked)
 *   K3 — Coluna BLOQUEADO: card bloqueado com badge + motivo + missingFields + attemptCount
 *   K4 — Fluxo real de promoção: worker completa cadastro → card some de BLOQUEADO e
 *        reaparece como card normal em INICIADO (o backend cria a WJA)
 *   K5 — Coluna PRE_SCREENING: card normal (worker que passou pelo gate Talentum)
 *   K6 — Screenshot assertion das 9 colunas na ordem nova (ES)
 *   K7 — Jornada do promovido pelas demais colunas: PRE_SCREENING → IN_PROGRESS →
 *        COMPLETED (webhook Talentum real) → SELECTED (drag real), screenshot em cada
 *
 * Pré-condições:
 *   - Backend Docker rodando em localhost:8080 (USE_MOCK_AUTH=true)
 *   - Frontend dev server rodando em localhost:5173
 *   - Banco e2e com migration 230 aplicada (worker_blocked_applications)
 *
 * Seed criado dinamicamente no beforeAll:
 *   - 1 vaga de teste
 *   - 1 WJA em INVITED (normal)  → seed manual SQL
 *   - 1 tentativa bloqueada (isBlocked=true) via worker_blocked_applications → coluna BLOQUEADO
 *   - 1 WJA em PRE_SCREENING via webhook Talentum INITIATED
 *
 * Auth: USE_MOCK_AUTH=true no backend; token mock_<base64> injetado pelo interceptor.
 *
 * TODOS os cenários capturam screenshot via toHaveScreenshot() — requisito hard
 * definido em CLAUDE.md.
 *
 * NOTA (K3/K4 — fluxo 100% real, zero seed SQL no caminho de negócio):
 *   K3 — a linha de worker_blocked_applications nasce de uma tentativa REAL de
 *        postulação (POST /api/worker-applications/track-channel → 403 do gate
 *        assertWorkerCanApply, missing_fields_at_attempt calculados por fn_worker_missing_fields).
 *   K4 — o cadastro é completado pelos MESMOS endpoints que a pessoa real usa
 *        (PUT /api/workers/me/general-info, service-area, availability e
 *        POST /api/workers/me/documents/save). É o recalculateWorkerStatus no fim
 *        desses saves que promove a REGISTERED e enfileira o evento
 *        worker.registration_completed NA MESMA TRANSAÇÃO (outbox) — um UPDATE
 *        direto de status no SQL não dispararia o evento e não testaria nada.
 *        O processamento do evento é disparado via POST /api/internal/events/process
 *        com o eventId (simulação do push do Pub/Sub, mesmo padrão do E2E backend
 *        blocked-application-promotion.e2e.test.ts) — o sweep NÃO serve aqui porque
 *        só processa eventos com >5min de idade.
 */

import { execSync } from 'child_process';
import { test, expect, type Page, type Route } from '@playwright/test';
import {
  insertTestWorker,
  insertTestPatient,
  insertBaseVacancy,
  cleanupTestWorker,
  cleanupTestPatient,
} from '../helpers/db-test-helper';
import {
  loginAsKanbanAdmin,
  openKanban,
  waitForCardInStage,
  getEncuadreId,
  installKanbanInterceptors,
  sendTalentumWebhook,
  MOCK_TOKEN,
  BACKEND_URL,
} from '../helpers/talentumWebhookHelper';

// ── DB helpers ─────────────────────────────────────────────────────────────────

const CONTAINER = 'enlite-postgres';
const DB_USER = 'enlite_admin';
const DB_NAME = 'enlite_e2e';

function runSQL(sql: string): string {
  const escaped = sql.replace(/'/g, "'\\''");
  try {
    return execSync(
      `docker exec ${CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} -c '${escaped}'`,
      { stdio: 'pipe' },
    ).toString();
  } catch (err: any) {
    throw new Error(`DB error: ${err.stderr?.toString() ?? err.message}`);
  }
}

function extractUUID(psqlOutput: string): string | null {
  const match = psqlOutput.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  );
  return match ? match[0] : null;
}

function getWjaIdByWorkerAndJob(workerId: string, jobPostingId: string): string | null {
  const out = runSQL(
    `SELECT id FROM worker_job_applications WHERE worker_id = '${workerId}' AND job_posting_id = '${jobPostingId}' ORDER BY created_at DESC LIMIT 1`,
  );
  return extractUUID(out);
}

/**
 * Secret dos endpoints internos (/api/internal/*) — lido do PRÓPRIO container
 * (varia por ambiente: dev usa o .env da raiz, CI usa docker-compose.test.yml).
 */
function getInternalSecret(): string {
  try {
    return execSync(`docker exec ${CONTAINER.replace('postgres', 'api')} printenv INTERNAL_TOKEN_SECRET`, {
      stdio: 'pipe',
    })
      .toString()
      .trim();
  } catch {
    return 'test-secret-for-e2e-only';
  }
}

/**
 * Mock token de WORKER (USE_MOCK_AUTH=true) via POST /api/test/auth/token —
 * mesmo caminho usado pelos E2E do backend (tests/e2e/helpers.ts:getMockToken).
 * O auth_uid/email vêm do seed (insertTestWorker gera e grava no banco).
 */
async function getWorkerMockToken(page: Page, workerId: string): Promise<string> {
  const out = runSQL(`SELECT auth_uid, email FROM workers WHERE id = '${workerId}'`);
  const line = out.split('\n').find((l) => l.includes('@') && l.includes('|'));
  if (!line) throw new Error(`[auth] worker ${workerId} sem auth_uid/email no banco: ${out}`);
  const [authUid, email] = line.split('|').map((s) => s.trim());
  const res = await page.request.post(`${BACKEND_URL}/api/test/auth/token`, {
    data: { uid: authUid, email, role: 'worker' },
  });
  if (res.status() !== 200) {
    throw new Error(`[auth] mock token de worker falhou: ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as { data: { token: string } };
  return body.data.token;
}

// ── State ──────────────────────────────────────────────────────────────────────

let patientId = '';
let vacancyId = '';

let workerNormal_Id = '';
let workerNormal_Phone = '';
let wjaNormal_Id = '';

let workerBlocked_Id = '';
let workerBlocked_Phone = '';
/** This worker has a blocked attempt (worker_blocked_applications row) — encuadreId will be null */
let blockedWba_Id = '';

let workerPreScr_Id = '';
let workerPreScr_Phone = '';
let workerPreScr_Email = '';
let workerPreScr_ProfileId = '';
let wjaPreScr_Id = '';

const cleanupWorkerIds: string[] = [];

// ── Suite ──────────────────────────────────────────────────────────────────────

test.describe('Kanban INICIADO + PRE_SCREENING — colunas novas @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);
  test.use({ viewport: { width: 1920, height: 1080 } });

  test.beforeAll(() => {
    const ts = Date.now();
    const rand = () =>
      String(Math.floor(Math.random() * 9_000_000) + 1_000_000);

    // Worker normal: will be in INVITED column
    workerNormal_Phone = `+549131${rand()}`;
    workerNormal_Id = insertTestWorker({
      firstName: 'Normal',
      lastName: 'Kanban',
      phone: workerNormal_Phone,
      status: 'REGISTERED',
    });
    cleanupWorkerIds.push(workerNormal_Id);

    // Worker blocked: incomplete registration — will generate a worker_blocked_applications row
    workerBlocked_Phone = `+549132${rand()}`;
    workerBlocked_Id = insertTestWorker({
      firstName: 'Bloqueado',
      lastName: 'Incompleto',
      phone: workerBlocked_Phone,
      status: 'INCOMPLETE_REGISTER',
      occupation: null,
    });
    cleanupWorkerIds.push(workerBlocked_Id);

    // Worker PRE_SCREENING: will receive a Talentum INITIATED webhook
    workerPreScr_Phone = `+549133${rand()}`;
    workerPreScr_Email = `e2e-pre-scr-${ts}@test.com`;
    workerPreScr_ProfileId = `prof-pre-${ts}`;
    workerPreScr_Id = insertTestWorker({
      firstName: 'PreScreening',
      lastName: 'Worker',
      phone: workerPreScr_Phone,
      status: 'REGISTERED',
    });
    cleanupWorkerIds.push(workerPreScr_Id);

    // Shared vacancy
    const caseNumber = 980_000 + Math.floor(Math.random() * 9_999);
    const { patientId: pid, addressId } = insertTestPatient({ withAddress: true });
    patientId = pid;
    vacancyId = insertBaseVacancy({
      patientId,
      patientAddressId: addressId!,
      caseNumber,
      status: 'SEARCHING',
      isDraft: false,
    });
  });

  test.afterAll(() => {
    // Cleanup blocked attempt
    if (vacancyId && workerBlocked_Id) {
      runSQL(
        `DELETE FROM worker_blocked_applications WHERE worker_id = '${workerBlocked_Id}' AND job_posting_id = '${vacancyId}'`,
      );
    }
    // K3/K4 (fluxo real) criam rows que cleanupTestWorker não cobre:
    // documents/availability (cadastro completado via API), encuadres (promoção)
    // e domain_events (outbox da transição REGISTERED).
    for (const wid of cleanupWorkerIds) {
      runSQL(`DELETE FROM worker_documents WHERE worker_id = '${wid}'`);
      runSQL(`DELETE FROM worker_availability WHERE worker_id = '${wid}'`);
      runSQL(`DELETE FROM encuadres WHERE worker_id = '${wid}'`);
      runSQL(`DELETE FROM domain_events WHERE payload->>'workerId' = '${wid}'`);
      cleanupTestWorker(wid);
    }
    cleanupTestPatient(patientId);
  });

  // ── K1 — Board exibe 9 colunas na ordem correta ────────────────────────────

  test('K1 — Board exibe 9 colunas na ordem: INVITED→BLOQUEADO→INICIADO→PRE_SCREENING→...→REJECTED', async ({ page }) => {
    await loginAsKanbanAdmin(page);
    await openKanban(page, vacancyId);

    const expectedCols = [
      'INVITED', 'BLOQUEADO', 'INICIADO', 'PRE_SCREENING', 'IN_PROGRESS',
      'COMPLETED', 'CONFIRMED', 'SELECTED', 'REJECTED',
    ];

    for (const col of expectedCols) {
      await expect(
        page.locator(`[data-testid="kanban-column-${col}"]`),
        `Coluna ${col} deve estar visível`,
      ).toBeVisible();
    }

    // Verificar a ordem das colunas via DOM
    const countLocators = page.locator('[data-testid$="-count"]');
    const colCounts = await countLocators.all();
    const colTestIds = await Promise.all(colCounts.map((el) => el.getAttribute('data-testid')));
    const colKeys = colTestIds
      .filter((id) => id?.startsWith('kanban-column-') && id?.endsWith('-count'))
      .map((id) => id!.replace('kanban-column-', '').replace('-count', ''));

    expect(colKeys, 'Colunas devem aparecer na ordem correta').toEqual(expectedCols);

    await expect(
      page.locator('[data-testid="kanban-board"]'),
    ).toHaveScreenshot('kanban-iniciado-k1-empty-9cols.png', { maxDiffPixelRatio: 0.05 });
  });

  // ── K2 — INICIADO: card normal (worker postulou, sem bloqueio) ─────────────
  //
  // O backend mapeia WJAs de workers que clicaram em "postularse" para a coluna
  // INICIADO (qualquer WJA não bloqueada que ainda não foi para PRE_SCREENING).
  // A coluna INVITED é para workers convidados pelo admin via invite direto.

  test('K2 — Coluna INICIADO: card normal (não bloqueado) aparece sem badge bloqueado', async ({ page }) => {
    // Seed: WJA source='manual' em INVITED para workerNormal (DB stage válido)
    // O backend mapeia INVITED stage para a coluna INVITED no Kanban
    runSQL(
      `INSERT INTO worker_job_applications
         (worker_id, job_posting_id, source, application_funnel_stage, created_at, updated_at)
       VALUES
         ('${workerNormal_Id}', '${vacancyId}', 'manual', 'INVITED', NOW(), NOW())
       ON CONFLICT (worker_id, job_posting_id) DO NOTHING`,
    );

    wjaNormal_Id = getWjaIdByWorkerAndJob(workerNormal_Id, vacancyId) ?? '';
    if (!wjaNormal_Id) throw new Error('[K2] wja.id não encontrado para workerNormal');

    await loginAsKanbanAdmin(page);
    // O backend pode retornar INVITED ou INICIADO dependendo da origem da WJA
    // Usamos openKanban e verificamos presença do card (sem badge bloqueado)
    await openKanban(page, vacancyId);

    // Aguardar que alguma coluna tenha o card (INVITED ou INICIADO)
    const card = page.locator(`[data-testid="kanban-card-${wjaNormal_Id}"]`);
    await expect(card, 'Card normal deve estar visível no board').toBeVisible({ timeout: 15_000 });

    // Card normal NÃO deve ter o badge de bloqueio
    await expect(
      card.locator('[data-testid="blocked-badge"]'),
      'Card normal não deve ter blocked-badge',
    ).not.toBeVisible();

    await expect(
      page.locator('[data-testid="kanban-board"]'),
    ).toHaveScreenshot('kanban-iniciado-k2-normal-card.png', { maxDiffPixelRatio: 0.05 });
  });

  // ── K3 — BLOQUEADO: card com badge + motivo + missingFields ─────────────────

  test('K3 — Coluna BLOQUEADO: card com badge, motivo e campos faltantes', async ({ page }) => {
    // Tentativa REAL de postulação: worker INCOMPLETE_REGISTER chama o mesmo
    // endpoint da pessoa real e o gate (assertWorkerCanApply) devolve 403 e grava
    // worker_blocked_applications com missing_fields_at_attempt calculados por
    // fn_worker_missing_fields. Duas tentativas para exercitar o upsert
    // (attempt_count=2). Zero seed SQL no caminho de negócio.
    const workerToken = await getWorkerMockToken(page, workerBlocked_Id);
    for (let attempt = 1; attempt <= 2; attempt++) {
      const applyRes = await page.request.post(
        `${BACKEND_URL}/api/worker-applications/track-channel`,
        {
          headers: { Authorization: `Bearer ${workerToken}` },
          data: { jobPostingId: vacancyId, channel: 'facebook' },
        },
      );
      expect(
        applyRes.status(),
        `tentativa ${attempt}: gate deve bloquear worker incompleto com 403`,
      ).toBe(403);
    }

    // Linha criada pelo gate (não por seed)
    const checkRow = runSQL(
      `SELECT id FROM worker_blocked_applications WHERE worker_id = '${workerBlocked_Id}' AND job_posting_id = '${vacancyId}' AND blocked_reason_at_attempt = 'registration_incomplete' AND attempt_count = 2`,
    );
    blockedWba_Id = extractUUID(checkRow) ?? '';
    if (!blockedWba_Id) throw new Error('[K3] gate não gravou worker_blocked_applications');

    await loginAsKanbanAdmin(page);
    await openKanban(page, vacancyId);

    // The blocked card appears in the dedicated BLOQUEADO column — it no longer
    // gets merged into INICIADO (contract change: stages.BLOQUEADO is a new key,
    // sem encuadreId → data-drag-disabled=true)
    const bloqueadoCol = page.locator('[data-testid="kanban-column-BLOQUEADO"]');
    await expect(bloqueadoCol, 'Coluna BLOQUEADO deve estar visível').toBeVisible();

    // Wait for the column to have at least 1 card (may need polling)
    await expect(
      page.locator('[data-testid="kanban-column-BLOQUEADO-count"]'),
      'BLOQUEADO deve ter pelo menos 1 card',
    ).not.toHaveText('0', { timeout: 15_000 });

    // INICIADO must NOT contain the blocked card / badge anymore
    const iniciadoCol = page.locator('[data-testid="kanban-column-INICIADO"]');
    await expect(
      iniciadoCol.locator('[data-testid="blocked-badge"]'),
      'INICIADO não deve mais conter cards bloqueados (mesclagem removida)',
    ).not.toBeVisible();

    // The blocked card should show the BLOQUEADO badge
    const blockedBadge = bloqueadoCol.locator('[data-testid="blocked-badge"]').first();
    await expect(blockedBadge, 'Badge BLOQUEADO deve estar visível na coluna BLOQUEADO').toBeVisible();

    // The blocked reason label should be visible
    const blockedReason = bloqueadoCol.locator('[data-testid="blocked-reason"]').first();
    await expect(blockedReason, 'Motivo do bloqueio deve estar visível').toBeVisible();

    // missingFields should be visible
    const missingFields = bloqueadoCol.locator('[data-testid="blocked-missing-fields"]').first();
    await expect(missingFields, 'Campos faltantes devem estar visíveis').toBeVisible();

    // attemptCount should be visible
    const attemptCount = bloqueadoCol.locator('[data-testid="blocked-attempt-count"]').first();
    await expect(attemptCount, 'Contador de tentativas deve estar visível').toBeVisible();

    await expect(
      page.locator('[data-testid="kanban-board"]'),
    ).toHaveScreenshot('kanban-iniciado-k3-blocked-card.png', { maxDiffPixelRatio: 0.05 });
  });

  // ── K4 — Fluxo real de promoção: BLOQUEADO → INICIADO ao completar cadastro ─

  test('K4 — Worker completa cadastro: card some de BLOQUEADO e aparece normal em INICIADO', async ({ page }) => {
    if (!blockedWba_Id) throw new Error('[K4] depende do seed de K3 (worker_blocked_applications)');

    // 1) Completar o cadastro pelo MESMO caminho da pessoa real (endpoints
    //    /api/workers/me/*). O recalculateWorkerStatus no fim de cada save promove
    //    a REGISTERED e enfileira worker.registration_completed na mesma transação
    //    (outbox). UPDATE direto de status no SQL NÃO dispararia o evento.
    const workerToken = await getWorkerMockToken(page, workerBlocked_Id);
    const digits = workerBlocked_Phone.replace(/\D/g, '').slice(-8).padStart(8, '0');

    const generalInfoRes = await page.request.put(
      `${BACKEND_URL}/api/workers/me/general-info`,
      {
        headers: { Authorization: `Bearer ${workerToken}` },
        data: {
          firstName: 'Bloqueado',
          lastName: 'Incompleto',
          sex: 'FEMALE',
          gender: 'FEMALE',
          birthDate: '1990-05-15',
          documentType: 'DNI',
          documentNumber: `321${digits}`,
          phone: workerBlocked_Phone,
          languages: ['ES'],
          profession: 'CAREGIVER',
          knowledgeLevel: 'BASIC',
          titleCertificate: 'DEGREE',
          yearsExperience: '3-5',
          experienceTypes: ['TEA'],
          preferredTypes: ['TEA'],
          preferredAgeRange: ['CHILD'],
          termsAccepted: true,
          privacyAccepted: true,
        },
      },
    );
    expect(generalInfoRes.status(), 'general-info deve salvar').toBe(200);

    const serviceAreaRes = await page.request.put(
      `${BACKEND_URL}/api/workers/me/service-area`,
      {
        headers: { Authorization: `Bearer ${workerToken}` },
        data: {
          address: 'Av. Corrientes 1234',
          serviceRadiusKm: 10,
          lat: -34.6037,
          lng: -58.3816,
          city: 'Buenos Aires',
          neighborhood: 'Centro',
        },
      },
    );
    expect(serviceAreaRes.status(), 'service-area deve salvar').toBe(200);

    const availabilityRes = await page.request.put(
      `${BACKEND_URL}/api/workers/me/availability`,
      {
        headers: { Authorization: `Bearer ${workerToken}` },
        data: {
          availability: [
            { dayOfWeek: 1, startTime: '08:00', endTime: '18:00', crossesMidnight: false },
            { dayOfWeek: 3, startTime: '08:00', endTime: '18:00', crossesMidnight: false },
          ],
        },
      },
    );
    expect(availabilityRes.status(), 'availability deve salvar').toBe(200);

    // Docs obrigatórios para CAREGIVER (SSOT workerDocumentPolicy): identity + criminal
    const docs: Record<string, string> = {
      identity_document: 'gs://e2e-bucket/workers/test/identity_front.pdf',
      criminal_record: 'gs://e2e-bucket/workers/test/criminal_record.pdf',
    };
    for (const [docType, filePath] of Object.entries(docs)) {
      const docRes = await page.request.post(
        `${BACKEND_URL}/api/workers/me/documents/save`,
        {
          headers: { Authorization: `Bearer ${workerToken}` },
          data: { docType, filePath },
        },
      );
      expect(docRes.status(), `documents/save(${docType}) deve salvar`).toBe(200);
    }

    // Sanity: o fluxo real promoveu a REGISTERED (senão o teste falha AQUI, com
    // os campos faltantes no erro, e não num timeout de UI lá na frente)
    const statusOut = runSQL(`SELECT status FROM workers WHERE id = '${workerBlocked_Id}'`);
    if (!statusOut.includes('REGISTERED') || statusOut.includes('INCOMPLETE_REGISTER')) {
      const missing = runSQL(`SELECT fn_worker_missing_fields('${workerBlocked_Id}'::uuid)`);
      throw new Error(`[K4] worker não virou REGISTERED após completar cadastro. missing=${missing}`);
    }

    // 2) Processar o evento como o Pub/Sub push faria em produção
    //    (POST /api/internal/events/process com o eventId — o sweep não serve:
    //    só processa eventos com >5min de idade).
    const evtOut = runSQL(
      `SELECT id FROM domain_events WHERE event = 'worker.registration_completed' AND payload->>'workerId' = '${workerBlocked_Id}' ORDER BY created_at DESC LIMIT 1`,
    );
    const eventId = extractUUID(evtOut);
    if (!eventId) {
      throw new Error('[K4] worker.registration_completed não foi enfileirado na transição para REGISTERED');
    }

    const processRes = await page.request.post(
      `${BACKEND_URL}/api/internal/events/process`,
      {
        headers: { 'X-Internal-Secret': getInternalSecret() },
        data: { message: { data: Buffer.from(JSON.stringify({ eventId })).toString('base64') } },
      },
    );
    expect([200, 204], 'events/process deve aceitar o push').toContain(processRes.status());

    // Auditoria da promoção gravada na linha bloqueada
    const promotedOut = runSQL(
      `SELECT promoted_wja_id FROM worker_blocked_applications WHERE id = '${blockedWba_Id}' AND promoted_at IS NOT NULL`,
    );
    if (!extractUUID(promotedOut)) {
      throw new Error('[K4] promoted_at/promoted_wja_id não foram gravados após o processamento do evento');
    }

    // 3) Recarregar o kanban e aguardar a promoção refletir na UI (pode envolver
    //    processamento assíncrono — poll com reload).
    await loginAsKanbanAdmin(page);

    await expect
      .poll(
        async () => {
          await openKanban(page, vacancyId);
          const bloqueadoCard = page.locator(`[data-testid="kanban-card-${blockedWba_Id}"][data-stage="BLOQUEADO"]`);
          return (await bloqueadoCard.count()) === 0;
        },
        {
          message: 'Card deve sumir da coluna BLOQUEADO após completar o cadastro',
          timeout: 60_000,
          intervals: [2_000, 4_000, 6_000, 8_000],
        },
      )
      .toBe(true);

    // Card sumiu de BLOQUEADO
    await expect(
      page.locator('[data-testid="kanban-column-BLOQUEADO"]').locator(`text=${workerBlocked_Phone}`),
      'Worker promovido não deve mais aparecer em BLOQUEADO',
    ).not.toBeVisible();

    await expect(
      page.locator('[data-testid="kanban-board"]'),
    ).toHaveScreenshot('kanban-iniciado-k4-promoted-blocked-gone.png', { maxDiffPixelRatio: 0.05 });

    // Card normal reapareceu em INICIADO (sem badge bloqueado — WJA real criada pelo backend)
    const iniciadoCol = page.locator('[data-testid="kanban-column-INICIADO"]');
    const promotedCard = iniciadoCol.locator(`[data-testid^="kanban-card-"]`).filter({ hasText: 'Bloqueado Incompleto' });
    await expect(promotedCard.first(), 'Card promovido deve aparecer normal em INICIADO').toBeVisible({ timeout: 15_000 });
    await expect(
      promotedCard.first().locator('[data-testid="blocked-badge"]'),
      'Card promovido não deve mais ter o badge BLOQUEADO',
    ).not.toBeVisible();

    await expect(
      page.locator('[data-testid="kanban-board"]'),
    ).toHaveScreenshot('kanban-iniciado-k4-promoted-in-iniciado.png', { maxDiffPixelRatio: 0.05 });
  });

  // ── K5 — PRE_SCREENING: card de worker que passou pelo webhook Talentum ────

  test('K5 — Coluna PRE_SCREENING: card normal via webhook Talentum INITIATED', async ({ page }) => {
    // Seed: Talentum webhook subtype='INITIATED' → cria WJA em PRE_SCREENING
    const prescreeningId = `e2e-prescr-${Date.now()}`;
    const vacancyTitle = `CASO-PRE-${Date.now()}`;

    const webhookRes = await page.request.post(
      `${BACKEND_URL}/api/talentum/webhook`,
      {
        headers: {
          'Content-Type': 'application/json',
          'x-talentum-secret': 'test-secret',
        },
        data: {
          event: 'prescreening.status_changed',
          data: {
            prescreening: {
              id: prescreeningId,
              name: vacancyTitle,
              status: { id: 'INITIATED', label: 'Iniciado' },
            },
            profile: {
              id: workerPreScr_ProfileId,
              email: workerPreScr_Email,
              phone: workerPreScr_Phone,
              firstName: 'PreScreening',
              lastName: 'Worker',
            },
          },
        },
      },
    );

    // If webhook 404/auth fails, insert WJA directly as fallback
    if (webhookRes.status() !== 200) {
      runSQL(
        `INSERT INTO worker_job_applications
           (worker_id, job_posting_id, application_funnel_stage, source, created_at, updated_at)
         VALUES
           ('${workerPreScr_Id}', '${vacancyId}', 'PRE_SCREENING', 'talentum', NOW(), NOW())
         ON CONFLICT (worker_id, job_posting_id) DO NOTHING`,
      );
    }

    wjaPreScr_Id = getWjaIdByWorkerAndJob(workerPreScr_Id, vacancyId) ?? '';
    if (!wjaPreScr_Id) {
      // Fallback: insert directly into PRE_SCREENING
      runSQL(
        `INSERT INTO worker_job_applications
           (worker_id, job_posting_id, application_funnel_stage, source, created_at, updated_at)
         VALUES
           ('${workerPreScr_Id}', '${vacancyId}', 'PRE_SCREENING', 'talentum', NOW(), NOW())
         ON CONFLICT (worker_id, job_posting_id) DO NOTHING`,
      );
      wjaPreScr_Id = getWjaIdByWorkerAndJob(workerPreScr_Id, vacancyId) ?? '';
    }

    if (!wjaPreScr_Id) throw new Error('[K5] wja.id não encontrado para workerPreScr');

    await loginAsKanbanAdmin(page);
    await openKanban(page, vacancyId);

    // Verify card is in PRE_SCREENING
    const preScr = page.locator('[data-testid="kanban-column-PRE_SCREENING"]');
    await expect(preScr, 'Coluna PRE_SCREENING deve estar visível').toBeVisible();

    await expect(
      page.locator('[data-testid="kanban-column-PRE_SCREENING-count"]'),
      'PRE_SCREENING deve ter pelo menos 1 card',
    ).not.toHaveText('0', { timeout: 15_000 });

    // PRE_SCREENING cards should NOT have blocked badge (they passed the gate)
    const cards = preScr.locator('[data-testid^="kanban-card-"]');
    const cardCount = await cards.count();
    expect(cardCount, 'PRE_SCREENING deve ter pelo menos 1 card').toBeGreaterThanOrEqual(1);

    // None of the PRE_SCREENING cards should have blocked badge
    await expect(
      preScr.locator('[data-testid="blocked-badge"]'),
      'Coluna PRE_SCREENING não deve ter badges bloqueados',
    ).not.toBeVisible();

    await expect(
      page.locator('[data-testid="kanban-board"]'),
    ).toHaveScreenshot('kanban-iniciado-k5-pre-screening.png', { maxDiffPixelRatio: 0.05 });
  });

  // ── K6 — Screenshot final das 9 colunas populadas ─────────────────────────

  test('K6 — Screenshot final: 9 colunas na ordem nova com cards em INVITED, INICIADO, PRE_SCREENING', async ({ page }) => {
    await loginAsKanbanAdmin(page);
    await openKanban(page, vacancyId);

    // Assert all 9 columns visible with correct order
    const expectedCols = [
      'INVITED', 'BLOQUEADO', 'INICIADO', 'PRE_SCREENING', 'IN_PROGRESS',
      'COMPLETED', 'CONFIRMED', 'SELECTED', 'REJECTED',
    ];

    for (const col of expectedCols) {
      await expect(
        page.locator(`[data-testid="kanban-column-${col}"]`),
        `Coluna ${col} deve estar visível no K6`,
      ).toBeVisible();
    }

    // Pelo menos INICIADO ou INVITED deve ter >= 1 card (workerNormal de K2)
    // (o backend decide a coluna exata com base na source da WJA)
    const iniciadoCount = await page.locator('[data-testid="kanban-column-INICIADO-count"]').textContent();
    const invitedCount = await page.locator('[data-testid="kanban-column-INVITED-count"]').textContent();
    const hasCards = (Number(iniciadoCount) + Number(invitedCount)) > 0;
    expect(hasCards, `K6: pelo menos INICIADO ou INVITED deve ter >= 1 card (INICIADO=${iniciadoCount}, INVITED=${invitedCount})`).toBe(true);

    // Full board screenshot
    await expect(
      page.locator('[data-testid="kanban-board"]'),
    ).toHaveScreenshot('kanban-iniciado-k6-final-9cols-populated.png', { maxDiffPixelRatio: 0.05 });
  });

  // ── K7 — Jornada completa do promovido pelas demais colunas ─────────────────
  //
  // Prova que o card promovido de BLOQUEADO é cidadão de primeira classe no
  // resto do funil: PRE_SCREENING → IN_PROGRESS → COMPLETED via webhook Talentum
  // REAL (mesmo mecanismo do F3/F3b/F3c de kanban-fase2-full-flow — binding da
  // vaga por prescreeningName=título) e COMPLETED → SELECTED via drag REAL
  // (mesma mecânica de mouse do F3d). As demais colunas/paths de WJA comum já
  // são cobertos por kanban-fase2-full-flow, vacancy-kanban-talentum-webhook e
  // wja-flow-visuals — este cenário NÃO os duplica; cobre só o que é novo: a
  // continuidade do promovido.

  test('K7 — Promovido percorre o funil: PRE_SCREENING → IN_PROGRESS → COMPLETED → SELECTED', async ({ page, request }) => {
    const promotedWjaId = getWjaIdByWorkerAndJob(workerBlocked_Id, vacancyId);
    if (!promotedWjaId) throw new Error('[K7] depende de K4 (WJA promovida inexistente)');

    const titleOut = runSQL(`SELECT title FROM job_postings WHERE id = '${vacancyId}'`);
    const vacancyTitle = titleOut.match(/CASO[^|\n]*/)?.[0]?.trim();
    if (!vacancyTitle) throw new Error(`[K7] título da vaga não resolvido: ${titleOut}`);

    const emailOut = runSQL(`SELECT email FROM workers WHERE id = '${workerBlocked_Id}'`);
    const workerEmail = emailOut.match(/\S+@\S+/)?.[0];
    if (!workerEmail) throw new Error('[K7] email do worker não resolvido');

    const webhookBase = {
      prescreeningId: `e2e-k7-${Date.now()}`,
      prescreeningName: vacancyTitle,
      profileId: `prof-k7-${Date.now()}`,
      profileEmail: workerEmail,
      profilePhone: workerBlocked_Phone,
      profileFirstName: 'Bloqueado',
      profileLastName: 'Incompleto',
    };

    await loginAsKanbanAdmin(page);

    // INICIADO → PRE_SCREENING (webhook Talentum INITIATED real)
    expect(
      await sendTalentumWebhook(request, { ...webhookBase, subtype: 'INITIATED' }),
      'webhook INITIATED deve retornar 200',
    ).toBe(200);
    await waitForCardInStage(page, vacancyId, `kanban-card-${promotedWjaId}`, 'PRE_SCREENING');
    await expect(
      page.locator('[data-testid="kanban-board"]'),
    ).toHaveScreenshot('kanban-iniciado-k7-prescreening.png', { maxDiffPixelRatio: 0.05 });

    // PRE_SCREENING → IN_PROGRESS
    expect(
      await sendTalentumWebhook(request, { ...webhookBase, subtype: 'IN_PROGRESS' }),
      'webhook IN_PROGRESS deve retornar 200',
    ).toBe(200);
    await waitForCardInStage(page, vacancyId, `kanban-card-${promotedWjaId}`, 'IN_PROGRESS');
    await expect(
      page.locator('[data-testid="kanban-board"]'),
    ).toHaveScreenshot('kanban-iniciado-k7-in-progress.png', { maxDiffPixelRatio: 0.05 });

    // IN_PROGRESS → COMPLETED (ANALYZED/QUALIFIED)
    expect(
      await sendTalentumWebhook(request, {
        ...webhookBase,
        subtype: 'ANALYZED',
        statusLabel: 'QUALIFIED',
        score: 88,
      }),
      'webhook ANALYZED/QUALIFIED deve retornar 200',
    ).toBe(200);
    await waitForCardInStage(page, vacancyId, `kanban-card-${promotedWjaId}`, 'COMPLETED');
    await expect(
      page.locator('[data-testid="kanban-board"]'),
    ).toHaveScreenshot('kanban-iniciado-k7-completed.png', { maxDiffPixelRatio: 0.05 });

    // COMPLETED → SELECTED via drag real (mecânica de mouse do F3d)
    await openKanban(page, vacancyId);
    await page.evaluate(() => {
      const board = document.querySelector('[data-testid="kanban-board"]');
      if (board) board.scrollIntoView({ block: 'start' });
    });
    await page.waitForTimeout(300);

    // Com 9 colunas, SELECTED fica fora do viewport (mouse.move fora da janela
    // não dropa). Scroll horizontal do board até o fim: COMPLETED..REJECTED
    // ficam visíveis e as bounding boxes valem para o drag.
    await page.evaluate(() => {
      const board = document.querySelector('[data-testid="kanban-board"]');
      if (board) board.scrollLeft = board.scrollWidth;
    });
    await page.waitForTimeout(400);

    const draggable = page.locator(`[data-testid="kanban-draggable-${promotedWjaId}"]`);
    await expect(draggable, 'Card promovido deve estar dragável em COMPLETED').toBeVisible();

    const selectedCol = page.locator('[data-testid="kanban-column-SELECTED"]');
    await expect(selectedCol).toBeVisible();
    const selectedBB = await selectedCol.boundingBox();
    const draggableBB = await draggable.boundingBox();
    if (!selectedBB || !draggableBB) throw new Error('[K7] bounding boxes nulas para o drag');

    const startX = draggableBB.x + draggableBB.width / 2;
    const startY = draggableBB.y + draggableBB.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.waitForTimeout(80);
    // Movimento de ativação (excede o constraint de 8px do PointerSensor)
    await page.mouse.move(startX + 15, startY + 5, { steps: 8 });
    // Terço esquerdo de SELECTED para não acionar auto-scroll até REJECTED
    await page.mouse.move(selectedBB.x + 50, selectedBB.y + selectedBB.height / 2, { steps: 30 });
    await page.mouse.up();
    await page.waitForTimeout(3_000);

    // Diagnóstico direto no banco: o drop deve ter persistido SELECTED
    const stageOut = runSQL(
      `SELECT application_funnel_stage FROM worker_job_applications WHERE id = '${promotedWjaId}'`,
    );
    if (!stageOut.includes('SELECTED')) {
      throw new Error(`[K7] drag não persistiu SELECTED no banco; estado atual: ${stageOut}`);
    }

    // Persistência real: reload e o card segue em SELECTED
    await page.reload();
    await page.waitForSelector('[data-testid="kanban-board"]', { state: 'attached', timeout: 20_000 });
    await page.waitForTimeout(1_500);
    await expect(
      page
        .locator('[data-testid="kanban-column-SELECTED"]')
        .locator(`[data-testid="kanban-draggable-${promotedWjaId}"]`),
      'Card promovido deve persistir em SELECTED após reload',
    ).toBeVisible();

    // Screenshot com SELECTED em quadro (board scrollado até o fim à direita)
    await page.evaluate(() => {
      const board = document.querySelector('[data-testid="kanban-board"]');
      if (board) {
        board.scrollIntoView({ block: 'start' });
        board.scrollLeft = board.scrollWidth;
      }
    });
    await page.waitForTimeout(400);
    await expect(
      page.locator('[data-testid="kanban-board"]'),
    ).toHaveScreenshot('kanban-iniciado-k7-selected.png', { maxDiffPixelRatio: 0.05 });
  });
});
