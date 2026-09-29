/**
 * cid-na-vacante-tela.integration.e2e.ts @integration
 *
 * Gate `revisao-pr` (modo fecho) bloqueou o merge do CID-11-na-vaga por falta de e2e de TELA —
 * o e2e de API já existe e está verde (`worker-functions/tests/e2e/vacancy-diagnoses.e2e.test.ts`,
 * commit 16420026). Este arquivo cobre a TELA: a patología do paciente, lida na hora
 * (`loadVacancyPatientDiagnoses`, `worker-functions/src/modules/matching/application/
 * vacancyPatientDiagnoses.ts`), aparece em `VacancyProfessionCard` (tela de detalhe da vaga).
 *
 * Três estados, nunca confundidos (D286): `null` = ator sem `patient_clinical:read` (testid
 * `vacancy-profession-patologia-no-permission`) · `[]` = paciente sem diagnóstico (testid
 * `vacancy-profession-patologia-empty`, mostra "—") · lista = testid `vacancy-profession-patologias`.
 * Em NENHUM estado o código/URI do CID (`id.who.int`) chega ao DOM (REQ-21) — carrega
 * na tela via `data-testid`, nunca via atributo com a URI.
 *
 * Stack: molde `abac-stack-helper.ts` (engine ABAC ligado, `USE_MOCK_AUTH=true`) — mesmo
 * mecanismo de `admin-access-buttons-vacancies.integration.e2e.ts`/CI job
 * `integration-e2e-group-simulation`. `ABAC_API_URL`/`ABAC_TEST_DB_URL` setados no ambiente
 * (stack isolada desta sessão, projeto docker `cid-vacante-tela`, portas 8199/5799 — NUNCA as
 * default 8089/5439, que podem colidir com stack de outra sessão).
 *
 * Sem `page.route` de DADO: só o helper troca o header de auth (`swapToken`) — a REQUEST e a
 * RESPOSTA do `/api/admin/vacancies/:id` são reais, contra Postgres real.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  psql, scalar, safeSql, grantCell, seedStaffInGroup, cleanupStaffAndGroup, loginAs,
  type MockUser,
} from '../helpers/abac-stack-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const TENANT = '00000000-0000-0000-0000-000000000001';

const COM_CELULA_UID = `e2e-cidvaga-comcelula-${RUN_ID}`;
const COM_CELULA_EMAIL = `${COM_CELULA_UID}@e2e.test`;
const SEM_CELULA_UID = `e2e-cidvaga-semcelula-${RUN_ID}`;
const SEM_CELULA_EMAIL = `${SEM_CELULA_UID}@e2e.test`;

const COM_CELULA: MockUser = { uid: COM_CELULA_UID, email: COM_CELULA_EMAIL, role: 'recruiter', country: 'AR' };
const SEM_CELULA: MockUser = { uid: SEM_CELULA_UID, email: SEM_CELULA_EMAIL, role: 'recruiter', country: 'AR' };

let comCelulaGroupId = '';
let semCelulaGroupId = '';

// Paciente COM diagnóstico + a vaga dele (usado pelos testes 1 e 2 — mesma vaga, atores diferentes).
let patientComDiagnosticoId = '';
let addressComDiagnosticoId = '';
let vacancyComDiagnosticoId = '';
let diagnosisId = '';

// Paciente SEM diagnóstico + a vaga dele (usado pelo teste 3).
let patientSemDiagnosticoId = '';
let addressSemDiagnosticoId = '';
let vacancySemDiagnosticoId = '';

const DIAGNOSIS_TITLE = 'Diagnóstico fictício E2E — não é dado clínico real';

/** Navega para a tela de detalhe da vaga e espera a resposta do GET (mesmo molde de admissao-cid11-f3). */
async function openVacancy(page: Page, vacancyId: string): Promise<void> {
  const isDetail = new RegExp(`/api/admin/vacancies/${vacancyId}(\\?|$)`);
  const detail = page
    .waitForResponse((r) => r.request().method() === 'GET' && isDetail.test(r.url()), { timeout: 20_000 })
    .catch(() => null);
  await page.goto(`/admin/vacancies/${vacancyId}`);
  const res = await detail;
  expect(res, `GET /api/admin/vacancies/${vacancyId} não observado`).not.toBeNull();
}

