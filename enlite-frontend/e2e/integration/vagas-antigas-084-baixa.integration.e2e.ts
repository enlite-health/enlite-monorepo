/**
 * vagas-antigas-084-baixa.integration.e2e.ts @integration — spec 084: dar baixa em vaga antiga (uma e em lote), "mostrar baixadas",
 * "En espera" no seletor e o #NN. Stack real (Vite + API docker + Postgres), SEM `page.route`; identidade por `loginAs`
 * (mock token) com as células que a tela exige (ABAC). Régua HUMANA: click + keyboard.type + texto lido da tela; nada de
 * `fill()`/`evaluate`. Nenhum canal externo: as vagas NÃO têm projeto no Talentum (o pause pós-baixa não tem o que chamar).
 *
 *  F1  feliz  — baixar uma vaga sem serviço pela ficha → banner "só consulta", sem seletor, sem botão de reativar.
 *      alt 1  — lote: marcar 2 vagas, confirmar mostrando a contagem e os casos → somem da lista.
 *      alt 2  — vaga de serviço ativo: sem checkbox na lista e sem "Dar de baja" na ficha.
 *      alt 3  — vaga baixada: nenhum botão de reativar.
 *  F2  feliz  — ligar "Mostrar dadas de baja", ver o selo e abrir a vaga em leitura (sem Match, sem arrasto).
 *      alt 1  — com o filtro desligado a baixada não aparece.   alt 2 — filtro de status "Dada de baja".
 *  F5  feliz  — "En espera" pelo seletor e "Reanudar".  alt 1 — vaga de serviço ativo sem "Cerrado".  alt 2 — vaga sem serviço encerra.
 *  F6  feliz  — paciente com 3 serviços mostra #01, #02, #03.  alt 1 — a vaga antiga baixada fica SEM número.  alt 2 — serviço novo, #04.
 */
import { test, expect, type Page } from '@playwright/test';
import { insertTestPatient, cleanupTestPatient } from '../helpers/db-test-helper';
import {
  seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, safeSql, scalar, type MockUser,
} from '../helpers/patient-conversation-helper';
import { escolherNoCombo } from '../helpers/combobox';

const RUN = Date.now();
const CASE = 946100 + (RUN % 500);
const UID = `e2e-v084-${RUN}`;
const USER: MockUser = { uid: UID, email: `${UID}@e2e.test`, role: 'recruiter', country: 'AR' };
const CELLS: Array<[string, string]> = [
  ['vacancy', 'read'], ['vacancy', 'update'], ['funnel', 'read'], ['funnel', 'update'], ['match', 'read'], ['match', 'execute'],
  ['patient', 'read'], ['patient_identity', 'read'], ['patient_services', 'read'], ['messaging', 'read'], ['messaging', 'send'],
];

test.use({ viewport: { width: 1600, height: 1100 }, locale: 'es-AR' });

interface Seed {
  patientId: string;
  groupId: string;
  servico: string;
  vSem1: string;
  vSem2: string;
  vSem3: string;
  vServico: string;
  vBaixada: string;
  vHold: string;
}

let S: Seed;

// is_test=false: a lista de vagas esconde is_test=true (23b32b9e2). Sem canal externo mesmo assim: semeada por SQL (o auto-invite só dispara
// no evento de criação), sem projeto Talentum, e a limpeza é por patient_id.
function vaga(patientId: string, o: { title: string; status?: string; serviceId?: string; ordinal?: number | null; baixada?: boolean }): string {
  const extra = o.baixada ? `, status_before_baja, baja_reason` : '';
  const extraVals = o.baixada ? `, 'SEARCHING', 'MANUAL'` : '';
  return scalar(`INSERT INTO job_postings (vacancy_number, case_number, title, description, patient_id, contracted_service_id, case_ordinal,
      required_professions, status, is_draft, is_test, country, social_short_links, created_at, updated_at${extra})
    VALUES (nextval('job_postings_vacancy_number_seq'), ${CASE}, '${o.title}', '', '${patientId}', ${o.serviceId ? `'${o.serviceId}'` : 'NULL'},
      ${o.ordinal ?? 'NULL'}, ${o.serviceId ? `'{}'::text[]` : `ARRAY['AT']::varchar[]`}, '${o.status ?? 'SEARCHING'}', false, false, 'AR',
      '{}'::jsonb, NOW(), NOW()${extraVals}) RETURNING id`);
}

