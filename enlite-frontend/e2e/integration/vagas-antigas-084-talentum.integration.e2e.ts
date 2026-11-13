/**
 * vagas-antigas-084-talentum.integration.e2e.ts @integration — spec 084 F4/R13: a lista "pausar à mão no Talentum" na TELA — o filtro
 * "Pausar a mano en Talentum" e os selos. Stack real (Vite + API docker + Postgres), SEM `page.route`; estados semeados por SQL (é o
 * que o Talentum recusando deixa no banco — a prova de que a API grava esse estado está em `tests/e2e/084-talentum-403.e2e.test.ts`).
 * Régua HUMANA: click + keyboard.type + texto lido da tela. Nenhum canal externo.
 *
 *  feliz  — ligar o filtro com o clique no rótulo: só as vagas da lista manual (a baixada com MANUAL_PAUSE entra, mesmo DE_BAJA), com o
 *           selo "Pausar a mano en Talentum"; a vaga sem estado some.
 *  alt 1  — filtro desligado: a vaga viva com MANUAL_RESUME mostra "Retomar a mano en Talentum" e a ficha repete o texto de RETOMAR
 *           (não o de pausar); a vaga sem estado não tem selo.
 *  alt 2  — PENDING_PAUSE (baixa gravada, Talentum ainda não respondeu) aparece na lista com o selo de pendente — nunca invisível.
 */
import { test, expect, type Page } from '@playwright/test';
import { insertTestPatient, cleanupTestPatient } from '../helpers/db-test-helper';
import { seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, safeSql, scalar, type MockUser } from '../helpers/patient-conversation-helper';

const RUN = Date.now();
const CASE = 947100 + (RUN % 500);
const UID = `e2e-v084t-${RUN}`;
const USER: MockUser = { uid: UID, email: `${UID}@e2e.test`, role: 'recruiter', country: 'AR' };
const CELLS: Array<[string, string]> = [
  ['vacancy', 'read'], ['vacancy', 'update'], ['funnel', 'read'], ['funnel', 'update'], ['match', 'read'], ['patient', 'read'], ['patient_identity', 'read'],
];

test.use({ viewport: { width: 1600, height: 1100 }, locale: 'es-AR' });

let patientId = '';
let groupId = '';
const v: Record<string, string> = {};

// is_test=false: a lista esconde is_test=true (23b32b9e2); semeada por SQL, sem evento de criação nem projeto Talentum; limpeza por patient_id.
function vaga(tag: string, o: { status: string; state: string | null }): string {
  const baixada = o.status === 'DE_BAJA';
  return scalar(`INSERT INTO job_postings (vacancy_number, case_number, title, description, patient_id, required_professions, status, is_draft, is_test, country,
      social_short_links, talentum_pause_state${baixada ? ', status_before_baja, baja_reason' : ''}, created_at, updated_at)
    VALUES (nextval('job_postings_vacancy_number_seq'), ${CASE}, '084T ${tag} ${RUN}', '', '${patientId}', ARRAY['AT']::varchar[], '${o.status}', false, false, 'AR',
      '{}'::jsonb, ${o.state ? `'${o.state}'` : 'NULL'}${baixada ? `, 'SEARCHING', 'MANUAL'` : ''}, NOW(), NOW()) RETURNING id`);
}

test.beforeAll(() => {
  ({ patientId } = insertTestPatient({ status: 'ACTIVE', firstName: 'Tal084', lastName: `E2E${RUN}`, withAddress: true }));
  safeSql(`UPDATE patients SET case_number = ${CASE} WHERE id = '${patientId}'`);
  ({ groupId } = seedStaffInGroup({ uid: UID, email: USER.email, groupName: `E2E Tal084 ${RUN}`, country: 'AR' }));
  for (const [resource, action] of CELLS) grantCell(groupId, resource, action);
  v.manualPause = vaga('manual-pause', { status: 'DE_BAJA', state: 'MANUAL_PAUSE' });
  v.manualResume = vaga('manual-resume', { status: 'SEARCHING', state: 'MANUAL_RESUME' });
  v.pending = vaga('pending', { status: 'DE_BAJA', state: 'PENDING_PAUSE' });
  v.limpa = vaga('limpa', { status: 'SEARCHING', state: null });
});

test.afterAll(() => {
  safeSql(`DELETE FROM job_postings WHERE patient_id = '${patientId}'`);
  cleanupStaffAndGroup(UID, groupId);
  cleanupTestPatient(patientId);
});

async function abrirLista(page: Page): Promise<void> {
  await loginAs(page, USER);
  await page.goto('/admin/vacancies');
  const busca = page.getByPlaceholder(/^Buscar por/);
  await expect(page.getByTestId('vacancies-col-case')).toBeVisible({ timeout: 20_000 });
  await busca.click();
  await expect(busca).toBeFocused();
  await page.keyboard.type(String(RUN));
}

test.describe.configure({ mode: 'serial' });
test.describe('Spec 084 F4 — lista manual do Talentum na tela @integration', () => {
  test.setTimeout(120_000);

  test('feliz — filtro "Pausar a mano en Talentum": entra a baixada com MANUAL_PAUSE (selo), sai a vaga sem estado', async ({ page }) => {
    await abrirLista(page);
    await expect(page.getByTestId(`vacancy-row-${v.limpa}`)).toBeVisible({ timeout: 15_000 });

    await page.getByText('Pausar a mano en Talentum', { exact: true }).click(); // o rótulo do filtro (clique humano)

    const fila = page.getByTestId(`vacancy-row-${v.manualPause}`);
    await expect(fila).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`vacancy-talentum-manual-badge-${v.manualPause}`)).toHaveText('Pausar a mano en Talentum');
    await expect(page.getByTestId(`vacancy-baja-badge-${v.manualPause}`)).toBeVisible(); // continua baixada: só consulta
    await expect(page.getByTestId(`vacancy-row-${v.limpa}`)).toHaveCount(0);
  });

  test('alt 1 — MANUAL_RESUME: selo e ficha dizem RETOMAR (não pausar); a vaga sem estado não tem selo', async ({ page }) => {
    await abrirLista(page);
    await expect(page.getByTestId(`vacancy-row-${v.manualResume}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`vacancy-talentum-manual-badge-${v.manualResume}`)).toHaveText('Retomar a mano en Talentum');
    await expect(page.getByTestId(`vacancy-talentum-manual-badge-${v.limpa}`)).toHaveCount(0);

    await page.getByTestId(`vacancy-row-${v.manualResume}`).click();
    await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${v.manualResume}`), { timeout: 15_000 });
    const nota = page.getByTestId('vacancy-talentum-manual-note');
    await expect(nota).toBeVisible({ timeout: 15_000 });
    await expect(nota).toContainText('Retomar a mano en Talentum');
    await expect(nota).not.toContainText('Pausar a mano');
  });

  test('alt 2 — PENDING_PAUSE: a baixa gravada que o Talentum ainda não confirmou aparece com o selo de pendente (nunca invisível)', async ({ page }) => {
    await abrirLista(page);
    await page.getByText('Pausar a mano en Talentum', { exact: true }).click();
    const fila = page.getByTestId(`vacancy-row-${v.pending}`);
    await expect(fila).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`vacancy-talentum-manual-badge-${v.pending}`)).toContainText('pendiente');
  });
});