test.describe('CID-11 na vaga — tela de detalhe (VacancyProfessionCard) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    const comCelula = seedStaffInGroup({ uid: COM_CELULA_UID, email: COM_CELULA_EMAIL, groupName: `E2E CID Vaga Com Célula ${RUN_ID}`, country: 'AR' });
    comCelulaGroupId = comCelula.groupId;
    grantCell(comCelulaGroupId, 'vacancy', 'read');
    grantCell(comCelulaGroupId, 'patient_clinical', 'read');

    const semCelula = seedStaffInGroup({ uid: SEM_CELULA_UID, email: SEM_CELULA_EMAIL, groupName: `E2E CID Vaga Sem Célula ${RUN_ID}`, country: 'AR' });
    semCelulaGroupId = semCelula.groupId;
    grantCell(semCelulaGroupId, 'vacancy', 'read');
    // Deliberadamente SEM patient_clinical:read — é o ator do teste 2.

    // ── Paciente COM diagnóstico ────────────────────────────────────────────
    const taskComDiag = `E2E-CIDVAGA-COM-${RUN_ID}`;
    psql(`INSERT INTO patients (clickup_task_id, first_name, last_name, status, diagnosis, dependency_level, country, created_at, updated_at)
          VALUES ('${taskComDiag}', 'E2E', 'ComDiagnostico ${RUN_ID}', 'ACTIVE', 'TEA leve', 'SEVERE', 'AR', NOW(), NOW())`);
    patientComDiagnosticoId = scalar(`SELECT id FROM patients WHERE clickup_task_id = '${taskComDiag}'`);
    if (!patientComDiagnosticoId) throw new Error('paciente COM diagnóstico não foi inserido');

    psql(`INSERT INTO patient_addresses (patient_id, address_formatted, address_raw, lat, lng, display_order, source, created_at, updated_at)
          VALUES ('${patientComDiagnosticoId}', 'Av. Corrientes 1234, CABA, AR', 'Av. Corrientes 1234, CABA', -34.6037, -58.3816, 1, 'manual', NOW(), NOW())`);
    addressComDiagnosticoId = scalar(`SELECT id FROM patient_addresses WHERE patient_id = '${patientComDiagnosticoId}' LIMIT 1`);
    if (!addressComDiagnosticoId) throw new Error('endereço (com diagnóstico) não foi inserido');

    psql(`INSERT INTO job_postings (
            vacancy_number, case_number, title, description,
            patient_id, patient_address_id,
            required_professions, required_sex, providers_needed,
            status, is_draft, country, created_at, updated_at
          ) VALUES (
            nextval('job_postings_vacancy_number_seq'), 910001, 'CASO E2E CID vaga com diagnóstico', '',
            '${patientComDiagnosticoId}', '${addressComDiagnosticoId}',
            ARRAY['AT']::varchar[], NULL, 1,
            'SEARCHING', false, 'AR', NOW(), NOW()
          )`);
    vacancyComDiagnosticoId = scalar(`SELECT id FROM job_postings WHERE patient_id = '${patientComDiagnosticoId}' ORDER BY created_at DESC LIMIT 1`);
    if (!vacancyComDiagnosticoId) throw new Error('vaga (com diagnóstico) não foi inserida');

    diagnosisId = scalar(`INSERT INTO patient_diagnoses (
            patient_id, terminology_system, concept_uri, concept_code, concept_title,
            concept_language, concept_group, catalog_release, source, is_primary, active,
            created_by, updated_by
          ) VALUES (
            '${patientComDiagnosticoId}', 'ICD-11', 'http://id.who.int/icd/release/11/e2e-fake-uri', '9A00',
            '${DIAGNOSIS_TITLE}', 'es', '06', '2026-01', 'PANEL', true, true,
            '${COM_CELULA_UID}', '${COM_CELULA_UID}'
          ) RETURNING id`);
    if (!diagnosisId) throw new Error('diagnóstico e2e não foi inserido');

    // ── Paciente SEM diagnóstico ─────────────────────────────────────────────
    const taskSemDiag = `E2E-CIDVAGA-SEM-${RUN_ID}`;
    psql(`INSERT INTO patients (clickup_task_id, first_name, last_name, status, diagnosis, dependency_level, country, created_at, updated_at)
          VALUES ('${taskSemDiag}', 'E2E', 'SemDiagnostico ${RUN_ID}', 'ACTIVE', 'TEA leve', 'SEVERE', 'AR', NOW(), NOW())`);
    patientSemDiagnosticoId = scalar(`SELECT id FROM patients WHERE clickup_task_id = '${taskSemDiag}'`);
    if (!patientSemDiagnosticoId) throw new Error('paciente SEM diagnóstico não foi inserido');

    psql(`INSERT INTO patient_addresses (patient_id, address_formatted, address_raw, lat, lng, display_order, source, created_at, updated_at)
          VALUES ('${patientSemDiagnosticoId}', 'Av. Santa Fe 4321, CABA, AR', 'Av. Santa Fe 4321, CABA', -34.5875, -58.4205, 1, 'manual', NOW(), NOW())`);
    addressSemDiagnosticoId = scalar(`SELECT id FROM patient_addresses WHERE patient_id = '${patientSemDiagnosticoId}' LIMIT 1`);
    if (!addressSemDiagnosticoId) throw new Error('endereço (sem diagnóstico) não foi inserido');

    psql(`INSERT INTO job_postings (
            vacancy_number, case_number, title, description,
            patient_id, patient_address_id,
            required_professions, required_sex, providers_needed,
            status, is_draft, country, created_at, updated_at
          ) VALUES (
            nextval('job_postings_vacancy_number_seq'), 910002, 'CASO E2E CID vaga sem diagnóstico', '',
            '${patientSemDiagnosticoId}', '${addressSemDiagnosticoId}',
            ARRAY['AT']::varchar[], NULL, 1,
            'SEARCHING', false, 'AR', NOW(), NOW()
          )`);
    vacancySemDiagnosticoId = scalar(`SELECT id FROM job_postings WHERE patient_id = '${patientSemDiagnosticoId}' ORDER BY created_at DESC LIMIT 1`);
    if (!vacancySemDiagnosticoId) throw new Error('vaga (sem diagnóstico) não foi inserida');
  });

  test.afterAll(() => {
    safeSql(`DELETE FROM patient_diagnoses WHERE patient_id IN ('${patientComDiagnosticoId}', '${patientSemDiagnosticoId}')`);
    safeSql(`DELETE FROM job_postings WHERE id IN ('${vacancyComDiagnosticoId}', '${vacancySemDiagnosticoId}')`);
    safeSql(`DELETE FROM patient_addresses WHERE patient_id IN ('${patientComDiagnosticoId}', '${patientSemDiagnosticoId}')`);
    safeSql(`DELETE FROM patients WHERE id IN ('${patientComDiagnosticoId}', '${patientSemDiagnosticoId}')`);
    cleanupStaffAndGroup(COM_CELULA_UID, comCelulaGroupId);
    cleanupStaffAndGroup(SEM_CELULA_UID, semCelulaGroupId);
  });

  test('1. FELIZ — ator COM patient_clinical:read vê o título da patología (e o CID não está no DOM)', async ({ page }) => {
    await loginAs(page, COM_CELULA);
    await openVacancy(page, vacancyComDiagnosticoId);

    const patologias = page.getByTestId('vacancy-profession-patologias');
    await expect(patologias).toBeVisible({ timeout: 15_000 });
    await expect(patologias).toContainText(DIAGNOSIS_TITLE);

    await expect(page.getByTestId('vacancy-profession-patologia-no-permission')).toHaveCount(0);
    await expect(page.getByTestId('vacancy-profession-patologia-unavailable')).toHaveCount(0);

    // REQ-21: nunca o código/URI do CID no DOM.
    const html = await page.content();
    expect(html).not.toContain('id.who.int');
    expect(html).not.toContain('9A00');
  });

  test('2. SEM PERMISSÃO — ator SEM patient_clinical:read vê o aviso, NUNCA "—" (protege o paciente)', async ({ page }) => {
    await loginAs(page, SEM_CELULA);
    await openVacancy(page, vacancyComDiagnosticoId);

    const noPermission = page.getByTestId('vacancy-profession-patologia-no-permission');
    await expect(noPermission).toBeVisible({ timeout: 15_000 });
    await expect(noPermission).toContainText('No tenés permiso');

    // O caso que protege o paciente: SEM permissão não pode aparecer como "sem diagnóstico".
    await expect(page.getByTestId('vacancy-profession-patologia-empty')).toHaveCount(0);
    await expect(page.getByTestId('vacancy-profession-patologias')).toHaveCount(0);
    await expect(page.getByTestId('vacancy-profession-patologia-unavailable')).toHaveCount(0);

    const html = await page.content();
    expect(html).not.toContain('id.who.int');
    expect(html).not.toContain('9A00');
    expect(html).not.toContain(DIAGNOSIS_TITLE);
  });

  test('3. SEM DIAGNÓSTICO — paciente sem diagnóstico mostra "—" (distinto de sem permissão)', async ({ page }) => {
    await loginAs(page, COM_CELULA);
    await openVacancy(page, vacancySemDiagnosticoId);

    const empty = page.getByTestId('vacancy-profession-patologia-empty');
    await expect(empty).toBeVisible({ timeout: 15_000 });
    await expect(empty).toHaveText('—');

    await expect(page.getByTestId('vacancy-profession-patologia-no-permission')).toHaveCount(0);
    await expect(page.getByTestId('vacancy-profession-patologias')).toHaveCount(0);
    await expect(page.getByTestId('vacancy-profession-patologia-unavailable')).toHaveCount(0);

    const html = await page.content();
    expect(html).not.toContain('id.who.int');
  });
});

