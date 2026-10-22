/**
 * kanban-bloqueados-067.integration.e2e.ts @integration — spec 067 F7 (A2, A3, A4, FR-09, FR-11, R-1)
 *
 * E2E DE TELA, sem mock de resposta: frontend + API + Postgres reais (USE_MOCK_AUTH=true no stack), clique e teclado de humano.
 * `fill()`/SQL só MONTAM o cenário. Candidatura em etapa de Completado de prestador que NÃO está apto (documento obrigatório
 * não validado/apagado) aparece na coluna BLOQUEADOS do Kanban da vaga, com o selo de resultado da Talentum, e sai do seletor de
 * convocados; validar o documento devolve o card a Completado sem tocar na candidatura.
 *
 *  FELIZ — webhook ANALYZED+QUALIFIED de prestador REGISTERED com documentos enviados e NÃO validados -> card em Bloqueados com
 *          "Aprobado Talentum" -> o admin valida os dois documentos na ficha (clique) -> o card volta a Completado, mesmo selo.
 *  ALT 1 — prestador apto em Completado -> o admin tira a validação de um documento (clique) -> card em Bloqueados e fora do
 *          seletor de convocados do drawer de evento (só ABRE o seletor; nenhum evento é criado: o Calendar seria canal real).
 *  ALT 2 — o admin apaga um documento -> card em Bloqueados; a tentativa barrada da mesma vaga continua em Iniciados com a
 *          marca BLOQUEADO (D474); soltar um card EM Bloqueados não move nada (a coluna não é destino).
 *
 * Outbound (plan §6): o webhook da Talentum só grava (domain_events pending, sem Pub/Sub/Twilio neste stack); validar/invalidar/
 * apagar documento não saem; o DELETE usa URL fora do prefixo do prestador ("record_only", sem GCS). Nenhum evento de encuadre
 * é criado. Dados SINTÉTICOS (@test.local), sem PII.
 *
 * Pré-condições: API em localhost:8080 (USE_MOCK_AUTH=true), Vite em localhost:5173, Postgres no contêiner `E2E_PG_CONTAINER`.
 * Vídeo: `test.use({ video: 'on' })` (test-results/). Login pelo mock do stack de CI (`loginAsKanbanAdmin`), engine OFF.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  insertTestPatient,
  insertBaseVacancy,
  cleanupTestPatient,
  cleanupTestWorker,
} from '../helpers/db-test-helper';
import { insertAptoWorker, insertEligibilityWorker } from '../helpers/eligibility-worker-helper';
import {
  sendTalentumWebhook,
  loginAsKanbanAdmin,
  openKanban,
  waitForCardInStage,
  getEncuadreId,
  BACKEND_URL,
} from '../helpers/talentumWebhookHelper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { dndKitDrag } from '../helpers/dndKitDrag';

const RUN = Date.now().toString(36);
const caseNumber = (): number => 960_000 + Math.floor(Math.random() * 30_000);

interface Cenario { vacancyId: string; title: string }
const vacancies: string[] = [];
const workers: string[] = [];
let patientId = '';
let addressId = '';

function novaVaga(): Cenario {
  const n = caseNumber();
  const vacancyId = insertBaseVacancy({ patientId, patientAddressId: addressId, caseNumber: n, status: 'SEARCHING', isDraft: false });
  vacancies.push(vacancyId);
  return { vacancyId, title: `CASO ${n}-base` };
}

function candidatar(workerId: string, vacancyId: string, stage: string): void {
  runSQL(
    `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source) ` +
      `VALUES ('${workerId}', '${vacancyId}', '${stage}', 'talentum') ON CONFLICT (worker_id, job_posting_id) DO NOTHING`,
  );
}

// `runSQL` (patient-detail-a-helper) já devolve o valor cru (psql -tA) e aparado
const stageNoBanco = (workerId: string, vacancyId: string): string =>
  runSQL(`SELECT application_funnel_stage FROM worker_job_applications WHERE worker_id = '${workerId}' AND job_posting_id = '${vacancyId}'`);

const contagem = (sql: string): number => Number(runSQL(sql));

/** O card (wrapper com data-stage) de um prestador, pelo id da candidatura. */
const cardDe = (page: Page, wjaId: string) => page.locator(`[data-testid="kanban-card-${wjaId}"][data-stage]`).first();
const colunaCount = (page: Page, col: string) => page.locator(`[data-testid="kanban-column-${col}-count"]`);