function servico(patientId: string): string {
  return scalar(`INSERT INTO patient_contracted_services (patient_id, service_code, active, country, created_by, updated_by)
    VALUES ('${patientId}', 'AT', true, 'AR', '${UID}', '${UID}') RETURNING id`);
}

const estado = (id: string): string => scalar(`SELECT status FROM job_postings WHERE id = '${id}'`);

test.beforeAll(() => {
  const { patientId } = insertTestPatient({ status: 'ACTIVE', firstName: 'Baja084', lastName: `E2E${RUN}`, withAddress: true });
  safeSql(`UPDATE patients SET case_number = ${CASE} WHERE id = '${patientId}'`);
  const { groupId } = seedStaffInGroup({ uid: UID, email: USER.email, groupName: `E2E Baja084 ${RUN}`, country: 'AR' });
  for (const [resource, action] of CELLS) grantCell(groupId, resource, action);
  const svc = servico(patientId);
  S = {
    patientId, groupId, servico: svc,
    vSem1: vaga(patientId, { title: `084E2E sem-um ${RUN}` }),
    vSem2: vaga(patientId, { title: `084E2E sem-dois ${RUN}` }),
    vSem3: vaga(patientId, { title: `084E2E sem-tres ${RUN}`, status: 'CLOSED' }),
    vServico: vaga(patientId, { title: `084E2E servico ${RUN}`, serviceId: svc, ordinal: 1 }),
    vBaixada: vaga(patientId, { title: `084E2E baixada ${RUN}`, status: 'DE_BAJA', baixada: true }),
    vHold: vaga(patientId, { title: `084E2E hold ${RUN}`, serviceId: servico(patientId), ordinal: 2 }),
  };
});

test.afterAll(() => {
  safeSql(`DELETE FROM job_posting_audit_log WHERE job_posting_id IN (SELECT id FROM job_postings WHERE patient_id = '${S.patientId}')`);
  safeSql(`DELETE FROM job_postings WHERE patient_id = '${S.patientId}'`);
  safeSql(`DELETE FROM patient_contracted_services WHERE patient_id = '${S.patientId}'`);
  cleanupStaffAndGroup(UID, S.groupId);
  cleanupTestPatient(S.patientId);
});

/** Abre a lista e estreita pelo título digitando na busca (gesto humano: clique + teclado). */
async function abrirLista(page: Page, termo = `${RUN}`): Promise<void> {
  await loginAs(page, USER);
  await page.goto('/admin/vacancies');
  const busca = page.getByPlaceholder(/^Buscar por/);
  await expect(page.getByTestId('vacancies-col-case')).toBeVisible({ timeout: 20_000 });
  await busca.click();
  await expect(busca).toBeFocused();
  await page.keyboard.type(termo);
}

async function abrirFicha(page: Page, id: string, login = true): Promise<void> {
  if (login) await loginAs(page, USER); // 2º login na mesma página/teste não acha o formulário (já está logado)
  await page.goto(`/admin/vacancies/${id}`);
  await expect(page.getByTestId('vacancy-case-card')).toBeVisible({ timeout: 20_000 });
}

