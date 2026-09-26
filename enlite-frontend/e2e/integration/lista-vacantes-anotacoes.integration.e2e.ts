/**
 * lista-vacantes-anotacoes.integration.e2e.ts @integration
 *
 * Integration E2E — Fase 3 da change cadeia-paciente-vacante-itinerario
 * (`CH/execucao/fase-3.md`, P20-P23): anotações CRM da vaga (aba
 * "Anotaciones", DX-3.3/DX-3.8), "última ação" (DX-3.5) e "dias sem
 * divulgação" (DX-3.6) na lista de vacantes, e a ordem literal das colunas
 * novas (DX-3.7). Frontend real (Vite) + backend real (Docker,
 * USE_MOCK_AUTH=true) + Postgres real, mesma estratégia de auth de
 * `funil-vacante.integration.e2e.ts`.
 *
 * Exercises:
 *   P20 — vacante-anotacao-crm: nota pela tela (click + keyboard.type),
 *         "cuándo" no padrão, ordem mais-recente-primeiro, API == tela.
 *   P21 — lista-vacantes-ultima-acao: a célula bate com o `occurredAt` da
 *         nota, e um PUT que só toca `updated_at` NÃO move a célula
 *         (controle positivo de que `updated_at` avançou).
 *   P22 — lista-vacantes-colunas: ordem literal das 14 colunas + 1 listagem
 *         por página (nenhuma por-vaga).
 *   P23 — lista-vacantes-dias-sem-divulgacao: dias de calendário (Buenos
 *         Aires) desde a última nota DIVULGACAO; sem nota → "sin registro",
 *         nunca "0".
 */

import { readFileSync } from 'fs';
import { test, expect } from '@playwright/test';
import { insertTestPatient, insertBaseVacancy, cleanupTestPatient } from '../helpers/db-test-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { loginAs, tokenFor, type MockUser } from '../helpers/abac-stack-helper';
import {
  seedMockStaff,
  cleanupMockStaff,
  createNoteViaUi,
  listNotesApi,
  readVacancyListRow,
} from '../helpers/vacancy-notes-e2e-helper';

const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:8080';

const MOCK_STAFF: MockUser = {
  uid: 'e2e-int-staff-vacancy-notes',
  email: 'staff.vacancy.notes@e2e.test',
  role: 'admin',
  country: 'AR',
};

