/**
 * vaga-estado-do-paciente-humano.integration.e2e.ts @integration — estado-automatico-do-paciente, F2 (D3), reescrito na F4 do
 * semaforo-da-vaga: a vaga mostra o estado do PACIENTE (lido na hora, por join) e só o selo "Borrador" quando é rascunho. Não existe
 * mais ciclo "Abierta/En espera", filtro de ciclo de vida nem editor de estado da vaga.
 *
 * Stack real (Vite + API docker com o engine ABAC LIGADO + Postgres), SEM `page.route` de dado (o login só intercepta o Identity Toolkit, como
 * `loginAs`); identidade por `loginAs` (token mock) com as células que cada cenário exige. Régua HUMANA: click + keyboard.type + texto lido da
 * tela; nada de `fill()`/`evaluate`. `toHaveScreenshot` + vídeo (`test.use({ video: 'on' })`). Nenhum canal externo: as vagas são semeadas por SQL,
 * sem projeto Talentum, sem short link, sem WhatsApp.
 *
 * O estado "depois do foguete" (paciente em Búsqueda + vaga em rascunho com status de sistema) é semeado por SQL como o foguete o deixa; o
 * foguete de verdade, pela borda, é provado em `worker-functions/tests/e2e/vaga-mostra-estado-do-paciente.e2e.test.ts` (caso i).
 *
 *  feliz  — a lista e a ficha mostram "Búsqueda" (estado do paciente) + "Borrador" só no rascunho (a vaga publicada não tem selo); o estado muda
 *           no paciente e a vaga acompanha ao recarregar, sem escrita nela.
 *  alt 1  — operador SEM `patient:read`: a lista e a ficha mostram "—" no estado do paciente, e o filtro "Estado del paciente" não existe
 *           (nem o de ciclo de vida, que saiu).
 *  alt 2  — vaga legada em pausa (`ON_HOLD`): a ficha não tem seletor de estado nem "Reanudar", não mostra "En espera" como selo e abrir não grava nada.
 */
import { test, expect, type Page } from '@playwright/test';
import { insertTestPatient, cleanupTestPatient } from '../helpers/db-test-helper';
import {
  seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, safeSql, scalar, type MockUser,
} from '../helpers/patient-conversation-helper';

const RUN = Date.now();
const CASE = 947100 + (RUN % 500);
const UID_COM = `e2e-vaga-estado-com-${RUN}`;
const UID_SEM = `e2e-vaga-estado-sem-${RUN}`;
const USER_COM: MockUser = { uid: UID_COM, email: `${UID_COM}@e2e.test`, role: 'recruiter', country: 'AR' };
const USER_SEM: MockUser = { uid: UID_SEM, email: `${UID_SEM}@e2e.test`, role: 'recruiter', country: 'AR' };
const CELLS_COM: Array<[string, string]> = [
  ['vacancy', 'read'], ['vacancy', 'update'], ['funnel', 'read'], ['patient', 'read'], ['patient_identity', 'read'], ['patient_services', 'read'],
];
const CELLS_SEM: Array<[string, string]> = [['vacancy', 'read'], ['vacancy', 'update'], ['funnel', 'read']];

test.use({ viewport: { width: 1600, height: 1100 }, locale: 'es-AR', video: 'on' });

interface Seed {
  patientId: string;
  groupCom: string;
  groupSem: string;
  vRascunho: string;
  vLegada: string;
  vPausada: string;
}
let S: Seed;

/** Vaga por SQL (as linhas de hoje). `is_test=false`: a lista esconde vaga de teste. Sem projeto Talentum nem short link. */
function vaga(patientId: string, o: { title: string; status: string; isDraft: boolean; ordinal: number; beforeHold?: string }): string {
  return scalar(`INSERT INTO job_postings (vacancy_number, case_number, title, description, patient_id, case_ordinal, required_professions, status,
      is_draft, is_test, country, social_short_links, created_at, updated_at${o.beforeHold ? ', status_before_hold' : ''})
    VALUES (nextval('job_postings_vacancy_number_seq'), ${CASE}, '${o.title}', '', '${patientId}', ${o.ordinal}, ARRAY['AT']::varchar[], '${o.status}',
      ${o.isDraft}, false, 'AR', '{}'::jsonb, NOW(), NOW()${o.beforeHold ? `, '${o.beforeHold}'` : ''}) RETURNING id`);
}