/** Rola o quadro (na horizontal e até a borda superior) para a coluna `col` abrir à esquerda — o print e o arrasto enxergam as colunas do caso. */
async function focar(page: Page, col: string): Promise<void> {
  await page.evaluate((c) => {
    document.querySelector('[data-testid="kanban-board"]')?.scrollIntoView({ block: 'start' });
    document.querySelector(`[data-testid="kanban-column-${c}"]`)?.scrollIntoView({ block: 'nearest', inline: 'start' });
  }, col);
  await page.waitForTimeout(300);
}

/** A ficha do prestador: o clique de quem valida / tira a validação / apaga o documento. */
async function abrirFicha(page: Page, workerId: string): Promise<void> {
  await page.goto(`/admin/workers/${workerId}`);
  await expect(page.getByTestId('worker-documents-card')).toBeVisible({ timeout: 30_000 });
}

async function validarNaFicha(page: Page, docType: string): Promise<void> {
  const slot = page.getByTestId(`doc-slot-${docType}`);
  await slot.getByTestId(`validate-btn-${docType}`).click();
  await expect(page.getByTestId('confirm-validation-modal')).toBeVisible();
  await page.getByTestId('confirm-validation-btn').click();
  await expect(slot.getByTestId(`validation-badge-${docType}`)).toBeVisible({ timeout: 15_000 });
}

// 9 colunas lado a lado cabem no print (o quadro rola na horizontal em viewport menor)
test.use({ viewport: { width: 2800, height: 1100 }, video: 'on' });

