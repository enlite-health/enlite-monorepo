/**
 * Spec 030 (F4, T052) — o vínculo OPCIONAL de segmento no catálogo de objetivos, exercitado por um HUMANO
 * contra o stack REAL (frontend + API com o engine ABAC LIGADO + Postgres). Zero mock de dado: o único
 * `page.route` é o do `loginAs` (troca o Authorization por `mock_*`); a REQUEST segue para a API real.
 * Régua humana (memória `e2e-humano-nao-e-fill`): click + `toBeFocused` + `keyboard.type` + valor lido da TELA.
 *
 *   1. feliz: modal de um objetivo semeado → escolhe o segmento pelo teclado → salva → a coluna mostra o
 *      rótulo (lido da tela) → `segment_id` no banco → "Nuevo" do PTI com esse segmento mostra o objetivo PRIMEIRO;
 *   2. alt 1: segmento desativado depois → o modal mostra "<rótulo> (inactivo)"; limpar salva `segment_id` NULL;
 *   3. alt 2: conta sem `catalog_therapeutic_segments:read` → sem campo e sem coluna, e o resto salva
 *      (o vínculo que já existia no banco não é tocado).
 */
import { test, expect, type Page } from '@playwright/test';
import { seedActivatablePatient, cleanupPatientDeep, runSQL } from '../helpers/patient-detail-c-helper';
import {
  cleanupStaffAndGroup, grantCell, loginAs, psql, safeSql, scalar, seedStaffInGroup, ABAC_TENANT, type MockUser,
} from '../helpers/abac-stack-helper';
import { escolherSegmentoPeloTeclado, primeiroSegmento } from '../helpers/pti-segmento-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
/** Só letras: sequência longa de dígitos é lida como documento/telefone e recusada (guarda de PII do servidor). */
const LETRAS = () => Math.random().toString(36).replace(/[0-9.]/g, '').slice(0, 8);
const OBJ_FELIZ = `Objetivo vinculo ${LETRAS()}`;
const OBJ_INATIVO = `Objetivo inativo ${LETRAS()}`;
const OBJ_SEM_CELULA = `Objetivo sin celula ${LETRAS()}`;
const OBJ_RENOMEADO = `Objetivo renombrado ${LETRAS()}`;
const SEG_DESLIGADO = `Segmento apagado ${LETRAS()}`;
const ROTA = '/admin/catalogos/objetivos-especificos';

const COM_SEGMENTOS: [string, string][] = [
  ['catalog_therapeutic_objectives', 'read'], ['catalog_therapeutic_objectives', 'create'], ['catalog_therapeutic_objectives', 'update'],
  ['catalog_therapeutic_segments', 'read'],
];
/** O que o "Nuevo" do PTI precisa para abrir e listar objetivos por segmento (molde `projeto-terapeutico-humano`). */
const CELULAS_PTI: [string, string][] = [
  ['patient', 'read'], ['patient_therapeutic_project', 'read'], ['patient_therapeutic_project', 'create'], ['patient_clinical', 'read'], ['patient_services', 'read'],
  ['catalog_therapeutic_activities', 'read'],
];

type Staff = { user: MockUser; groupId: string };
function semearStaff(prefixo: string, celulas: [string, string][]): Staff {
  const uid = `e2e-${prefixo}-${RUN_ID}`;
  const user: MockUser = { uid, email: `${uid}@e2e.test`, role: 'admin', country: 'AR' };
  const { groupId } = seedStaffInGroup({ uid, email: user.email, groupName: `Vinculo ${prefixo} ${RUN_ID}`, country: 'AR' });
  for (const [resource, action] of celulas) grantCell(groupId, resource, action);
  return { user, groupId };
}
function limparStaff(s: Staff): void {
  cleanupStaffAndGroup(s.user.uid, s.groupId);
  safeSql(`DELETE FROM iam.permission_groups WHERE tenant_id = '${ABAC_TENANT}' AND name LIKE 'Vinculo % ${RUN_ID}'`);
}
function semearObjetivo(label: string, segmentId: string | null, sortOrder = 99999): string {
  return runSQL(`INSERT INTO therapeutic_specific_objectives (label, sort_order, segment_id, created_by, updated_by) VALUES ('${label}', ${sortOrder}, ${segmentId ? `'${segmentId}'` : 'NULL'}, 'e2e-030', 'e2e-030') RETURNING id`).split('\n')[0].trim();
}
const segmentoNoBanco = (id: string): string => scalar(`SELECT coalesce(segment_id::text, 'NULL') FROM therapeutic_specific_objectives WHERE id = '${id}'`);

async function abrirCatalogo(page: Page, user: MockUser): Promise<void> {
  await loginAs(page, user);
  await page.goto(ROTA);
  await expect(page.getByTestId('therapeutic-catalog-table')).toBeVisible({ timeout: 30_000 });
}