test.beforeAll(() => {
  const { patientId } = insertTestPatient({
    status: 'SEARCHING', firstName: 'VagaEstado', lastName: `E2E${RUN} QA`, diagnosis: 'sin dato QA', withAddress: true,
  });
  safeSql(`UPDATE patients SET case_number = ${CASE} WHERE id = '${patientId}'`);
  const com = seedStaffInGroup({ uid: UID_COM, email: USER_COM.email, groupName: `E2E VagaEstado com ${RUN}`, country: 'AR' });
  for (const [resource, action] of CELLS_COM) grantCell(com.groupId, resource, action);
  const sem = seedStaffInGroup({ uid: UID_SEM, email: USER_SEM.email, groupName: `E2E VagaEstado sem ${RUN}`, country: 'AR' });
  for (const [resource, action] of CELLS_SEM) grantCell(sem.groupId, resource, action);
  S = {
    patientId, groupCom: com.groupId, groupSem: sem.groupId,
    // como o foguete a deixa: status de sistema + rascunho
    vRascunho: vaga(patientId, { title: `VE rascunho ${RUN}`, status: 'PENDING_ACTIVATION', isDraft: true, ordinal: 1 }),
    // linha antiga com valor legado, publicada
    vLegada: vaga(patientId, { title: `VE legada ${RUN}`, status: 'SEARCHING_REPLACEMENT', isDraft: false, ordinal: 2 }),
    // legada em pausa: a retomada tem de gravar o valor do ciclo de vida
    vPausada: vaga(patientId, { title: `VE pausada ${RUN}`, status: 'ON_HOLD', isDraft: false, ordinal: 3, beforeHold: 'SEARCHING_REPLACEMENT' }),
  };
});

test.afterAll(() => {
  safeSql(`DELETE FROM job_posting_audit_log WHERE job_posting_id IN (SELECT id FROM job_postings WHERE patient_id = '${S.patientId}')`);
  safeSql(`DELETE FROM job_postings WHERE patient_id = '${S.patientId}'`);
  cleanupStaffAndGroup(UID_COM, S.groupCom);
  cleanupStaffAndGroup(UID_SEM, S.groupSem);
  cleanupTestPatient(S.patientId);
});

/** Abre a lista e estreita pelo número do caso digitando na busca (gesto humano: clique + teclado). */
async function abrirLista(page: Page, user: MockUser): Promise<void> {
  await loginAs(page, user);
  await page.goto('/admin/vacancies');
  await expect(page.getByTestId('vacancies-col-case')).toBeVisible({ timeout: 20_000 });
  const busca = page.getByPlaceholder(/^Buscar por/);
  await busca.click();
  await expect(busca).toBeFocused();
  await page.keyboard.type(String(CASE));
}

async function abrirFicha(page: Page, user: MockUser, id: string): Promise<void> {
  await loginAs(page, user);
  await page.goto(`/admin/vacancies/${id}`);
  await expect(page.getByTestId('vacancy-case-card')).toBeVisible({ timeout: 20_000 });
}

