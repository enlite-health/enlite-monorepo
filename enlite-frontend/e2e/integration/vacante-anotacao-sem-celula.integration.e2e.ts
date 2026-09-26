/**
 * vacante-anotacao-sem-celula.integration.e2e.ts @integration
 *
 * Integration E2E — Fase 3 da change cadeia-paciente-vacante-itinerario
 * (`CH/execucao/fase-3.md`, P24, DX-3.15): prova o critério 13 — anotação da
 * vaga exige a célula `vacancy:update`, não só `vacancy:read` — com o engine
 * ABAC de verdade LIGADO, não com token `role: 'admin'` (memória
 * `stack-e2e-abac-ligado`: role admin sem célula não prova nada sob engine
 * ligado, e passa até na variante sem engine).
 *
 * Stack isolada `cadeia-f3-abac` (postgres 5474 / api 8104 / Vite 5182) — NÃO
 * é a `cadeia-f3` dos demais e2e da fase (essa continua com o engine OFF).
 * `PERMISSION_ENGINE_ENABLED`/`PERMISSION_ENFORCED_ROUTES`/
 * `PERMISSION_CATALOG_SYNC_ENABLED`/`PERMISSION_CACHE_TTL_MS` vêm do
 * `docker-compose.group-simulation.yml` (o mesmo trio do job de CI); o
 * override `cadeia-f3-abac.override.yml` só troca porta/nome de container e
 * CORS/auth mock.
 *
 * Usuários reais (`seedStaffInGroup`/`grantCell` de `abac-stack-helper.ts`),
 * célula concedida ANTES do 1º request:
 *   - staff RO: grupo com `vacancy:read` apenas.
 *   - staff RW: grupo com `vacancy:read` + `vacancy:update`.
 *
 * Exercises:
 *   P24 — vacante-anotacao-sem-celula: `POST .../notes` com RO → 403 (banco
 *         inalterado); com RW → 201. Na tela, RO abre a vaga e vê a nota de RW
 *         (GET só exige `read`) mas o botão "Nueva anotación"
 *         (`vacancy-notes-new-button`) está AUSENTE; RW, em sessão separada,
 *         vê o botão.
 */

import { test, expect } from '@playwright/test';
import { insertTestPatient, insertBaseVacancy, cleanupTestPatient } from '../helpers/db-test-helper';
import {
  loginAs,
  tokenFor,
  seedStaffInGroup,
  cleanupStaffAndGroup,
  grantCell,
  scalar,
  ABAC_API_URL,
  type MockUser,
} from '../helpers/abac-stack-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

const RO_UID = `e2e-int-vacnotes-ro-${RUN_ID}`;
const RO_EMAIL = `${RO_UID}@e2e.test`;
const RW_UID = `e2e-int-vacnotes-rw-${RUN_ID}`;
const RW_EMAIL = `${RW_UID}@e2e.test`;

const STAFF_RO: MockUser = { uid: RO_UID, email: RO_EMAIL, role: 'recruiter', country: 'AR' };
const STAFF_RW: MockUser = { uid: RW_UID, email: RW_EMAIL, role: 'recruiter', country: 'AR' };

