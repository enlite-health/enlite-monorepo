/**
 * Spec 060 — Projeto Terapêutico: o campo de ATIVIDADES sai em ordem alfabética e tem busca — stack REAL
 * (frontend + API + Postgres), zero mock. Régua humana (memória `e2e-humano-nao-e-fill`): click +
 * `page.keyboard.type`, valor lido da TELA, nunca `fill`.
 *
 * O que se prova (3 testes):
 *   1. a ordem das opções LIDA DA TELA é A–Z pelo Intl.Collator('es') calculado AQUI (independente do código
 *      de produção) e DIFERE da ordem do catálogo (`sort_order` do seed 415, que não é alfabética);
 *   2. digitar "kinesiologo" (sem acento) acha "…kinesiólogo/TO."; acrescentar "zzz" mostra "sem resultado";
 *   3. filtrar por "higiene", marcar a opção filtrada e fechar: o gatilho mostra o rótulo escolhido.
 *
 * FR-12: nada é gravado — o teste abre o "Nuevo", lê, digita e MARCA; nunca aciona o botão de salvar
 * (salvar um PT pode espelhar para o Ana Care). Auth/seed: molde de `projeto-terapeutico-humano`.
 */
import { test, expect, type Page } from '@playwright/test';
import { seedActivatablePatient, cleanupPatientDeep, runSQL } from '../helpers/patient-detail-c-helper';
import {
  seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, psql, safeSql, ABAC_TENANT, type MockUser,
} from '../helpers/abac-stack-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

const CELULAS: [string, string][] = [
  ['patient', 'read'], ['patient_therapeutic_project', 'read'], ['patient_therapeutic_project', 'write'], ['patient_therapeutic_project', 'create'],
  ['patient_clinical', 'read'], ['patient_clinical', 'write'], ['patient_family', 'read'], ['patient_family', 'write'],
  ['patient_care_team', 'read'], ['patient_services', 'read'], ['patient_coverage', 'read'], ['patient_address', 'read'], ['patient_identity', 'read'],
  ['catalog_therapeutic_objectives', 'read'], ['catalog_therapeutic_activities', 'read'], ['catalog_therapeutic_segments', 'read'],
];

/** Sem acento e sem caixa — o critério do teste, escrito aqui (não importa o `normalizeText` de produção). */
const plano = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

test.use({ viewport: { width: 1600, height: 1000 }, video: 'on' });

test.describe('spec 060 — atividades do PT: A–Z e busca @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  let seed: { patientId: string; addressId: string; stamp: string };
  let staff: { user: MockUser; groupId: string };

  test.beforeAll(() => {
    seed = seedActivatablePatient(756000); // faixa própria (as vizinhas: 755000 e 800000)
    runSQL(`INSERT INTO patient_contracted_services (patient_id, service_code, weekly_hours, address_id, created_by, updated_by) VALUES ('${seed.patientId}', 'CAREGIVER', 20, '${seed.addressId}', 'e2e-060', 'e2e-060') RETURNING id`);
    const uid = `e2e-pt060-${RUN_ID}`;
    const user: MockUser = { uid, email: `${uid}@e2e.test`, role: 'admin', country: 'AR' };
    const { groupId } = seedStaffInGroup({ uid, email: user.email, groupName: `PT060 ${RUN_ID}`, country: 'AR' });
    psql(`UPDATE users SET display_name = 'E2E PT060' WHERE firebase_uid = '${uid}'`);
    for (const [resource, action] of CELULAS) grantCell(groupId, resource, action);
    staff = { user, groupId };
  });

  test.afterAll(() => {
    runSQL(`DELETE FROM patients WHERE id = '${seed.patientId}'`);
    cleanupPatientDeep(seed.patientId);
    cleanupStaffAndGroup(staff.user.uid, staff.groupId);
    safeSql(`DELETE FROM iam.permission_groups WHERE tenant_id = '${ABAC_TENANT}' AND name LIKE 'PT060 ${RUN_ID}'`);
  });

  /** Abre o paciente → "Nuevo" e devolve o gatilho do campo de atividades (ainda fechado). */
  async function abrirNuevo(page: Page) {
    await loginAs(page, staff.user);
    await page.goto(`/admin/patients/${seed.patientId}`);
    await expect(page.getByTestId('projeto-terapeutico-card')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('tp-new-btn')).toBeEnabled();
    await page.getByTestId('tp-new-btn').click();
    await expect(page.getByTestId('therapeutic-project-form')).toBeVisible({ timeout: 15_000 });
    return page.locator('#tp-activities');
  }

  test('1. as opções saem em ordem A–Z (lidas da tela) e a ordem difere da do catálogo', async ({ page }) => {
    const gatilho = await abrirNuevo(page);
    await gatilho.click();
    const opcoes = page.locator('#tp-activities').locator('..').locator('[role="option"]');
    await expect(opcoes.first()).toBeVisible();

    const naTela = (await opcoes.allTextContents()).map((s) => s.trim());
    expect(naTela.length).toBeGreaterThanOrEqual(8); // controle de não-vacuidade

    const es = new Intl.Collator('es', { sensitivity: 'base', numeric: true });
    expect(naTela).toEqual([...naTela].sort((a, b) => es.compare(a, b)));

    const doCatalogo = runSQL(`SELECT label FROM therapeutic_activities WHERE active ORDER BY sort_order, lower(label)`)
      .split('\n').map((s) => s.trim()).filter(Boolean);
    expect(doCatalogo.length).toBeGreaterThanOrEqual(8);
    expect(naTela).not.toEqual(doCatalogo);
  });

  test('2. busca sem acento acha a atividade; texto sem correspondência mostra "sem resultado"', async ({ page }) => {
    const gatilho = await abrirNuevo(page);
    await gatilho.click();
    const busca = page.getByTestId('tp-activities-search');
    await busca.click();
    await expect(busca).toBeFocused();
    await page.keyboard.type('kinesiologo');

    const opcoes = page.locator('#tp-activities').locator('..').locator('[role="option"]');
    await expect(opcoes.first()).toBeVisible();
    const textos = (await opcoes.allTextContents()).map((s) => s.trim());
    expect(textos.length).toBeGreaterThanOrEqual(1);
    for (const t of textos) expect(plano(t)).toContain('kinesi');
    await expect(page.locator('#tp-activities').locator('..').getByText('kinesiólogo/TO.', { exact: false })).toBeVisible();

    await page.keyboard.type('zzz');
    await expect(page.getByTestId('tp-activities-no-results')).toBeVisible();
    await expect(opcoes).toHaveCount(0);
  });

  test('3. marcar a opção filtrada: o gatilho mostra o rótulo escolhido', async ({ page }) => {
    const gatilho = await abrirNuevo(page);
    await gatilho.click();
    const busca = page.getByTestId('tp-activities-search');
    await busca.click();
    await page.keyboard.type('higiene');

    const opcoes = page.locator('#tp-activities').locator('..').locator('[role="option"]');
    await expect(opcoes).toHaveCount(1);
    const rotulo = ((await opcoes.first().textContent()) ?? '').trim();
    expect(plano(rotulo)).toContain('higiene');
    await opcoes.first().locator('button').click();
    await expect(opcoes.first()).toHaveAttribute('aria-selected', 'true');

    await gatilho.click(); // fecha pelo gatilho (o Escape também chegaria ao drawer)
    await expect(gatilho).toHaveAttribute('aria-expanded', 'false');
    await expect(gatilho).toContainText(rotulo);
  });
});