test.describe.configure({ mode: 'serial' });
test.describe('Vaga mostra o estado do paciente (D3) @integration', () => {
  test.setTimeout(120_000);

  test('feliz — a lista e a ficha mostram "Búsqueda" + o ciclo de vida; o estado muda no paciente e a vaga acompanha', async ({ page }) => {
    await abrirLista(page, USER_COM);
    const filaRascunho = page.getByTestId(`vacancy-row-${S.vRascunho}`);
    const filaLegada = page.getByTestId(`vacancy-row-${S.vLegada}`);
    await expect(filaRascunho).toBeVisible({ timeout: 15_000 });
    await expect(filaLegada).toBeVisible();

    // lido da TELA: o estado do paciente e o ciclo de vida, lado a lado
    await expect(filaRascunho.getByTestId('patient-status-pill')).toHaveText('Búsqueda');
    await expect(filaRascunho.getByTestId('vacancy-lifecycle-badge')).toHaveText('Borrador');
    await expect(filaLegada.getByTestId('patient-status-pill')).toHaveText('Búsqueda');
    await expect(filaLegada.getByTestId('vacancy-lifecycle-badge')).toHaveCount(0); // o legado SEARCHING_REPLACEMENT é vaga no ar: sem selo (F15)
    await expect(page.getByTestId('vacancies-table-region')).toHaveScreenshot('vaga-estado-lista.png', { maxDiffPixelRatio: 0.05 });

    // a ficha da vaga publicada
    await filaLegada.click();
    await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${S.vLegada}`), { timeout: 15_000 });
    const card = page.getByTestId('vacancy-case-card');
    await expect(card.getByTestId('patient-status-pill')).toHaveText('Búsqueda', { timeout: 15_000 });
    await expect(card.getByTestId('vacancy-status-editor-trigger')).toHaveCount(0);
    await expect(card.getByTestId('vacancy-lifecycle-badge')).toHaveCount(0);
    await expect(card).toHaveScreenshot('vaga-estado-ficha.png', { maxDiffPixelRatio: 0.05 });

    // o paciente muda (a derivação/o foguete são do paciente): a vaga acompanha SEM escrita nela
    const antes = scalar(`SELECT updated_at FROM job_postings WHERE id = '${S.vLegada}'`);
    safeSql(`UPDATE patients SET status = 'REPLACEMENT' WHERE id = '${S.patientId}'`);
    await page.reload();
    await expect(page.getByTestId('vacancy-case-card').getByTestId('patient-status-pill')).toHaveText('Reemplazos', { timeout: 15_000 });
    expect(scalar(`SELECT updated_at FROM job_postings WHERE id = '${S.vLegada}'`)).toBe(antes);
    safeSql(`UPDATE patients SET status = 'SEARCHING' WHERE id = '${S.patientId}'`);
  });

  test('alt 1 — operador SEM patient:read vê "—" no estado do paciente (lista e ficha) e não tem o filtro por estado', async ({ page }) => {
    await abrirLista(page, USER_SEM);
    const fila = page.getByTestId(`vacancy-row-${S.vLegada}`);
    await expect(fila).toBeVisible({ timeout: 15_000 });
    await expect(fila.getByTestId('patient-status-pill')).toHaveText('—');
    await expect(fila.getByTestId('vacancy-lifecycle-badge')).toHaveCount(0); // vaga no ar não tem selo, com ou sem célula
    await expect(page.getByTestId('vacancy-filter-lifecycle')).toHaveCount(0);
    await expect(page.getByTestId('vacancy-filter-patient-status')).toHaveCount(0);
    await expect(page.getByTestId('vacancies-table-region')).toHaveScreenshot('vaga-estado-lista-sem-celula.png', { maxDiffPixelRatio: 0.05 });

    await fila.click();
    await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${S.vLegada}`), { timeout: 15_000 });
    const card = page.getByTestId('vacancy-case-card');
    await expect(card.getByTestId('patient-status-pill')).toHaveText('—', { timeout: 15_000 });
    await expect(card.getByTestId('patient-status-pill')).not.toContainText('Búsqueda');
  });

  test('alt 2 — vaga legada em pausa: a ficha não tem seletor de estado nem "Reanudar", e abrir não grava nada', async ({ page }) => {
    const antes = scalar(`SELECT updated_at FROM job_postings WHERE id = '${S.vPausada}'`);
    await abrirFicha(page, USER_COM, S.vPausada);
    const card = page.getByTestId('vacancy-case-card');
    await expect(card.getByTestId('patient-status-pill')).toHaveText('Búsqueda', { timeout: 15_000 });
    await expect(page.getByTestId('vacancy-status-editor-trigger')).toHaveCount(0);
    await expect(page.getByTestId('vacancy-status-editor-dropdown')).toHaveCount(0);
    await expect(page.locator('[data-testid^="vacancy-status-option-"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Reanudar/ })).toHaveCount(0);
    await expect(card.getByTestId('vacancy-lifecycle-badge')).toHaveCount(0); // o legado ON_HOLD nunca vira selo "En espera"
    await expect(card.getByText('En espera', { exact: true })).toHaveCount(0);
    await expect(card).toHaveScreenshot('vaga-estado-ficha-legada-sem-editor.png', { maxDiffPixelRatio: 0.05 });
    expect(scalar(`SELECT status FROM job_postings WHERE id = '${S.vPausada}'`)).toBe('ON_HOLD'); // nada foi gravado
    expect(scalar(`SELECT updated_at FROM job_postings WHERE id = '${S.vPausada}'`)).toBe(antes);
    expect(scalar(`SELECT status FROM patients WHERE id = '${S.patientId}'`)).toBe('SEARCHING'); // o paciente nunca foi tocado
  });
});