/**
 * Extensão (gate `revisao-pr`, BLOCKER): as 3 telas que faltavam cobertura de TELA —
 * `DraftVacancyKnownCard` (rascunho), `VacancyFormLeftColumn` (modal criar/editar) e
 * `CaseDetailsModal`. Mesmo molde do describe acima: `page.route` só troca o header de auth
 * (`loginAs`), a REQUEST e a RESPOSTA das APIs são reais.
 *
 * `CaseDetailsModal` NÃO tem teste aqui — grep confirma que nenhuma página o importa
 * (`grep -rln "CaseDetailsModal" src --include="*.tsx" | grep -v __tests__` só devolve o
 * próprio arquivo do componente): é órfão, sem rota real para alcançá-lo. Cobri-lo exigiria
 * `page.route` fabricando dado (a regra deste arquivo proíbe) — NÃO VIÁVEL, ver report.
 */

// ── RASCUNHO (DraftVacancyKnownCard) ────────────────────────────────────────────────────────

test.describe('CID-11 na vaga — tela de RASCUNHO (DraftVacancyKnownCard) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  const RUN_ID_DRAFT = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

  const COM_CLINICA_UID = `e2e-cidrasc-comclinica-${RUN_ID_DRAFT}`;
  const COM_CLINICA_EMAIL = `${COM_CLINICA_UID}@e2e.test`;
  const SEM_CLINICA_UID = `e2e-cidrasc-semclinica-${RUN_ID_DRAFT}`;
  const SEM_CLINICA_EMAIL = `${SEM_CLINICA_UID}@e2e.test`;

  const COM_CLINICA: MockUser = { uid: COM_CLINICA_UID, email: COM_CLINICA_EMAIL, role: 'recruiter', country: 'AR' };
  const SEM_CLINICA: MockUser = { uid: SEM_CLINICA_UID, email: SEM_CLINICA_EMAIL, role: 'recruiter', country: 'AR' };

  let comClinicaGroupId = '';
  let semClinicaGroupId = '';

  let patientComDiagId = '';
  let addressComDiagId = '';
  let vacancyComDiagId = '';
  let draftDiagnosisId = '';

  let patientSemDiagId = '';
  let addressSemDiagId = '';
  let vacancySemDiagId = '';

  const DRAFT_DIAGNOSIS_TITLE = 'Diagnóstico fictício E2E rascunho — não é dado clínico real';

  /**
   * Navega para a tela de RASCUNHO e espera as DUAS leituras assíncronas de que a patología
   * depende: o GET da vaga (`useVacancyDetail`) e o GET do paciente (`AdminApiService
   * .getPatientById`, 2ª leitura — é dela que `patient.diagnoses` vem, D440/gate revisao-pr).
   * Sem esperar a 2ª, o teste correria contra a janela "—" transitória (aceita, ver
   * `DraftVacancyPage.tsx`) e não contra o estado final.
   */
  async function openDraftVacancy(page: Page, vacancyId: string, patientId: string): Promise<void> {
    const isVacancyGet = new RegExp(`/api/admin/vacancies/${vacancyId}(\\?|$)`);
    const isPatientGet = new RegExp(`/api/admin/patients/${patientId}(\\?|$)`);
    const vacancyRes = page
      .waitForResponse((r) => r.request().method() === 'GET' && isVacancyGet.test(r.url()), { timeout: 20_000 })
      .catch(() => null);
    const patientRes = page
      .waitForResponse((r) => r.request().method() === 'GET' && isPatientGet.test(r.url()), { timeout: 20_000 })
      .catch(() => null);
    await page.goto(`/admin/vacancies/${vacancyId}/borrador`);
    const [vRes, pRes] = await Promise.all([vacancyRes, patientRes]);
    expect(vRes, `GET /api/admin/vacancies/${vacancyId} não observado`).not.toBeNull();
    expect(pRes, `GET /api/admin/patients/${patientId} não observado`).not.toBeNull();
  }

  test.beforeAll(() => {
    // `patient:read` (base) é exigido pela ROTA `GET /patients/:id` (adminPatientsRoutes.ts) —
    // sem ela a 2ª leitura 403a, `patient` fica `null` para sempre, e o card trava na janela
    // "—" (não é "sem permissão"). `patient_clinical:read` é o container que decide SE
    // `diagnoses` vem array ou `null` dentro dessa resposta (D286) — célula DIFERENTE da de
    // acesso à rota. Os dois atores têm as duas primeiras; só COM_CLINICA tem a terceira.
    const comClinica = seedStaffInGroup({ uid: COM_CLINICA_UID, email: COM_CLINICA_EMAIL, groupName: `E2E CID Rascunho Com Clínica ${RUN_ID_DRAFT}`, country: 'AR' });
    comClinicaGroupId = comClinica.groupId;
    grantCell(comClinicaGroupId, 'vacancy', 'read');
    grantCell(comClinicaGroupId, 'patient', 'read');
    grantCell(comClinicaGroupId, 'patient_clinical', 'read');

    const semClinica = seedStaffInGroup({ uid: SEM_CLINICA_UID, email: SEM_CLINICA_EMAIL, groupName: `E2E CID Rascunho Sem Clínica ${RUN_ID_DRAFT}`, country: 'AR' });
    semClinicaGroupId = semClinica.groupId;
    grantCell(semClinicaGroupId, 'vacancy', 'read');
    grantCell(semClinicaGroupId, 'patient', 'read');
    // Deliberadamente SEM patient_clinical:read — é o ator do teste 2 (o que protege o paciente).

    // ── Paciente COM diagnóstico + vaga RASCUNHO (is_draft=true) ────────────────────────────
    const taskComDiag = `E2E-CIDRASC-COM-${RUN_ID_DRAFT}`;
    psql(`INSERT INTO patients (clickup_task_id, first_name, last_name, status, diagnosis, dependency_level, country, created_at, updated_at)
          VALUES ('${taskComDiag}', 'E2E', 'RascComDiagnostico ${RUN_ID_DRAFT}', 'ACTIVE', 'TEA leve', 'SEVERE', 'AR', NOW(), NOW())`);
    patientComDiagId = scalar(`SELECT id FROM patients WHERE clickup_task_id = '${taskComDiag}'`);
    if (!patientComDiagId) throw new Error('paciente COM diagnóstico (rascunho) não foi inserido');

    psql(`INSERT INTO patient_addresses (patient_id, address_formatted, address_raw, lat, lng, display_order, source, created_at, updated_at)
          VALUES ('${patientComDiagId}', 'Av. Rivadavia 5000, CABA, AR', 'Av. Rivadavia 5000, CABA', -34.6158, -58.4333, 1, 'manual', NOW(), NOW())`);
    addressComDiagId = scalar(`SELECT id FROM patient_addresses WHERE patient_id = '${patientComDiagId}' LIMIT 1`);
    if (!addressComDiagId) throw new Error('endereço (rascunho, com diagnóstico) não foi inserido');

    psql(`INSERT INTO job_postings (
            vacancy_number, case_number, title, description,
            patient_id, patient_address_id,
            required_professions, required_sex, providers_needed,
            status, is_draft, country, created_at, updated_at
          ) VALUES (
            nextval('job_postings_vacancy_number_seq'), 910011, 'CASO E2E CID rascunho com diagnóstico', '',
            '${patientComDiagId}', '${addressComDiagId}',
            ARRAY['AT']::varchar[], NULL, 1,
            'SEARCHING', true, 'AR', NOW(), NOW()
          )`);
    vacancyComDiagId = scalar(`SELECT id FROM job_postings WHERE patient_id = '${patientComDiagId}' ORDER BY created_at DESC LIMIT 1`);
    if (!vacancyComDiagId) throw new Error('vaga RASCUNHO (com diagnóstico) não foi inserida');

    draftDiagnosisId = scalar(`INSERT INTO patient_diagnoses (
            patient_id, terminology_system, concept_uri, concept_code, concept_title,
            concept_language, concept_group, catalog_release, source, is_primary, active,
            created_by, updated_by
          ) VALUES (
            '${patientComDiagId}', 'ICD-11', 'http://id.who.int/icd/release/11/e2e-fake-uri-rasc', '9A01',
            '${DRAFT_DIAGNOSIS_TITLE}', 'es', '06', '2026-01', 'PANEL', true, true,
            '${COM_CLINICA_UID}', '${COM_CLINICA_UID}'
          ) RETURNING id`);
    if (!draftDiagnosisId) throw new Error('diagnóstico e2e (rascunho) não foi inserido');

    // ── Paciente SEM diagnóstico + vaga RASCUNHO (is_draft=true) ────────────────────────────
    const taskSemDiag = `E2E-CIDRASC-SEM-${RUN_ID_DRAFT}`;
    psql(`INSERT INTO patients (clickup_task_id, first_name, last_name, status, diagnosis, dependency_level, country, created_at, updated_at)
          VALUES ('${taskSemDiag}', 'E2E', 'RascSemDiagnostico ${RUN_ID_DRAFT}', 'ACTIVE', 'TEA leve', 'SEVERE', 'AR', NOW(), NOW())`);
    patientSemDiagId = scalar(`SELECT id FROM patients WHERE clickup_task_id = '${taskSemDiag}'`);
    if (!patientSemDiagId) throw new Error('paciente SEM diagnóstico (rascunho) não foi inserido');

    psql(`INSERT INTO patient_addresses (patient_id, address_formatted, address_raw, lat, lng, display_order, source, created_at, updated_at)
          VALUES ('${patientSemDiagId}', 'Av. Cabildo 2500, CABA, AR', 'Av. Cabildo 2500, CABA', -34.5613, -58.4593, 1, 'manual', NOW(), NOW())`);
    addressSemDiagId = scalar(`SELECT id FROM patient_addresses WHERE patient_id = '${patientSemDiagId}' LIMIT 1`);
    if (!addressSemDiagId) throw new Error('endereço (rascunho, sem diagnóstico) não foi inserido');

    psql(`INSERT INTO job_postings (
            vacancy_number, case_number, title, description,
            patient_id, patient_address_id,
            required_professions, required_sex, providers_needed,
            status, is_draft, country, created_at, updated_at
          ) VALUES (
            nextval('job_postings_vacancy_number_seq'), 910012, 'CASO E2E CID rascunho sem diagnóstico', '',
            '${patientSemDiagId}', '${addressSemDiagId}',
            ARRAY['AT']::varchar[], NULL, 1,
            'SEARCHING', true, 'AR', NOW(), NOW()
          )`);
    vacancySemDiagId = scalar(`SELECT id FROM job_postings WHERE patient_id = '${patientSemDiagId}' ORDER BY created_at DESC LIMIT 1`);
    if (!vacancySemDiagId) throw new Error('vaga RASCUNHO (sem diagnóstico) não foi inserida');
  });

  test.afterAll(() => {
    safeSql(`DELETE FROM patient_diagnoses WHERE patient_id IN ('${patientComDiagId}', '${patientSemDiagId}')`);
    safeSql(`DELETE FROM job_postings WHERE id IN ('${vacancyComDiagId}', '${vacancySemDiagId}')`);
    safeSql(`DELETE FROM patient_addresses WHERE patient_id IN ('${patientComDiagId}', '${patientSemDiagId}')`);
    safeSql(`DELETE FROM patients WHERE id IN ('${patientComDiagId}', '${patientSemDiagId}')`);
    cleanupStaffAndGroup(COM_CLINICA_UID, comClinicaGroupId);
    cleanupStaffAndGroup(SEM_CLINICA_UID, semClinicaGroupId);
  });

  test('1. FELIZ — ator COM patient_clinical:read vê o título da patología no rascunho (e o CID não está no DOM)', async ({ page }) => {
    await loginAs(page, COM_CLINICA);
    await openDraftVacancy(page, vacancyComDiagId, patientComDiagId);

    const patologias = page.getByTestId('draft-vacancy-patologias');
    await expect(patologias).toBeVisible({ timeout: 15_000 });
    await expect(patologias).toContainText(DRAFT_DIAGNOSIS_TITLE);

    await expect(page.getByTestId('draft-vacancy-patologias-no-permission')).toHaveCount(0);
    await expect(page.getByTestId('draft-vacancy-patologias-unavailable')).toHaveCount(0);
    await expect(page.getByTestId('draft-vacancy-patologias-empty')).toHaveCount(0);

    const html = await page.content();
    expect(html).not.toContain('id.who.int');
    expect(html).not.toContain('9A01');
  });

  test('2. SEM PERMISSÃO — ator SEM patient_clinical:read vê o aviso no rascunho, NUNCA "—" (o achado do gate revisao-pr, D440)', async ({ page }) => {
    await loginAs(page, SEM_CLINICA);
    await openDraftVacancy(page, vacancyComDiagId, patientComDiagId);

    const noPermission = page.getByTestId('draft-vacancy-patologias-no-permission');
    await expect(noPermission).toBeVisible({ timeout: 15_000 });
    await expect(noPermission).toContainText('No tenés permiso');

    // O caso que protege o paciente (D440): a versão anterior de `DraftVacancyPage.tsx`
    // decidia a permissão de novo no cliente e colapsava este `null` do servidor em "—".
    await expect(page.getByTestId('draft-vacancy-patologias-empty')).toHaveCount(0);
    await expect(page.getByTestId('draft-vacancy-patologias')).toHaveCount(0);
    await expect(page.getByTestId('draft-vacancy-patologias-unavailable')).toHaveCount(0);

    const html = await page.content();
    expect(html).not.toContain('id.who.int');
    expect(html).not.toContain('9A01');
    expect(html).not.toContain(DRAFT_DIAGNOSIS_TITLE);
  });

  test('3. SEM DIAGNÓSTICO — paciente sem diagnóstico mostra "—" no rascunho (distinto de sem permissão)', async ({ page }) => {
    await loginAs(page, COM_CLINICA);
    await openDraftVacancy(page, vacancySemDiagId, patientSemDiagId);

    const empty = page.getByTestId('draft-vacancy-patologias-empty');
    await expect(empty).toBeVisible({ timeout: 15_000 });
    await expect(empty).toHaveText('—');

    await expect(page.getByTestId('draft-vacancy-patologias-no-permission')).toHaveCount(0);
    await expect(page.getByTestId('draft-vacancy-patologias')).toHaveCount(0);
    await expect(page.getByTestId('draft-vacancy-patologias-unavailable')).toHaveCount(0);

    const html = await page.content();
    expect(html).not.toContain('id.who.int');
  });
});