test.describe('vaga sem célula de escrita não anota @integration', () => {
  test.use({
    viewport: { width: 1366, height: 768 },
    deviceScaleFactor: 1,
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
  });
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(90_000);

  let patientId = '';
  let vacancyId = '';
  let groupRoId = '';
  let groupRwId = '';

  test.beforeAll(() => {
    const { patientId: pId, addressId } = insertTestPatient({
      withAddress: true,
      firstName: 'VacNotesSemCelula',
      lastName: `Seed-${RUN_ID}`,
    });
    patientId = pId;
    const caseNumber = 987_000 + Math.floor(Math.random() * 900);
    vacancyId = insertBaseVacancy({
      patientId,
      patientAddressId: addressId!,
      caseNumber,
      status: 'SEARCHING',
      isDraft: false,
    });

    // Célula CONCEDIDA antes do 1º request (o override liga PERMISSION_CACHE_TTL_MS=30000
    // — conceder depois do 1º request deixaria o cache antigo valer por até 30s).
    ({ groupId: groupRoId } = seedStaffInGroup({
      uid: RO_UID,
      email: RO_EMAIL,
      groupName: `Vac Notes RO ${RUN_ID}`,
      country: 'AR',
    }));
    grantCell(groupRoId, 'vacancy', 'read');

    ({ groupId: groupRwId } = seedStaffInGroup({
      uid: RW_UID,
      email: RW_EMAIL,
      groupName: `Vac Notes RW ${RUN_ID}`,
      country: 'AR',
    }));
    grantCell(groupRwId, 'vacancy', 'read');
    grantCell(groupRwId, 'vacancy', 'update');
  });

  test.afterAll(() => {
    try {
      cleanupStaffAndGroup(RO_UID, groupRoId);
    } catch (err) {
      console.error('[cleanup] staff RO falhou (seguindo)', err);
    }
    try {
      cleanupStaffAndGroup(RW_UID, groupRwId);
    } catch (err) {
      console.error('[cleanup] staff RW falhou (seguindo)', err);
    }
    try {
      cleanupTestPatient(patientId);
    } catch (err) {
      console.error('[cleanup] vaga/paciente falhou (seguindo)', err);
    }
  });

  test('vacante-anotacao-sem-celula', async ({ page, request, browser }) => {
    const notePayload = {
      occurredAt: new Date().toISOString(),
      category: 'CONTATO',
      contact: 'Colega con permiso de escritura',
      body: 'Nota creada por API con vacancy:update',
    };

    // 1. RO (só vacancy:read): POST /notes → 403, banco inalterado.
    const resRo = await request.post(`${ABAC_API_URL}/api/admin/vacancies/${vacancyId}/notes`, {
      headers: { Authorization: `Bearer ${tokenFor(STAFF_RO)}` },
      data: notePayload,
      failOnStatusCode: false,
    });
    expect(resRo.status(), 'POST /notes com vacancy:read apenas').toBe(403);
    const countAfterRo = scalar(`select count(*) from job_posting_notes where job_posting_id='${vacancyId}'`);
    expect(countAfterRo, 'job_posting_notes inalterado após 403').toBe('0');

    // 2. RW (vacancy:read + vacancy:update): POST /notes → 201.
    const resRw = await request.post(`${ABAC_API_URL}/api/admin/vacancies/${vacancyId}/notes`, {
      headers: { Authorization: `Bearer ${tokenFor(STAFF_RW)}` },
      data: notePayload,
    });
    expect(resRw.status(), 'POST /notes com vacancy:update').toBe(201);
    const countAfterRw = scalar(`select count(*) from job_posting_notes where job_posting_id='${vacancyId}'`);
    expect(countAfterRw, 'job_posting_notes tem 1 registro após 201').toBe('1');

    console.log('[3.13] sem-celula POST=', resRo.status(), 'com-celula POST=', resRw.status());

    // 3. RO na tela: vê a nota de RW (GET só exige vacancy:read), mas o botão
    // "Nueva anotación" está ausente (gate vacancy:update, VacancyNotesPanel.tsx:27).
    await loginAs(page, STAFF_RO);
    await page.goto(`/admin/vacancies/${vacancyId}`);
    await page.getByTestId('vacancy-tab-notes').click();
    await expect(page.getByTestId('vacancy-notes-panel')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(notePayload.contact)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('vacancy-notes-new-button')).toHaveCount(0);

    if (process.env.PRINT_DIR) {
      await page.screenshot({ path: `${process.env.PRINT_DIR}/vacante-anotacao-sem-celula-ro.png`, fullPage: true });
    }

    // 4. RW em sessão separada (browser novo, memória `e2e-humano-nao-e-fill` —
    // login humano, não reaproveita a sessão de RO): o botão aparece.
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await loginAs(page2, STAFF_RW);
    await page2.goto(`/admin/vacancies/${vacancyId}`);
    await page2.getByTestId('vacancy-tab-notes').click();
    await expect(page2.getByTestId('vacancy-notes-panel')).toBeVisible({ timeout: 15_000 });
    await expect(page2.getByTestId('vacancy-notes-new-button')).toBeVisible({ timeout: 15_000 });
    await ctx2.close();
  });
});
