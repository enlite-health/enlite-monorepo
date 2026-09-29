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