test.describe.configure({ mode: 'serial' });
test.describe('Spec 084 — vagas antigas: baixa, só consulta, En espera e #NN @integration', () => {
  test.setTimeout(120_000);

  test('F1 feliz — baixar uma vaga SEM serviço pela ficha: banner "solo consulta", sem seletor e sem reativar', async ({ page }) => {
    await abrirFicha(page, S.vSem1);
    await expect(page.getByTestId('vacancy-baja-button')).toBeVisible();
    await page.getByTestId('vacancy-baja-button').click();
    await expect(page.getByTestId('vacancy-baja-confirm')).toBeVisible();
    await page.getByTestId('vacancy-baja-confirm-ok').click();

    await expect(page.getByTestId('vacancy-de-baja-banner')).toContainText('solo consulta', { timeout: 15_000 });
    expect(estado(S.vSem1)).toBe('DE_BAJA');
    await expect(page.getByTestId('vacancy-status-editor-trigger')).toHaveCount(0);
    await expect(page.getByTestId('vacancy-baja-button')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /reactiv|reativ/i })).toHaveCount(0);
  });

  test('F1 alt 1 — lote: marcar 2 vagas, a confirmação mostra a contagem e os casos, e elas somem da lista', async ({ page }) => {
    await abrirLista(page);
    const fila1 = page.getByTestId(`vacancy-row-${S.vSem2}`);
    const fila2 = page.getByTestId(`vacancy-row-${S.vSem3}`);
    await expect(fila1).toBeVisible({ timeout: 15_000 });
    await expect(fila2).toBeVisible();

    await page.getByTestId(`vacancy-select-${S.vSem2}`).click();
    await page.getByTestId(`vacancy-select-${S.vSem3}`).click();
    await expect(page.getByTestId('vacancy-baja-bulk-bar')).toContainText('2');
    await page.getByTestId('vacancy-baja-bulk-button').click();

    await expect(page.getByTestId('vacancy-baja-confirm-title')).toContainText('2');
    await expect(page.getByTestId('vacancy-baja-confirm-cases')).toContainText(String(CASE));
    await page.getByTestId('vacancy-baja-confirm-ok').click();

    await expect(page.getByTestId('vacancy-baja-done')).toBeVisible({ timeout: 15_000 });
    await expect(fila1).toHaveCount(0);
    await expect(fila2).toHaveCount(0);
    expect(estado(S.vSem2)).toBe('DE_BAJA');
    expect(estado(S.vSem3)).toBe('DE_BAJA');
  });

  test('F1 alt 2 — vaga de serviço ATIVO: sem checkbox na lista e sem "Dar de baja" na ficha', async ({ page }) => {
    await abrirLista(page, `servico ${RUN}`);
    await expect(page.getByTestId(`vacancy-row-${S.vServico}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`vacancy-select-${S.vServico}`)).toHaveCount(0);
    await abrirFicha(page, S.vServico, false);
    await expect(page.getByTestId('vacancy-baja-button')).toHaveCount(0);
  });

  test('F1 alt 3 / F2 feliz — vaga baixada: aparece só com "Mostrar dadas de baja", com selo, e abre SEM botão de reativar, sem Match', async ({ page }) => {
    await abrirLista(page, `baixada ${RUN}`);
    // filtro desligado (F2 alt 1): a baixada NÃO aparece
    await expect(page.getByTestId('vacancies-table-region')).toBeVisible();
    await expect(page.getByTestId(`vacancy-row-${S.vBaixada}`)).toHaveCount(0);

    // ligar o filtro com o clique humano no rótulo
    await page.getByText('Mostrar dadas de baja', { exact: true }).click();
    const fila = page.getByTestId(`vacancy-row-${S.vBaixada}`);
    await expect(fila).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`vacancy-baja-badge-${S.vBaixada}`)).toBeVisible();
    await expect(page.getByTestId(`vacancy-select-${S.vBaixada}`)).toHaveCount(0); // baixada não entra em lote

    await fila.click();
    await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${S.vBaixada}`), { timeout: 15_000 });
    await expect(page.getByTestId('vacancy-de-baja-banner')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /reactiv|reativ/i })).toHaveCount(0);
    await expect(page.getByTestId('vacancy-status-editor-trigger')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Invitar prestadores/ })).toHaveCount(0);
    expect(estado(S.vBaixada)).toBe('DE_BAJA'); // abrir não mexe em nada
  });

  test('F2 alt 2 — filtro de status "Dada de baja" mostra as baixadas', async ({ page }) => {
    await abrirLista(page, `baixada ${RUN}`);
    // o Combobox de status é o 1º botão `aria-haspopup=listbox` da página (o de itens por página vem depois)
    await escolherNoCombo(page, page.locator('button[aria-haspopup="listbox"]').first(), 'Dada de baja');
    await expect(page.getByTestId(`vacancy-row-${S.vBaixada}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`vacancy-baja-badge-${S.vBaixada}`)).toBeVisible();
  });

  test('F5 feliz — pausar com "En espera" pelo seletor e reanudar', async ({ page }) => {
    await abrirFicha(page, S.vHold);
    await page.getByTestId('vacancy-status-editor-trigger').click();
    await page.getByTestId('vacancy-status-option-ON_HOLD').click();
    await expect(page.getByTestId('vacancy-status-editor-trigger')).toContainText('En espera', { timeout: 15_000 });
    expect(estado(S.vHold)).toBe('ON_HOLD');

    await page.getByTestId('vacancy-status-editor-trigger').click();
    await page.getByTestId('vacancy-status-option-RESUME').click();
    await expect(page.getByTestId('vacancy-status-editor-trigger')).toContainText('En búsqueda', { timeout: 15_000 });
    expect(estado(S.vHold)).toBe('SEARCHING');
  });

  test('F5 alt 1 — vaga de serviço ATIVO não oferece "Cerrado" (só pausar)', async ({ page }) => {
    await abrirFicha(page, S.vServico);
    await page.getByTestId('vacancy-status-editor-trigger').click();
    await expect(page.getByTestId('vacancy-status-option-ON_HOLD')).toBeVisible();
    await expect(page.getByTestId('vacancy-status-option-CLOSED')).toHaveCount(0);
  });

  test('F5 alt 2 — a ficha de uma vaga SEM serviço ainda oferece e aplica "Cerrado"', async ({ page }) => {
    const livre = vaga(S.patientId, { title: `084E2E livre ${RUN}` });
    await abrirFicha(page, livre);
    await page.getByTestId('vacancy-status-editor-trigger').click();
    await page.getByTestId('vacancy-status-option-CLOSED').click();
    await expect(page.getByTestId('vacancy-status-editor-trigger')).toContainText('Cerrado', { timeout: 15_000 });
    expect(estado(livre)).toBe('CLOSED');
  });

  test('F6 feliz / alt 1 / alt 2 — #01..#04 seguem os serviços; a vaga antiga baixada fica sem número', async ({ page }) => {
    // o paciente já tem os serviços 1 e 2 (vServico, vHold); ganha o 3º e o 4º ("serviço novo ganha o próximo número")
    const s3 = servico(S.patientId);
    const s4 = servico(S.patientId);
    const v3 = vaga(S.patientId, { title: `084E2E ord3 ${RUN}`, serviceId: s3, ordinal: 3 });
    const v4 = vaga(S.patientId, { title: `084E2E ord4 ${RUN}`, serviceId: s4, ordinal: 4 });

    await abrirLista(page);
    await page.getByText('Mostrar dadas de baja', { exact: true }).click();
    const celula = (id: string) => page.getByTestId(`vacancy-row-${id}`).locator('td').nth(1);
    await expect(celula(S.vServico)).toHaveText(new RegExp(`${CASE}#01$`), { timeout: 15_000 });
    await expect(celula(S.vHold)).toHaveText(new RegExp(`${CASE}#02$`));
    await expect(celula(v3)).toHaveText(new RegExp(`${CASE}#03$`));
    await expect(celula(v4)).toHaveText(new RegExp(`${CASE}#04$`)); // alt 2: serviço novo, próximo número
    await expect(celula(S.vBaixada)).toHaveText(new RegExp(`^[A-Z]*${CASE}$`)); // alt 1: antiga baixada, SEM #NN
  });
});