// ── MODAL CRIAR/EDITAR (VacancyFormLeftColumn) ──────────────────────────────────────────────

test.describe('CID-11 na vaga — modal criar/editar (VacancyFormLeftColumn) @integration', () => {
  test.setTimeout(120_000);

  const RUN_ID_MODAL = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const SEM_CLINICA_UID = `e2e-cidmodal-semclinica-${RUN_ID_MODAL}`;
  const SEM_CLINICA_EMAIL = `${SEM_CLINICA_UID}@e2e.test`;
  const SEM_CLINICA: MockUser = { uid: SEM_CLINICA_UID, email: SEM_CLINICA_EMAIL, role: 'recruiter', country: 'AR' };

  let groupId = '';
  let patientId = '';
  let addressId = '';
  let vacancyId = '';

  const MODAL_DIAGNOSIS_TITLE = 'Diagnóstico fictício E2E modal — não é dado clínico real';

  test.beforeAll(() => {
    const staff = seedStaffInGroup({ uid: SEM_CLINICA_UID, email: SEM_CLINICA_EMAIL, groupName: `E2E CID Modal Sem Clínica ${RUN_ID_MODAL}`, country: 'AR' });
    groupId = staff.groupId;
    grantCell(groupId, 'vacancy', 'read');
    // `vacancy:update` é o gate DA ROTA (`CreateVacancyPage.tsx`: `if (vacancyWriteGate.denied)
    // return <Navigate .../>`, D269) — sem ela `/admin/vacancies/:id/edit` nem chega a montar
    // o form. `patient:read` é o gate da 2ª leitura (`GET /patients/:id`). Nenhuma das duas é
    // `patient_clinical:read` — deliberadamente ausente, é o ator deste teste.
    grantCell(groupId, 'vacancy', 'update');
    grantCell(groupId, 'patient', 'read');

    const task = `E2E-CIDMODAL-${RUN_ID_MODAL}`;
    psql(`INSERT INTO patients (clickup_task_id, first_name, last_name, status, diagnosis, dependency_level, country, created_at, updated_at)
          VALUES ('${task}', 'E2E', 'Modal ${RUN_ID_MODAL}', 'ACTIVE', 'TEA leve', 'SEVERE', 'AR', NOW(), NOW())`);
    patientId = scalar(`SELECT id FROM patients WHERE clickup_task_id = '${task}'`);
    if (!patientId) throw new Error('paciente (modal) não foi inserido');

    psql(`INSERT INTO patient_addresses (patient_id, address_formatted, address_raw, lat, lng, display_order, source, created_at, updated_at)
          VALUES ('${patientId}', 'Av. Callao 1500, CABA, AR', 'Av. Callao 1500, CABA', -34.5951, -58.3927, 1, 'manual', NOW(), NOW())`);
    addressId = scalar(`SELECT id FROM patient_addresses WHERE patient_id = '${patientId}' LIMIT 1`);
    if (!addressId) throw new Error('endereço (modal) não foi inserido');

    psql(`INSERT INTO job_postings (
            vacancy_number, case_number, title, description,
            patient_id, patient_address_id,
            required_professions, required_sex, providers_needed,
            status, is_draft, country, created_at, updated_at
          ) VALUES (
            nextval('job_postings_vacancy_number_seq'), 910013, 'CASO E2E CID modal', '',
            '${patientId}', '${addressId}',
            ARRAY['AT']::varchar[], NULL, 1,
            'SEARCHING', false, 'AR', NOW(), NOW()
          )`);
    vacancyId = scalar(`SELECT id FROM job_postings WHERE patient_id = '${patientId}' ORDER BY created_at DESC LIMIT 1`);
    if (!vacancyId) throw new Error('vaga (modal) não foi inserida');

    const diagId = scalar(`INSERT INTO patient_diagnoses (
            patient_id, terminology_system, concept_uri, concept_code, concept_title,
            concept_language, concept_group, catalog_release, source, is_primary, active,
            created_by, updated_by
          ) VALUES (
            '${patientId}', 'ICD-11', 'http://id.who.int/icd/release/11/e2e-fake-uri-modal', '9A02',
            '${MODAL_DIAGNOSIS_TITLE}', 'es', '06', '2026-01', 'PANEL', true, true,
            '${SEM_CLINICA_UID}', '${SEM_CLINICA_UID}'
          ) RETURNING id`);
    if (!diagId) throw new Error('diagnóstico e2e (modal) não foi inserido');
  });

  test.afterAll(() => {
    safeSql(`DELETE FROM patient_diagnoses WHERE patient_id = '${patientId}'`);
    safeSql(`DELETE FROM job_postings WHERE id = '${vacancyId}'`);
    safeSql(`DELETE FROM patient_addresses WHERE patient_id = '${patientId}'`);
    safeSql(`DELETE FROM patients WHERE id = '${patientId}'`);
    cleanupStaffAndGroup(SEM_CLINICA_UID, groupId);
  });

  test('SEM PERMISSÃO — ator SEM patient_clinical:read não pode ver a patología no modal de editar (protege o paciente)', async ({ page }) => {
    // xfail DELIBERADO (achado do gate revisao-pr, FORA do escopo nomeado da Tarefa 2 —
    // só `DraftVacancyPage.tsx` foi autorizado): `VacancyFormSection.tsx:353` faz
    // `diagnoses={patientDetail?.diagnoses ?? []}` — o MESMO colapso de `null` (sem
    // `patient_clinical:read`) em `[]` que `DraftVacancyPage.tsx` tinha antes do conserto
    // desta rodada. Confirmado com `GET /api/admin/patients/:id` real (curl, ator só com
    // `patient:read`): a API devolve `diagnoses: null` — é a TELA que mostra "—" em vez do
    // aviso. Ver relatório (LISTA) para o Gabriel decidir; este teste fica RED de propósito
    // (não silenciado, não commitado como "passou") até a decisão.
    await loginAs(page, SEM_CLINICA);

    const isVacancyGet = new RegExp(`/api/admin/vacancies/${vacancyId}(\\?|$)`);
    const isPatientGet = new RegExp(`/api/admin/patients/${patientId}(\\?|$)`);
    const vacancyRes = page
      .waitForResponse((r) => r.request().method() === 'GET' && isVacancyGet.test(r.url()), { timeout: 20_000 })
      .catch(() => null);
    const patientRes = page
      .waitForResponse((r) => r.request().method() === 'GET' && isPatientGet.test(r.url()), { timeout: 20_000 })
      .catch(() => null);
    await page.goto(`/admin/vacancies/${vacancyId}/edit`);
    const [vRes, pRes] = await Promise.all([vacancyRes, patientRes]);
    expect(vRes, `GET /api/admin/vacancies/${vacancyId} não observado`).not.toBeNull();
    expect(pRes, `GET /api/admin/patients/${patientId} não observado`).not.toBeNull();

    const noPermission = page.getByTestId('vacancy-form-patologia-no-permission');
    await expect(noPermission).toBeVisible({ timeout: 15_000 });
    await expect(noPermission).toContainText('No tenés permiso');

    await expect(page.getByTestId('vacancy-form-patologia-empty')).toHaveCount(0);
    await expect(page.getByTestId('vacancy-form-patologias')).toHaveCount(0);

    const html = await page.content();
    expect(html).not.toContain('id.who.int');
    expect(html).not.toContain(MODAL_DIAGNOSIS_TITLE);
  });
});