test.describe('Kanban da vaga — coluna Bloqueados (spec 067) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  test.beforeAll(() => {
    const p = insertTestPatient({ withAddress: true, firstName: 'Ficticia', lastName: `Bloq067${RUN}` });
    patientId = p.patientId;
    addressId = p.addressId!;
  });

  test.afterAll(() => {
    for (const v of vacancies) {
      runSQL(`DELETE FROM worker_blocked_applications WHERE job_posting_id = '${v}'`);
      runSQL(`DELETE FROM talentum_prescreenings WHERE job_posting_id = '${v}'`);
      runSQL(`DELETE FROM encuadres WHERE job_posting_id = '${v}'`);
      runSQL(`DELETE FROM worker_job_applications WHERE job_posting_id = '${v}'`);
    }
    for (const w of workers) {
      runSQL(`DELETE FROM worker_documents WHERE worker_id = '${w}'`);
      runSQL(`DELETE FROM worker_availability WHERE worker_id = '${w}'`);
      runSQL(`DELETE FROM worker_service_areas WHERE worker_id = '${w}'`);
      cleanupTestWorker(w);
    }
    for (const v of vacancies) runSQL(`DELETE FROM job_postings WHERE id = '${v}'`);
    cleanupTestPatient(patientId);
  });

  // ── FELIZ ──────────────────────────────────────────────────────────────────

  test('FELIZ — webhook QUALIFIED de prestador não validado cai em Bloqueados com "Aprobado Talentum"; validar os 2 documentos na ficha devolve o card a Completado', async ({ page, request }) => {
    const { vacancyId, title } = novaVaga();
    const w = insertAptoWorker({ docs: 'unvalidated' });
    workers.push(w.workerId);
    const opts = {
      prescreeningId: `e2e-067-${RUN}`,
      prescreeningName: title,
      profileId: `prof-067-${RUN}`,
      profileEmail: w.email,
      profilePhone: w.phone!,
      profileFirstName: 'Ficticia',
      profileLastName: 'Teste',
    };
    // A4/FR-13: o webhook responde 200 e grava mesmo com o prestador incompleto (nenhuma checagem nova nele)
    expect(await sendTalentumWebhook(request, { ...opts, subtype: 'INITIATED' })).toBe(200);
    expect(await sendTalentumWebhook(request, { ...opts, subtype: 'ANALYZED', statusLabel: 'QUALIFIED', score: 85 })).toBe(200);
    expect(stageNoBanco(w.workerId, vacancyId)).toBe('QUALIFIED');

    await loginAsKanbanAdmin(page);
    const wja = await getEncuadreId(request, w.workerId, vacancyId);
    expect(wja).not.toBe('unknown');

    // 1. Bloqueados, com o selo de resultado da Talentum (FR-09) — e NÃO em Completado
    await waitForCardInStage(page, vacancyId, `kanban-card-${wja}`, 'BLOQUEADO');
    await expect(colunaCount(page, 'BLOQUEADO')).toHaveText('1');
    await expect(colunaCount(page, 'COMPLETED')).toHaveText('0');
    await expect(page.locator('[data-testid="kanban-column-BLOQUEADO"]').getByText('Bloqueados').first()).toBeVisible();
    await expect(cardDe(page, wja).getByTestId('completado-badge')).toHaveText('Aprobado Talentum');
    await focar(page, 'INICIADO');
    await expect(page.locator('[data-testid="kanban-board"]')).toHaveScreenshot('bloqueados-067-feliz-1-bloqueado.png', { maxDiffPixelRatio: 0.05 });

    // 2. o admin valida os dois documentos obrigatórios na ficha (clique humano)
    await abrirFicha(page, w.workerId);
    await validarNaFicha(page, 'identity_document');
    await validarNaFicha(page, 'criminal_record');
    await expect(page.getByTestId('worker-documents-card')).toHaveScreenshot('bloqueados-067-feliz-2-ficha-validada.png', { maxDiffPixelRatio: 0.05 });

    // 3. o card volta a Completado, com o MESMO selo; a candidatura não foi tocada (A3/R-1)
    await waitForCardInStage(page, vacancyId, `kanban-card-${wja}`, 'COMPLETED');
    await expect(colunaCount(page, 'COMPLETED')).toHaveText('1');
    await expect(colunaCount(page, 'BLOQUEADO')).toHaveText('0');
    await expect(cardDe(page, wja).getByTestId('completado-badge')).toHaveText('Aprobado Talentum');
    expect(stageNoBanco(w.workerId, vacancyId)).toBe('QUALIFIED');
    await focar(page, 'INICIADO');
    await expect(page.locator('[data-testid="kanban-board"]')).toHaveScreenshot('bloqueados-067-feliz-3-completado.png', { maxDiffPixelRatio: 0.05 });
  });

  // ── ALTERNATIVO 1 ──────────────────────────────────────────────────────────

  test('ALT 1 — tirar a validação de um apto em Completado o leva a Bloqueados e o tira do seletor de convocados (o seletor só abre; nenhum evento é criado)', async ({ page, request }) => {
    const { vacancyId } = novaVaga();
    const alvo = insertAptoWorker({ docs: 'validated' });
    const controle = insertAptoWorker({ docs: 'validated' });
    workers.push(alvo.workerId, controle.workerId);
    candidatar(alvo.workerId, vacancyId, 'COMPLETED');
    candidatar(controle.workerId, vacancyId, 'COMPLETED');

    await loginAsKanbanAdmin(page);
    const wjaAlvo = await getEncuadreId(request, alvo.workerId, vacancyId);
    const wjaControle = await getEncuadreId(request, controle.workerId, vacancyId);
    await waitForCardInStage(page, vacancyId, `kanban-card-${wjaAlvo}`, 'COMPLETED');
    await expect(colunaCount(page, 'COMPLETED')).toHaveText('2');
    await expect(colunaCount(page, 'BLOQUEADO')).toHaveText('0');

    // o admin tira a validação do documento de identidade (clique no X do selo verde)
    await abrirFicha(page, alvo.workerId);
    const slot = page.getByTestId('doc-slot-identity_document');
    await expect(slot.getByTestId('validation-badge-identity_document')).toBeVisible();
    await slot.getByRole('button', { name: 'Quitar validación' }).click();
    await expect(slot.getByTestId('validate-btn-identity_document')).toBeVisible({ timeout: 15_000 });

    // o alvo vai a Bloqueados; o controle (ainda apto) segue em Completado
    await waitForCardInStage(page, vacancyId, `kanban-card-${wjaAlvo}`, 'BLOQUEADO');
    await expect(cardDe(page, wjaControle)).toHaveAttribute('data-stage', 'COMPLETED');
    await expect(colunaCount(page, 'BLOQUEADO')).toHaveText('1');
    await expect(colunaCount(page, 'COMPLETED')).toHaveText('1');
    await focar(page, 'INICIADO');
    await expect(page.locator('[data-testid="kanban-board"]')).toHaveScreenshot('bloqueados-067-alt1-bloqueado.png', { maxDiffPixelRatio: 0.05 });

    // seletor de convocados do drawer de evento: o controle aparece, o alvo NÃO (só abre — nada é criado)
    await page.getByTestId('vacancy-tab-enquadre').click();
    await expect(page.getByTestId('enquadre-tab')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('enquadre-create-button').or(page.getByTestId('enquadre-empty-create-button')).first().click();
    await expect(page.getByTestId('enquadre-create-drawer')).toBeVisible();
    await expect(page.getByTestId(`enquadre-create-worker-checkbox-${controle.workerId}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`enquadre-create-worker-checkbox-${alvo.workerId}`)).toHaveCount(0);
    await expect(page.getByTestId('enquadre-create-drawer')).toHaveScreenshot('bloqueados-067-alt1-seletor.png', { maxDiffPixelRatio: 0.05, mask: [page.getByText(/ahora son las/)] });
    await page.keyboard.press('Escape');

    expect(contagem(`SELECT count(*) FROM enquadre_events WHERE job_posting_id = '${vacancyId}'`)).toBe(0);
    expect(stageNoBanco(alvo.workerId, vacancyId)).toBe('COMPLETED'); // a candidatura não foi tocada
  });

  // ── ALTERNATIVO 2 ──────────────────────────────────────────────────────────

  test('ALT 2 — apagar um documento leva o card a Bloqueados; a tentativa barrada segue em Iniciados com a marca; soltar um card em Bloqueados não move nada', async ({ page, request }) => {
    const { vacancyId } = novaVaga();
    const apagado = insertAptoWorker({ docs: 'validated' });
    const parado = insertAptoWorker({ docs: 'validated' });
    // cadastro incompleto de verdade (sem profissão): a tentativa de postular é barrada pelo portão e vira a "tentativa barrada"
    const barrado = insertEligibilityWorker({ occupation: null });
    workers.push(apagado.workerId, parado.workerId, barrado.workerId);
    candidatar(apagado.workerId, vacancyId, 'COMPLETED');
    candidatar(parado.workerId, vacancyId, 'COMPLETED');

    const token = await (async () => {
      const r = await request.post(`${BACKEND_URL}/api/test/auth/token`, { data: { uid: barrado.authUid, email: barrado.email, role: 'worker' } });
      expect(r.status()).toBe(200);
      return ((await r.json()) as { data: { token: string } }).data.token;
    })();
    const tentativa = await request.post(`${BACKEND_URL}/api/worker-applications/track-channel`, {
      data: { jobPostingId: vacancyId, channel: 'site' },
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(tentativa.status()).toBe(403); // a tentativa barrada nasce do portão real, não de SQL
    expect(contagem(`SELECT count(*) FROM worker_blocked_applications WHERE job_posting_id = '${vacancyId}'`)).toBe(1);

    await loginAsKanbanAdmin(page);
    const wjaApagado = await getEncuadreId(request, apagado.workerId, vacancyId);
    const wjaParado = await getEncuadreId(request, parado.workerId, vacancyId);
    await waitForCardInStage(page, vacancyId, `kanban-card-${wjaApagado}`, 'COMPLETED');

    // o admin apaga o documento de antecedentes (clique no "remover" do cartão)
    await abrirFicha(page, apagado.workerId);
    const slot = page.getByTestId('doc-slot-criminal_record');
    await slot.getByRole('button', { name: 'Remover documento' }).click();
    await expect(slot.getByTestId('validation-badge-criminal_record')).toHaveCount(0, { timeout: 15_000 });

    await waitForCardInStage(page, vacancyId, `kanban-card-${wjaApagado}`, 'BLOQUEADO');
    await expect(colunaCount(page, 'BLOQUEADO')).toHaveText('1');
    await expect(colunaCount(page, 'COMPLETED')).toHaveText('1');

    // a tentativa barrada continua em INICIADO com a marca BLOQUEADO (D474) — não foi para a coluna Bloqueados
    const iniciado = page.locator('[data-testid="kanban-column-INICIADO"]');
    await expect(iniciado.getByTestId('blocked-badge')).toHaveCount(1);
    await expect(page.locator('[data-testid="kanban-column-BLOQUEADO"]').getByTestId('blocked-badge')).toHaveCount(0);
    await focar(page, 'INICIADO');
    await expect(page.locator('[data-testid="kanban-board"]')).toHaveScreenshot('bloqueados-067-alt2-bloqueado-e-barrada.png', { maxDiffPixelRatio: 0.05 });

    // soltar um card EM Bloqueados não move nada: a coluna não é destino (droppable: false)
    const moves: string[] = [];
    page.on('request', (r) => { if (r.method() === 'PUT' && /\/api\/admin\/encuadres\/.+\/move/.test(r.url())) moves.push(r.url()); });
    await focar(page, 'BLOQUEADO');
    const arrastavel = page.locator(`[data-testid="kanban-draggable-${wjaParado}"]`);
    // Bloqueados não é destino: o board resolve o drop para a coluna HABILITADA de centro mais próximo (P20b, DX-5.16 — comportamento
    // anterior a esta spec). Quando isso abre o diálogo de papel (Seleccionados), a pessoa CANCELA: nada é confirmado, nada é gravado.
    await dndKitDrag(page, arrastavel, page.locator('[data-testid="kanban-column-BLOQUEADO"]'), { activationSteps: 8, mainSteps: 30, pauseAfterUp: 600 });
    await page.waitForTimeout(1_000);
    const dialogo = page.getByTestId('role-modal');
    if (await dialogo.count()) {
      test.info().annotations.push({ type: 'p20b', description: 'drop em Bloqueados resolveu para Seleccionados (diálogo de papel); cancelado' });
      await page.getByTestId('role-cancel').click();
    }
    await expect(dialogo).toHaveCount(0);
    await expect(page.getByTestId('move-reason-modal')).toHaveCount(0);
    // o que a spec exige: o card NÃO entrou em Bloqueados e nada foi gravado
    await expect(cardDe(page, wjaParado)).toHaveAttribute('data-stage', 'COMPLETED');
    await expect(colunaCount(page, 'BLOQUEADO')).toHaveText('1');
    await expect(colunaCount(page, 'COMPLETED')).toHaveText('1');
    expect(moves).toEqual([]);
    expect(stageNoBanco(parado.workerId, vacancyId)).toBe('COMPLETED');
    expect(stageNoBanco(apagado.workerId, vacancyId)).toBe('COMPLETED');
    await focar(page, 'INICIADO');
    await expect(page.locator('[data-testid="kanban-board"]')).toHaveScreenshot('bloqueados-067-alt2-soltar-nao-move.png', { maxDiffPixelRatio: 0.05 });
  });
});
