/**
 * vacancy-locked-fields-detail-and-draft.integration.e2e.ts @integration — spec 057 / T4.8
 * (D523: a vaga com serviço contratado lê os 5 campos de recrutamento do SERVIÇO). Fecha o furo que o gate
 * apontou: o e2e T4.5 prova a tela de EDIÇÃO; aqui estão as outras duas telas — DETALHE e RASCUNHO.
 *
 * Backend real + Postgres real + frontend real. Só o login é mock (stack de CI, engine OFF). Dado sintético.
 * O nome contém `vacancy-locked-fields`, token que o `grep:` do `pr-gate.yml` já roda no projeto `integration`.
 *
 *  Detalhe `/admin/vacancies/:id`
 *   1. feliz: vaga com serviço (sexo 'F', profissões AT) mostra os links de sexo e profissão para a ficha
 *      (aba Servicio Contratado); clique real no de sexo abre a ficha;
 *   2. alt: vaga manual (sem serviço) não mostra nenhum dos dois links;
 *   3. alt: serviço sem sexo (NULL) — o card mostra o valor vazio ("—") e o link da ficha continua lá.
 *  Rascunho `/admin/vacancies/:id/borrador`
 *   4. feliz: serviço com 2 dos 5 vazios → 1 item único "Completar 2 campos…" + link da ficha; os 4 itens
 *      individuais (tipo de profesional, disponible para, experiencia, plazo de pago) NÃO aparecem;
 *   5. alt: vaga manual → 7 itens, os 4 individuais presentes, sem link da ficha;
 *   6. alt: serviço com os 5 preenchidos → o item aparece "Completar 0 campos…" já concluído (check, sem
 *      círculo vazio) e o link da ficha segue lá (`linksToPatient`).
 *
 * O "serviço com campo vazio" é montado assim: o portão de ativar recrutamento exige os 5 preenchidos, então
 * o serviço nasce completo, é ativado pela API e só depois o campo é esvaziado por SQL (montagem de cenário).
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { RECRUITMENT_FIELDS_E2E } from '../helpers/recruitment-fields-e2e';
import { insertTestPatient, cleanupTestPatient, insertBaseVacancy, cleanupVacancies } from '../helpers/db-test-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { loginComoStaffMock } from '../helpers/login-mock-staff';
import { tokenFor, type MockUser } from '../helpers/abac-stack-helper';

const BACKEND_URL = process.env.E2E_BACKEND_URL ?? process.env.API_BASE_URL ?? 'http://localhost:8080';
const STAFF: MockUser = { uid: `e2e-vaga-detalhe-rascunho-${Date.now()}`, email: `e2e.vaga-detalhe-rascunho.${Date.now()}@enlite.health`, role: 'admin', country: 'AR' };
const AUTH_HEADERS = { Authorization: `Bearer ${tokenFor(STAFF)}`, 'Content-Type': 'application/json' };

const ITEM_UNICO = (n: number) => `Completar ${n} campos en la ficha del paciente`;
const ITENS_INDIVIDUAIS = ['Tipo de profesional', 'Disponible para', 'Experiencia requerida', 'Plazo de pago'];

test.describe('vacancy-locked-fields — detalhe e rascunho com os 5 campos do serviço (057) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  const pacientes: string[] = [];
  const vagas: string[] = [];
  test.afterAll(() => {
    cleanupVacancies(vagas);
    pacientes.forEach((id) => cleanupTestPatient(id));
  });

  function semearPaciente(nome: string) {
    const seeded = insertTestPatient({
      status: 'PENDING_ADMISSION', firstName: nome, lastName: `Patient${Date.now()}${pacientes.length}`,
      withAddress: true, hasConsent: true, insuranceInformed: 'OSDE',
    });
    pacientes.push(seeded.patientId);
    expect(seeded.addressId, 'insertTestPatient não devolveu addressId').toBeTruthy();
    return { patientId: seeded.patientId, addressId: seeded.addressId as string };
  }

  /** Cenário (API): serviço com os 5 campos + foguete → vaga em rascunho. `esvaziar` zera colunas do serviço depois. */
  async function semearVagaComServico(
    request: APIRequestContext,
    opts: { sexo?: 'F' | 'BOTH'; esvaziar?: string[]; publicada?: boolean } = {},
  ) {
    const { patientId, addressId } = semearPaciente('DetalheRascunho');
    const svc = await request.post(`${BACKEND_URL}/api/admin/patients/${patientId}/contracted-services`, {
      headers: AUTH_HEADERS,
      data: {
        serviceCode: 'AT', providersNeeded: 1, careLocation: 'HOME', ...RECRUITMENT_FIELDS_E2E,
        requiredSex: opts.sexo ?? 'F', addressId, schedule: [{ dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 }],
      },
    });
    expect(svc.ok(), `POST contracted-services falhou: ${svc.status()} ${await svc.text()}`).toBe(true);
    const serviceId = (await svc.json()).data.id as string;
    const act = await request.post(`${BACKEND_URL}/api/admin/patients/${patientId}/contracted-services/${serviceId}/activate-recruitment`, { headers: AUTH_HEADERS });
    expect(act.ok(), `activate-recruitment falhou: ${act.status()} ${await act.text()}`).toBe(true);
    const vacancyId = (await act.json()).data.vacancyId as string;
    vagas.push(vacancyId);
    if (opts.esvaziar?.length) {
      runSQL(`UPDATE patient_contracted_services SET ${opts.esvaziar.map((c) => `${c} = NULL`).join(', ')} WHERE id = '${serviceId}'`);
    }
    // Publicada: só o bit `is_draft` importa (publicar de verdade chamaria o Talentum — canal real proibido).
    if (opts.publicada) runSQL(`UPDATE job_postings SET is_draft = false WHERE id = '${vacancyId}'`);
    return { patientId, serviceId, vacancyId };
  }

  /** Cenário (SQL): vaga manual, sem serviço. */
  function semearVagaManual(publicada: boolean) {
    const { patientId, addressId } = semearPaciente('ManualDetalhe');
    const caseNumber = 960_000 + Math.floor(Math.random() * 9999);
    runSQL(`UPDATE patients SET case_number = ${caseNumber} WHERE id = '${patientId}'`);
    const vacancyId = insertBaseVacancy({ patientId, patientAddressId: addressId, caseNumber, status: 'PENDING_ACTIVATION', isDraft: true });
    vagas.push(vacancyId);
    if (publicada) runSQL(`UPDATE job_postings SET is_draft = false WHERE id = '${vacancyId}'`);
    return { patientId, vacancyId };
  }

  async function abrirDetalhe(page: Page, vacancyId: string) {
    await loginComoStaffMock(page, STAFF, 'E2E Detalhe Rascunho');
    await page.goto(`/admin/vacancies/${vacancyId}`);
    await expect(page.getByTestId('vacancy-profession-card')).toBeVisible({ timeout: 25_000 });
  }

  async function abrirRascunho(page: Page, vacancyId: string) {
    await loginComoStaffMock(page, STAFF, 'E2E Detalhe Rascunho');
    await page.goto(`/admin/vacancies/${vacancyId}`);
    await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${vacancyId}/borrador$`), { timeout: 25_000 });
    const card = page.locator('section', { has: page.getByRole('heading', { name: /Lo que falta/ }) });
    await expect(card).toBeVisible({ timeout: 25_000 });
    return card;
  }

  test('1. detalhe feliz — vaga com serviço: links de sexo e profissão levam à ficha (aba Servicio Contratado)', async ({ page, request }) => {
    const { patientId, vacancyId } = await semearVagaComServico(request, { sexo: 'F', publicada: true });
    const fichaPath = `/admin/patients/${patientId}`;
    await abrirDetalhe(page, vacancyId);

    for (const id of ['vacancy-sex-service-link', 'vacancy-profession-service-link']) {
      const link = page.getByTestId(id);
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute('href', new RegExp(`${fichaPath}.*tab=contractedService`));
    }

    // Clique real (abre em nova aba): confere a URL da aba nova e fecha.
    const [ficha] = await Promise.all([
      page.context().waitForEvent('page'),
      page.getByTestId('vacancy-sex-service-link').click(),
    ]);
    await expect(ficha).toHaveURL(new RegExp(`${fichaPath}\\?tab=contractedService$`), { timeout: 20_000 });
    await ficha.close();
  });

  test('2. detalhe alt — vaga manual (sem serviço): nenhum dos dois links', async ({ page }) => {
    const { vacancyId } = semearVagaManual(true);
    await abrirDetalhe(page, vacancyId);
    await expect(page.getByTestId('vacancy-sex-service-link')).toHaveCount(0);
    await expect(page.getByTestId('vacancy-profession-service-link')).toHaveCount(0);
  });

  test('3. detalhe alt — serviço sem sexo (NULL): o card mostra o valor vazio e o link da ficha continua', async ({ page, request }) => {
    const { vacancyId } = await semearVagaComServico(request, { esvaziar: ['required_sex'], publicada: true });
    await abrirDetalhe(page, vacancyId);
    const link = page.getByTestId('vacancy-sex-service-link');
    await expect(link).toBeVisible();
    await expect(link.locator('..')).toContainText('—');
  });

  test('4. rascunho feliz — serviço com 2 dos 5 vazios: 1 item único com "2" + link da ficha; os 4 individuais somem', async ({ page, request }) => {
    const { patientId, vacancyId } = await semearVagaComServico(request, { esvaziar: ['required_experience', 'work_schedule'] });
    const card = await abrirRascunho(page, vacancyId);

    await expect(card.getByText(ITEM_UNICO(2))).toBeVisible();
    const link = page.getByTestId('draft-todo-service-link');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', new RegExp(`/admin/patients/${patientId}.*tab=contractedService`));
    for (const rotulo of ITENS_INDIVIDUAIS) await expect(card.getByText(rotulo, { exact: true })).toHaveCount(0);
    await expect(card.locator('li')).toHaveCount(4);
  });

  test('5. rascunho alt — vaga manual: 7 itens, os 4 individuais presentes, sem link da ficha', async ({ page }) => {
    const { vacancyId } = semearVagaManual(false);
    const card = await abrirRascunho(page, vacancyId);

    await expect(card.locator('li')).toHaveCount(7);
    for (const rotulo of ITENS_INDIVIDUAIS) await expect(card.getByText(rotulo, { exact: true })).toBeVisible();
    await expect(page.getByTestId('draft-todo-service-link')).toHaveCount(0);
    await expect(card.getByText(/Completar \d+ campos en la ficha/)).toHaveCount(0);
  });

  test('6. rascunho alt — serviço com os 5 preenchidos: item "Completar 0 campos" concluído (check) e link segue', async ({ page, request }) => {
    const { vacancyId } = await semearVagaComServico(request);
    const card = await abrirRascunho(page, vacancyId);

    const item = card.locator('li', { hasText: ITEM_UNICO(0) });
    await expect(item).toBeVisible();
    // Concluído: o círculo vazio (borda) dá lugar ao check verde.
    await expect(item.locator('svg')).toHaveCount(1);
    await expect(item.getByTestId('draft-todo-service-link')).toBeVisible();
    await expect(card.locator('li')).toHaveCount(4);
  });
});
