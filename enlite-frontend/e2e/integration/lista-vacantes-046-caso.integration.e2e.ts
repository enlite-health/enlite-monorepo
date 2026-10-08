/**
 * lista-vacantes-046-caso.integration.e2e.ts @integration
 *
 * Spec 046 F2 — coluna "Caso" da lista de vacantes, formato `EN1234#01`, número lido do PACIENTE.
 * Stack real (Vite + API do docker com USE_MOCK_AUTH + Postgres); sem `page.route` e sem nada de
 * WhatsApp/Google/Ana Care — a identidade entra por `loginAs` (mock token), como os irmãos.
 *
 *   feliz — A5: paciente case_number=946001, posição 2 -> a célula mostra EXATAMENTE `EN946001#02`.
 *   alt 1 — A7: vaga SEM paciente -> "—".
 *   alt 2 — A6: `jp.case_number` (cópia) diferente do `patients.case_number` -> mostra o do paciente.
 * (A8, legado < 1000 sem `EN`, é do unit `caseNumberFormat.test.ts` + `VacanciesTable.test.tsx`: um
 * número < 1000 num Postgres compartilhado colidiria com dado real no UNIQUE de `patients`.)
 */
import { test, expect } from '@playwright/test';
import { insertTestPatient, insertBaseVacancy, cleanupTestPatient } from '../helpers/db-test-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { loginAs, type MockUser } from '../helpers/abac-stack-helper';
import { seedMockStaff, cleanupMockStaff } from '../helpers/vacancy-notes-e2e-helper';

const MOCK_STAFF: MockUser = {
  uid: 'e2e-int-staff-046-f2-caso',
  email: 'staff.046.f2.caso@e2e.test',
  role: 'admin',
  country: 'AR',
};

const PATIENT_CASE = 946001;
const PATIENT_CASE_DIVERGENTE = 946002;
const COPIA_DIVERGENTE = 946999;
const SEM_PACIENTE_CASE = 946003;

test.describe('046 F2 — coluna Caso @integration', () => {
  test.use({ viewport: { width: 1366, height: 768 }, locale: 'es-AR' });
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(90_000);

  const patients: string[] = [];
  let vacFeliz = '';
  let vacSemPaciente = '';
  let vacDivergente = '';

  function seed(label: string, patientCase: number, copyCase: number, ordinal: number): { patientId: string; vacancyId: string } {
    const { patientId, addressId } = insertTestPatient({ withAddress: true, firstName: 'Caso046', lastName: `${label}-${Date.now()}` });
    patients.push(patientId);
    runSQL(`UPDATE patients SET case_number = ${patientCase} WHERE id = '${patientId}'`);
    const vacancyId = insertBaseVacancy({ patientId, patientAddressId: addressId!, caseNumber: copyCase, status: 'SEARCHING', isDraft: false });
    runSQL(`UPDATE job_postings SET case_ordinal = ${ordinal} WHERE id = '${vacancyId}'`);
    return { patientId, vacancyId };
  }

  test.beforeAll(() => {
    try {
      runSQL(`DELETE FROM job_postings WHERE case_number IN (${PATIENT_CASE}, ${PATIENT_CASE_DIVERGENTE}, ${COPIA_DIVERGENTE}, ${SEM_PACIENTE_CASE})`);
    } catch (e) { console.error('[setup] limpeza de vagas de runs anteriores falhou (seguindo)', e); }
    seedMockStaff(MOCK_STAFF, 'E2E Staff 046 F2');

    vacFeliz = seed('feliz', PATIENT_CASE, PATIENT_CASE, 2).vacancyId;
    vacDivergente = seed('divergente', PATIENT_CASE_DIVERGENTE, COPIA_DIVERGENTE, 1).vacancyId;

    const orfao = seed('sem-paciente', 946500, SEM_PACIENTE_CASE, 1);
    vacSemPaciente = orfao.vacancyId;
    runSQL(`UPDATE job_postings SET patient_id = NULL, patient_address_id = NULL, case_ordinal = NULL WHERE id = '${vacSemPaciente}'`);
  });

  test.afterAll(() => {
    for (const id of [vacFeliz, vacDivergente, vacSemPaciente]) {
      try { if (id) runSQL(`DELETE FROM job_postings WHERE id = '${id}'`); } catch (e) { console.error('[cleanup] vaga', e); }
    }
    for (const p of patients) {
      try { cleanupTestPatient(p); } catch (e) { console.error('[cleanup] paciente', e); }
    }
    try { cleanupMockStaff(MOCK_STAFF); } catch (e) { console.error('[cleanup] staff', e); }
  });

  async function abreALista(page: import('@playwright/test').Page, vacancyId: string) {
    await loginAs(page, MOCK_STAFF);
    await page.goto('/admin/vacancies');
    await expect(page.getByTestId(`vacancy-row-${vacancyId}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('vacancies-col-case')).toHaveText('Caso');
    return page.getByTestId(`vacancy-row-${vacancyId}`).locator('td').nth(1);
  }

  test('feliz (A5): caso do paciente 946001, posição 2 -> EN946001#02', async ({ page }) => {
    const celula = await abreALista(page, vacFeliz);
    await expect(celula).toHaveText('EN946001#02');
  });

  test('alt 1 (A7): vaga sem paciente -> "—"', async ({ page }) => {
    const celula = await abreALista(page, vacSemPaciente);
    await expect(celula).toHaveText('—');
  });

  test('alt 2 (A6): cópia jp.case_number diverge do paciente -> mostra o do paciente', async ({ page }) => {
    const celula = await abreALista(page, vacDivergente);
    await expect(celula).toHaveText('EN946002#01');
    await expect(celula).not.toContainText(String(COPIA_DIVERGENTE));
  });

  test('o clique na linha continua abrindo a vaga', async ({ page }) => {
    await abreALista(page, vacFeliz);
    await page.getByTestId(`vacancy-row-${vacFeliz}`).click();
    await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${vacFeliz}`), { timeout: 15_000 });
  });
});