/** O select do modal como um humano: click, foco, TECLADO (type-ahead do select nativo), valor lido da tela. */
async function escolherNoModal(page: Page, rotulo: string): Promise<string> {
  const campo = page.getByTestId('therapeutic-catalog-segment-select');
  await campo.click();
  await expect(campo).toBeFocused();
  await page.keyboard.type(rotulo.slice(0, 4));
  return (await campo.locator('option:checked').innerText()).trim();
}

test.use({ viewport: { width: 1600, height: 1000 } });

test.describe('spec 030 — vínculo de segmento no catálogo de objetivos: um HUMANO liga, vê o segmento desativado e, sem a célula, nada aparece @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  let admin: Staff;
  let semCelula: Staff;
  let seed: { patientId: string; addressId: string; stamp: string };
  let objFeliz = '';
  let objInativo = '';
  let objSemCelula = '';
  let segDesligado = '';
  let outroSegmento = ''; // ≠ do que o feliz escolhe: senão o objetivo da alt 2 também subiria na lista do PTI
  const seg = primeiroSegmento;

  test.beforeAll(() => {
    admin = semearStaff('vinc-adm', [...COM_SEGMENTOS, ...CELULAS_PTI]);
    semCelula = semearStaff('vinc-sem', COM_SEGMENTOS.filter(([r]) => r !== 'catalog_therapeutic_segments'));
    seed = seedActivatablePatient(740000); // faixa própria
    runSQL(`INSERT INTO patient_contracted_services (patient_id, service_code, weekly_hours, address_id, created_by, updated_by) VALUES ('${seed.patientId}', 'CAREGIVER', 20, '${seed.addressId}', 'e2e-030', 'e2e-030')`);
    objFeliz = semearObjetivo(OBJ_FELIZ, null);
    segDesligado = runSQL(`INSERT INTO therapeutic_segments (label, sort_order, active, deactivated_at, created_by, updated_by) VALUES ('${SEG_DESLIGADO}', 90000, false, now(), 'e2e-030', 'e2e-030') RETURNING id`).split('\n')[0].trim();
    objInativo = semearObjetivo(OBJ_INATIVO, segDesligado, 99998);
    outroSegmento = scalar(`SELECT id FROM therapeutic_segments WHERE active AND id <> '${seg().id}' ORDER BY sort_order, lower(label) LIMIT 1`);
    expect(outroSegmento).toMatch(/^[0-9a-f-]{36}$/);
    objSemCelula = semearObjetivo(OBJ_SEM_CELULA, outroSegmento, 99997);
  });
  test.afterAll(() => {
    runSQL(`DELETE FROM therapeutic_specific_objectives WHERE created_by = 'e2e-030'`);
    runSQL(`DELETE FROM therapeutic_segments WHERE created_by = 'e2e-030'`);
    runSQL(`DELETE FROM patients WHERE id = '${seed.patientId}'`);
    cleanupPatientDeep(seed.patientId);
    limparStaff(admin);
    limparStaff(semCelula);
  });

  test('feliz: modal do objetivo → segmento pelo teclado → salva → a coluna mostra o rótulo → segment_id no banco → "Nuevo" do PTI com esse segmento lista o objetivo PRIMEIRO', async ({ page }) => {
    const segmento = seg();
    // Pré-condição do "primeiro": o objetivo semeado é o ÚLTIMO por ordem (nenhum outro com sort_order >= o dele).
    expect(Number(scalar(`SELECT count(*) FROM therapeutic_specific_objectives WHERE active AND id <> '${objFeliz}' AND sort_order >= 99999`))).toBe(0);
    expect(segmentoNoBanco(objFeliz)).toBe('NULL');

    await abrirCatalogo(page, admin.user);
    await expect(page.getByRole('columnheader', { name: 'Segmento' })).toBeVisible();
    await expect(page.getByTestId(`therapeutic-catalog-segment-${objFeliz}`)).toHaveText('—');

    await page.getByTestId(`therapeutic-catalog-edit-${objFeliz}`).click();
    const modal = page.getByTestId('therapeutic-catalog-form-modal');
    await expect(modal).toBeVisible();
    await expect(page.getByTestId('therapeutic-catalog-segment-select')).toHaveValue('');
    expect(await escolherNoModal(page, segmento.label)).toBe(segmento.label);
    await expect(modal).toHaveScreenshot('catalogo-vinculo-modal-segmento.png', { maxDiffPixelRatio: 0.02 });

    const patched = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes(`/therapeutic-catalogs/specific-objectives/${objFeliz}`));
    await page.getByTestId('therapeutic-catalog-form-save').click();
    const resposta = await patched;
    expect(resposta.status(), await resposta.text()).toBe(200);
    expect(resposta.request().postDataJSON().segmentId).toBe(segmento.id);
    await expect(modal).toHaveCount(0);
    await expect(page.getByTestId(`therapeutic-catalog-segment-${objFeliz}`)).toHaveText(segmento.label);
    expect(segmentoNoBanco(objFeliz)).toBe(segmento.id);
    await expect(page.getByTestId('therapeutic-catalog-table')).toHaveScreenshot('catalogo-vinculo-coluna.png', { maxDiffPixelRatio: 0.02 });

    // ── "Nuevo" do PTI: com o segmento escolhido, o objetivo vinculado vem na frente ────────
    await page.goto(`/admin/patients/${seed.patientId}`);
    await expect(page.getByTestId('projeto-terapeutico-card')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('tp-new-btn').click();
    await expect(page.getByTestId('therapeutic-project-form')).toBeVisible({ timeout: 15_000 });
    expect(await escolherSegmentoPeloTeclado(page, segmento.label)).toBe(segmento.label);
    const root = page.locator('#tp-specificObjectives');
    const gatilho = root.locator('button[aria-haspopup="listbox"]');
    await gatilho.click();
    const opcoes = root.locator('[role="option"]');
    await expect(opcoes.first()).toBeVisible();
    expect(await opcoes.count()).toBeGreaterThan(8);
    await expect(opcoes.first()).toContainText(OBJ_FELIZ);
    await gatilho.click();
  });

  test('alt 1: segmento desativado depois → o modal mostra "<rótulo> (inactivo)"; limpar salva segment_id NULL', async ({ page }) => {
    expect(segmentoNoBanco(objInativo)).toBe(segDesligado);
    await abrirCatalogo(page, admin.user);
    await expect(page.getByTestId(`therapeutic-catalog-segment-${objInativo}`)).toHaveText(`${SEG_DESLIGADO} (inactivo)`);

    await page.getByTestId(`therapeutic-catalog-edit-${objInativo}`).click();
    const campo = page.getByTestId('therapeutic-catalog-segment-select');
    await expect(campo).toBeVisible();
    expect((await campo.locator('option:checked').innerText()).trim()).toBe(`${SEG_DESLIGADO} (inactivo)`);
    await campo.click();
    await expect(campo).toBeFocused();
    await page.keyboard.type('Sin '); // type-ahead até "Sin segmento" (1ª opção; o vínculo inativo é a última)
    await expect(campo).toHaveValue('');

    const patched = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes(`/therapeutic-catalogs/specific-objectives/${objInativo}`));
    await page.getByTestId('therapeutic-catalog-form-save').click();
    const resposta = await patched;
    expect(resposta.status(), await resposta.text()).toBe(200);
    expect(resposta.request().postDataJSON().segmentId).toBeNull();
    await expect(page.getByTestId(`therapeutic-catalog-segment-${objInativo}`)).toHaveText('—');
    expect(segmentoNoBanco(objInativo)).toBe('NULL');
  });

  test('alt 2: conta sem `catalog_therapeutic_segments:read` — sem coluna e sem campo, e o resto salva sem tocar o vínculo', async ({ page }) => {
    const antes = segmentoNoBanco(objSemCelula);
    expect(antes).toBe(outroSegmento);
    const lista = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/admin/therapeutic-catalogs/segments');
    await abrirCatalogo(page, semCelula.user);
    expect((await lista).status()).toBe(403); // a recusa real da API é o que esconde o campo
    await expect(page.getByTestId(`therapeutic-catalog-label-${objSemCelula}`)).toHaveText(OBJ_SEM_CELULA);
    await expect(page.getByRole('columnheader', { name: 'Segmento' })).toHaveCount(0);
    await expect(page.locator('[data-testid^="therapeutic-catalog-segment-"]')).toHaveCount(0);

    await page.getByTestId(`therapeutic-catalog-edit-${objSemCelula}`).click();
    await expect(page.getByTestId('therapeutic-catalog-form-modal')).toBeVisible();
    await expect(page.getByTestId('therapeutic-catalog-segment-select')).toHaveCount(0);
    const input = page.getByTestId('therapeutic-catalog-label-input');
    await input.click();
    await expect(input).toBeFocused();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type(OBJ_RENOMEADO);
    expect(await input.inputValue()).toBe(OBJ_RENOMEADO);
    const patched = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes(`/therapeutic-catalogs/specific-objectives/${objSemCelula}`));
    await page.getByTestId('therapeutic-catalog-form-save').click();
    const resposta = await patched;
    expect(resposta.status(), await resposta.text()).toBe(200);
    expect(Object.keys(resposta.request().postDataJSON())).not.toContain('segmentId');
    await expect(page.getByTestId(`therapeutic-catalog-label-${objSemCelula}`)).toHaveText(OBJ_RENOMEADO);
    expect(scalar(`SELECT label FROM therapeutic_specific_objectives WHERE id = '${objSemCelula}'`)).toBe(OBJ_RENOMEADO);
    expect(segmentoNoBanco(objSemCelula)).toBe(antes);
  });
});