test.describe('lista de vacantes e anotações @integration', () => {
  test.use({
    viewport: { width: 1366, height: 768 },
    deviceScaleFactor: 1,
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
  });
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(90_000);

  let patientA = '';
  let patientB = '';
  let patientC = '';
  let patientD = '';
  let vacancyA = '';
  let vacancyB = '';
  let vacancyC = '';
  let vacancyD = '';

  function seedVacancy(label: string, updatedAtSql?: string): { patientId: string; vacancyId: string } {
    const { patientId, addressId } = insertTestPatient({
      withAddress: true,
      firstName: 'ListaVacantesNotes',
      lastName: `${label}-${Date.now()}`,
    });
    const caseNumber = 988_000 + Math.floor(Math.random() * 900);
    const vacancyId = insertBaseVacancy({
      patientId,
      patientAddressId: addressId!,
      caseNumber,
      status: 'SEARCHING',
      isDraft: false,
      ...(updatedAtSql ? { updatedAtSql } : {}),
    });
    return { patientId, vacancyId };
  }

  test.beforeAll(() => {
    seedMockStaff(MOCK_STAFF, 'E2E Staff Vacancy Notes');

    ({ patientId: patientA, vacancyId: vacancyA } = seedVacancy('A'));
    ({ patientId: patientB, vacancyId: vacancyB } = seedVacancy('B'));
    ({ patientId: patientC, vacancyId: vacancyC } = seedVacancy('C'));
    // VD: `updated_at` recuado 10 dias — a sabotagem/controle positivo do P21
    // depende de que a fonte da "última ação" NÃO seja essa coluna (DX-3.5).
    ({ patientId: patientD, vacancyId: vacancyD } = seedVacancy('D', "NOW() - interval '10 days'"));
  });

  test.afterAll(() => {
    for (const patientId of [patientA, patientB, patientC, patientD]) {
      try {
        cleanupTestPatient(patientId);
      } catch (err) {
        console.error('[cleanup] patient falhou (seguindo)', err);
      }
    }
    try {
      cleanupMockStaff(MOCK_STAFF);
    } catch (err) {
      console.error('[cleanup] staff falhou (seguindo)', err);
    }
  });

  // ── P20 · anotação pela tela: CRM da vaga ──────────────────────────────────
  test('vacante-anotacao-crm', async ({ page, request }) => {
    // 1. Nota antiga por API (fora da ordem "mais recente primeiro" que a
    // nota criada pela tela vai ocupar).
    const oldOccurredAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const postRes = await request.post(`${BACKEND_URL}/api/admin/vacancies/${vacancyA}/notes`, {
      headers: { Authorization: `Bearer ${tokenFor(MOCK_STAFF)}` },
      data: { occurredAt: oldOccurredAt, category: 'OUTRO', contact: 'Coordinación', body: 'Nota de control previa' },
    });
    expect(postRes.status(), 'POST /notes (nota antiga, setup)').toBe(201);

    // 2. loginAs; abre a vaga; aba Anotaciones.
    await loginAs(page, MOCK_STAFF);
    await page.goto(`/admin/vacancies/${vacancyA}`);
    await page.getByTestId('vacancy-tab-notes').click();
    await expect(page.getByTestId('vacancy-notes-panel')).toBeVisible({ timeout: 15_000 });

    // Primeira linha depois da navegação: o print.
    if (process.env.PRINT_DIR) {
      await page.screenshot({ path: `${process.env.PRINT_DIR}/vacante-abas.png`, fullPage: true });
    }

    // "Cuándo" no padrão (agora), não vazio — confere ANTES de salvar, num
    // open/cancel próprio (createNoteViaUi é atômico: abre, preenche e salva
    // numa chamada só, sem deixar espaço para espiar o valor no meio).
    await page.getByTestId('vacancy-notes-new-button').click();
    const whenInput = page.getByTestId('vacancy-note-when');
    await expect(whenInput).toBeVisible();
    const defaultWhen = await whenInput.inputValue();
    expect(defaultWhen, 'cuándo default não vazio').not.toBe('');
    await page.getByTestId('vacancy-note-cancel').click();

    // 3. Cria a nota de verdade pela tela.
    const status = await createNoteViaUi(page, {
      category: 'CONTATO',
      contact: 'Madre del paciente',
      body: 'Llamada: confirma disponibilidad',
    });
    expect(status, 'POST /notes (criação pela tela)').toBe(201);

    // 4. API: [0] é a nova, [1] é a antiga.
    const notes = await listNotesApi(request, BACKEND_URL, tokenFor(MOCK_STAFF), vacancyA);
    expect(notes[0].category, 'notes[0].category').toBe('CONTATO');
    expect(notes[0].contact, 'notes[0].contact').toBe('Madre del paciente');
    expect(notes[0].body, 'notes[0].body').toBe('Llamada: confirma disponibilidad');
    expect(notes[0].createdBy, 'notes[0].createdBy').toBe(`staff:${MOCK_STAFF.uid}`);
    expect(notes[0].authorEmail, 'notes[0].authorEmail').toBe(MOCK_STAFF.email);
    expect(notes[1].category, 'notes[1] é a nota antiga').toBe('OUTRO');

    // 5. Tela: a 1ª linha é a nova, a 2ª é a antiga.
    const rows = page.locator('[data-testid^="vacancy-note-row-"]');
    await expect(rows).toHaveCount(2, { timeout: 15_000 });
    await expect(rows.nth(0)).toContainText('Madre del paciente');
    await expect(rows.nth(1)).toContainText('Coordinación');
  });

  // ── P21 · "última ação" bate com a nota, PUT não some com ela ──────────────
  test('lista-vacantes-ultima-acao', async ({ page, request }) => {
    // 1. VD (sem candidatura, updated_at de 10 dias): nota 3 dias atrás.
    await loginAs(page, MOCK_STAFF);
    await page.goto(`/admin/vacancies/${vacancyD}`);
    await page.getByTestId('vacancy-tab-notes').click();
    await expect(page.getByTestId('vacancy-notes-panel')).toBeVisible({ timeout: 15_000 });

    const status = await createNoteViaUi(page, {
      daysAgo: 3,
      category: 'OUTRO',
      contact: 'Coordinación',
      body: 'Revisión de la vacante',
    });
    expect(status, 'POST /notes (VD, 3 dias atrás)').toBe(201);

    // 2. API: lastActionAt == occurredAt da nota.
    const notes = await listNotesApi(request, BACKEND_URL, tokenFor(MOCK_STAFF), vacancyD);
    const note = notes[0];
    const rowBefore = await readVacancyListRow(request, BACKEND_URL, tokenFor(MOCK_STAFF), vacancyD);
    expect(Date.parse(rowBefore.lastActionAt as string), 'row.lastActionAt == note.occurredAt').toBe(
      Date.parse(note.occurredAt),
    );

    // 3. Tela: a célula mostra a mesma data formatada (opções literais, não
    // importadas — não repetir no teste a mesma fonte que a fase implementa).
    // `timeZone` explícito: `formatDateTime` (draftVacancyFormat.ts:37-52) não
    // recebe fuso — quem aplica é o navegador, e o `test.use` deste describe
    // fixa `timezoneId: 'America/Argentina/Buenos_Aires'` (linha 52). Sem o
    // `timeZone` aqui, `esperado` sai no fuso do PROCESSO Node (o runner), que
    // diverge do navegador (CI = UTC, dev local = -03 → 3h de diferença; ver
    // memória `teste-de-fuso-passa-por-coincidencia`).
    await page.goto('/admin/vacancies');
    await expect(page.getByTestId(`vacancy-row-${vacancyD}`)).toBeVisible({ timeout: 15_000 });
    const esperado = new Date(note.occurredAt).toLocaleString('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    await expect(page.getByTestId(`vacancies-row-${vacancyD}-last-action`)).toHaveText(esperado);

    // 4. Controle positivo: um PUT que só reafirma o `status` atual ainda
    // avança `updated_at` (gatilho genérico da 011) — e a "última ação" NÃO
    // pode seguir esse avanço (DX-3.5 proíbe `updated_at` como fonte).
    const antes = Number(runSQL(`select extract(epoch from updated_at) from job_postings where id='${vacancyD}'`));
    const putRes = await request.put(`${BACKEND_URL}/api/admin/vacancies/${vacancyD}`, {
      headers: { Authorization: `Bearer ${tokenFor(MOCK_STAFF)}` },
      data: { status: 'SEARCHING' },
    });
    expect(putRes.status(), 'PUT /vacancies/:id (status)').toBe(200);
    const depois = Number(runSQL(`select extract(epoch from updated_at) from job_postings where id='${vacancyD}'`));
    console.log('[3.4] updated_at antes=', antes, 'depois=', depois);
    expect(depois, 'updated_at avançou (controle positivo)').toBeGreaterThan(antes);

    // 5. Recarrega a lista: a célula continua igual, e a API confirma que
    // `lastActionAt` não mudou.
    await page.reload();
    await expect(page.getByTestId(`vacancy-row-${vacancyD}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`vacancies-row-${vacancyD}-last-action`)).toHaveText(esperado);
    const rowAfter = await readVacancyListRow(request, BACKEND_URL, tokenFor(MOCK_STAFF), vacancyD);
    expect(Date.parse(rowAfter.lastActionAt as string), 'lastActionAt inalterado após o PUT').toBe(
      Date.parse(note.occurredAt),
    );
  });

  // ── P22 · ordem literal das colunas + 1 listagem por página ────────────────
  test('lista-vacantes-colunas', async ({ page }) => {
    const requestUrls: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'GET') requestUrls.push(req.url());
    });

    await loginAs(page, MOCK_STAFF);

    const [listResponse] = await Promise.all([
      page.waitForResponse((r) => /\/api\/admin\/vacancies\?/.test(r.url()) && r.request().method() === 'GET'),
      page.goto('/admin/vacancies'),
    ]);
    expect(listResponse.ok(), 'GET /api/admin/vacancies falhou').toBe(true);
    await expect(page.getByTestId(`vacancy-row-${vacancyA}`)).toBeVisible({ timeout: 15_000 });

    // Primeira linha depois da navegação: o print.
    if (process.env.PRINT_DIR) {
      await page.screenshot({ path: `${process.env.PRINT_DIR}/lista-vacantes.png`, fullPage: true });
    }

    const ids = await page
      .locator('[data-testid^="vacancies-col-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
    expect(ids).toEqual([
      'vacancies-col-case',
      'vacancies-col-status',
      'vacancies-col-priority',
      'vacancies-col-last-action',
      'vacancies-col-days-without-divulgation',
      'vacancies-col-INVITED',
      'vacancies-col-INICIADO',
      'vacancies-col-PRE_SCREENING',
      'vacancies-col-COMPLETED',
      'vacancies-col-CONFIRMED',
      'vacancies-col-SELECTED',
      'vacancies-col-REJECTED',
      'vacancies-col-applicants',
      'vacancies-col-missing',
    ]);

    const listagensDistintas = new Set(requestUrls.filter((u) => /\/api\/admin\/vacancies\?/.test(u))).size;
    const porVaga = requestUrls.filter((u) => /\/api\/admin\/vacancies\/[0-9a-f-]{36}/.test(u)).length;
    console.log('[3.8] listagens distintas=', listagensDistintas, 'por-vaga=', porVaga);
    expect(listagensDistintas, 'listagens distintas').toBe(1);
    expect(porVaga, 'requests por-vaga nesta tela').toBe(0);
  });

  // ── P23 · dias sem divulgação (calendário de Buenos Aires) ─────────────────
  test('lista-vacantes-dias-sem-divulgacao', async ({ page, request }) => {
    // VB: nota DIVULGACAO 5 dias atrás.
    await loginAs(page, MOCK_STAFF);
    await page.goto(`/admin/vacancies/${vacancyB}`);
    await page.getByTestId('vacancy-tab-notes').click();
    await expect(page.getByTestId('vacancy-notes-panel')).toBeVisible({ timeout: 15_000 });
    const statusB = await createNoteViaUi(page, {
      daysAgo: 5,
      category: 'DIVULGACAO',
      contact: 'Grupo Facebook Palermo',
      body: 'Publicación del aviso',
    });
    expect(statusB, 'POST /notes (VB, DIVULGACAO)').toBe(201);

    // VC: nota CONTATO (sem DIVULGACAO nenhuma) → "sin registro".
    await page.goto(`/admin/vacancies/${vacancyC}`);
    await page.getByTestId('vacancy-tab-notes').click();
    await expect(page.getByTestId('vacancy-notes-panel')).toBeVisible({ timeout: 15_000 });
    const statusC = await createNoteViaUi(page, {
      category: 'CONTATO',
      contact: 'Hija',
      body: 'Consulta',
    });
    expect(statusC, 'POST /notes (VC, CONTATO)').toBe(201);

    await page.goto('/admin/vacancies');
    await expect(page.getByTestId(`vacancy-row-${vacancyB}`)).toBeVisible({ timeout: 15_000 });

    await expect(page.getByTestId(`vacancies-row-${vacancyB}-days-without-divulgation`)).toHaveText('5');

    const semRegistro = JSON.parse(readFileSync('src/infrastructure/i18n/locales/es.json', 'utf8')).admin.vacancies
      .table.noDivulgationRecord;
    const cellC = page.getByTestId(`vacancies-row-${vacancyC}-days-without-divulgation`);
    await expect(cellC).toHaveText(semRegistro);
    await expect(cellC).not.toHaveText('0');

    const rowB = await readVacancyListRow(request, BACKEND_URL, tokenFor(MOCK_STAFF), vacancyB);
    expect(rowB.daysWithoutDivulgation, 'VB.daysWithoutDivulgation').toBe(5);
    const rowC = await readVacancyListRow(request, BACKEND_URL, tokenFor(MOCK_STAFF), vacancyC);
    expect(rowC.daysWithoutDivulgation, 'VC.daysWithoutDivulgation').toBeNull();
  });

  // ── alt · "Cuándo" no futuro: o servidor recusa (400), a tela avisa ─────────
  test('vacante-anotacao-data-futura', async ({ page, request }) => {
    const notesBefore = await listNotesApi(request, BACKEND_URL, tokenFor(MOCK_STAFF), vacancyA);

    await loginAs(page, MOCK_STAFF);
    await page.goto(`/admin/vacancies/${vacancyA}`);
    await page.getByTestId('vacancy-tab-notes').click();
    await expect(page.getByTestId('vacancy-notes-panel')).toBeVisible({ timeout: 15_000 });

    const status = await createNoteViaUi(page, {
      daysAhead: 2,
      category: 'OUTRO',
      contact: 'Coordinación',
      body: 'Anotación con fecha futura (debe ser rechazada)',
    });
    expect(status, 'POST /notes (cuándo no futuro)').toBe(400);

    await expect(page.getByText('No se pudo guardar la anotación')).toBeVisible({ timeout: 15_000 });

    const notesAfter = await listNotesApi(request, BACKEND_URL, tokenFor(MOCK_STAFF), vacancyA);
    expect(notesAfter.length, 'nenhuma nota nova persistida').toBe(notesBefore.length);
  });
});
