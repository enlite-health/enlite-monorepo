/**
 * rede-de-apoio-humano.integration.e2e.ts — spec 018, PR-2 (`lex` #4, D-A).
 *
 * Um HUMANO, contra o stack REAL (frontend + API + Postgres, engine de permissão LIGADO), zero
 * mock: click + `keyboard.type` + `selectOption` só no `<select>` nativo. Molde:
 * `rede-de-apoio-por-linha.integration.e2e.ts` (PR-1) + `abac-stack-helper.ts` (grupos ABAC).
 *
 * O que se prova:
 *   1. feliz — criar um contato externo COM telefone pelo drawer "Red de contactos" e marcá-lo
 *      como contato de emergência do paciente;
 *   2. alt 1 — sem `patient_family:write` (só `:read`) os botões de escrever (Novo, marcar
 *      emergência) SOMEM do DOM, mas a leitura da caixa continua (D269: esconder, não desabilitar);
 *   3. alt 2 — tentar marcar de emergência um contato SEM telefone é recusado (422
 *      EMERGENCY_CONTACT_REQUIRES_PHONE) e a tela mostra o alerta, sem marcar nada.
 */
import { test, expect, type Page } from '@playwright/test';
import { insertTestPatient } from '../helpers/db-test-helper';
import { runSQL, cleanupPatientDeep } from '../helpers/patient-detail-c-helper';
import {
  psql, scalar, safeSql, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, ABAC_TENANT,
} from '../helpers/abac-stack-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

async function abrirAbaRedeDeApoio(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Red de Apoyo/i }).click();
}

/** Como um humano digita: clica, checa foco, digita — nunca `fill()`. */
async function digitar(page: Page, testId: string, texto: string): Promise<void> {
  const campo = page.getByTestId(testId);
  await campo.click();
  await expect(campo).toBeFocused();
  await page.keyboard.type(texto);
  await expect(campo).toHaveValue(texto);
}

const externosNoBanco = (patientId: string) => runSQL(
  `SELECT id, relation, name, active FROM patient_external_contacts WHERE patient_id = '${patientId}' ORDER BY created_at`,
).trim();

test.use({ viewport: { width: 1600, height: 1000 }, video: 'on' });

test.describe('spec 018/PR-2 — rede de apoio (contatos externos + marca de emergência): um HUMANO no stack real @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  let patientId: string;
  const completaUid = `e2e-pr2-completa-${RUN_ID}`;
  const completaEmail = `${completaUid}@e2e.test`;
  const soLeituraUid = `e2e-pr2-soleitura-${RUN_ID}`;
  const soLeituraEmail = `${soLeituraUid}@e2e.test`;
  let completaGroupId = '';
  let soLeituraGroupId = '';

  test.beforeAll(() => {
    const seeded = insertTestPatient({ status: 'ADMISSION', firstName: 'RedeApoioPR2', lastName: `Humano${Date.now()}` });
    patientId = seeded.patientId;

    // Catálogo: as 3 células precisam existir em iam.permissions antes de conceder a um grupo
    // (grantCell falha alto se a célula não existir — nunca silêncio).
    psql(`INSERT INTO iam.permissions (resource, action, description, category) VALUES
            ('patient', 'read', 'e2e PR-2 humano', 'Pacientes'),
            ('patient_family', 'read', 'e2e PR-2 humano', 'Pacientes'),
            ('patient_family', 'write', 'e2e PR-2 humano', 'Pacientes')
          ON CONFLICT DO NOTHING`);

    completaGroupId = seedStaffInGroup({ uid: completaUid, email: completaEmail, groupName: `PR2 Completa ${RUN_ID}`, country: 'AR' }).groupId;
    grantCell(completaGroupId, 'patient', 'read');
    grantCell(completaGroupId, 'patient_family', 'read');
    grantCell(completaGroupId, 'patient_family', 'write');

    soLeituraGroupId = seedStaffInGroup({ uid: soLeituraUid, email: soLeituraEmail, groupName: `PR2 SoLeitura ${RUN_ID}`, country: 'AR' }).groupId;
    grantCell(soLeituraGroupId, 'patient', 'read');
    grantCell(soLeituraGroupId, 'patient_family', 'read'); // SEM :write — é o que este teste prova
  });

  test.afterAll(() => {
    cleanupPatientDeep(patientId);
    cleanupStaffAndGroup(completaUid, completaGroupId);
    cleanupStaffAndGroup(soLeituraUid, soLeituraGroupId);
    safeSql(`DELETE FROM iam.permission_groups WHERE tenant_id = '${ABAC_TENANT}' AND name LIKE 'PR2 % ${RUN_ID}'`);
  });

  test('feliz: com patient_family:write, cria um contato externo COM telefone e marca como emergência', async ({ page }) => {
    await loginAs(page, { uid: completaUid, email: completaEmail, role: 'admin', country: 'AR' });
    await page.goto(`/admin/patients/${patientId}`);
    await expect(page.getByTestId('patient-profile-tabs')).toBeVisible({ timeout: 30_000 });
    await abrirAbaRedeDeApoio(page);
    const card = page.getByTestId('external-contacts-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText('Red de contactos');

    await page.getByTestId('edit-external-contacts-btn').click();
    const drawer = page.getByTestId('patient-external-contacts-edit-drawer');
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId('pxc-empty')).toBeVisible();

    await page.getByTestId('pxc-add').click();
    await page.getByTestId('pxc-relation-0').selectOption('TEACHER');
    await digitar(page, 'pxc-name-0', 'Profesora Sintética');
    await digitar(page, 'pxc-phone-0', '+54 11 5555-0001');

    const postContato = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes(`/patients/${patientId}/external-contacts`));
    await page.getByTestId('pxc-save').click();
    expect((await postContato).status()).toBe(201);
    await expect(drawer).toHaveCount(0, { timeout: 15_000 });

    await expect(card).toContainText('Profesora Sintética');

    const linhas = externosNoBanco(patientId).split('\n').filter(Boolean);
    expect(linhas).toHaveLength(1);
    const contatoId = linhas[0].trim().split('|')[0].trim();
    expect(contatoId).toBeTruthy();

    // Marca de emergência — o botão nasce "Marcar", vira "Contacto de emergencia (quitar)".
    const marcarBtn = page.getByTestId(`emergency-mark-EXTERNAL-${contatoId}`);
    await expect(marcarBtn).toBeVisible();
    const putEmergencia = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes(`/patients/${patientId}/emergency-contact`));
    await marcarBtn.click();
    expect((await putEmergencia).status()).toBe(200);
    await expect(page.getByTestId(`emergency-mark-EXTERNAL-${contatoId}`)).toContainText(/quitar/i, { timeout: 15_000 });

    const marca = scalar(`SELECT emergency_external_contact_id FROM patients WHERE id = '${patientId}'`);
    expect(marca).toBe(contatoId);

    await expect(card).toHaveScreenshot('rede-de-apoio-humano-marcado.png', {
      mask: [page.locator('.firebase-emulator-warning')],
      maxDiffPixelRatio: 0.02,
    });
  });

  test('alt 1: sem `patient_family:write` (só `:read`) os botões de escrever SOMEM; a leitura da caixa continua', async ({ page }) => {
    await loginAs(page, { uid: soLeituraUid, email: soLeituraEmail, role: 'admin', country: 'AR' });
    await page.goto(`/admin/patients/${patientId}`);
    await expect(page.getByTestId('patient-profile-tabs')).toBeVisible({ timeout: 30_000 });
    await abrirAbaRedeDeApoio(page);
    const card = page.getByTestId('external-contacts-card');
    await expect(card).toBeVisible({ timeout: 30_000 });

    // A leitura continua: o contato criado no teste feliz aparece.
    await expect(card).toContainText('Profesora Sintética', { timeout: 30_000 });

    // D269: sem a célula de escrita, os botões SOMEM (toHaveCount(0)) — não ficam desabilitados.
    await expect(page.getByTestId('edit-external-contacts-btn')).toHaveCount(0);
    await expect(page.locator('[data-testid^="emergency-mark-"]')).toHaveCount(0);
  });

  test('alt 2: marcar de emergência um contato SEM telefone é recusado (422); nada fica marcado', async ({ page }) => {
    await loginAs(page, { uid: completaUid, email: completaEmail, role: 'admin', country: 'AR' });
    await page.goto(`/admin/patients/${patientId}`);
    await expect(page.getByTestId('patient-profile-tabs')).toBeVisible({ timeout: 30_000 });
    await abrirAbaRedeDeApoio(page);
    const card = page.getByTestId('external-contacts-card');
    await expect(card).toBeVisible({ timeout: 30_000 });

    // Cria um SEGUNDO contato, sem telefone — o drawer já abre com a Profesora (índice 0);
    // a linha nova nasce no índice 1.
    await page.getByTestId('edit-external-contacts-btn').click();
    const drawer = page.getByTestId('patient-external-contacts-edit-drawer');
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId('pxc-name-0')).toHaveValue('Profesora Sintética');
    await page.getByTestId('pxc-add').click();
    await page.getByTestId('pxc-relation-1').selectOption('NEIGHBOR');
    await digitar(page, 'pxc-name-1', 'Vecina Sin Telefono');
    const postContato = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes(`/patients/${patientId}/external-contacts`));
    await page.getByTestId('pxc-save').click();
    expect((await postContato).status()).toBe(201);
    await expect(drawer).toHaveCount(0, { timeout: 15_000 });
    await expect(card).toContainText('Vecina Sin Telefono');

    const linhas = externosNoBanco(patientId).split('\n').filter(Boolean);
    const semTelefone = linhas.find((l) => l.includes('Vecina Sin Telefono'))!;
    const contatoId = semTelefone.trim().split('|')[0].trim();

    // O componente mostra o erro via `window.alert` — captura o diálogo.
    const dialogPromise = page.waitForEvent('dialog');
    const putEmergencia = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes(`/patients/${patientId}/emergency-contact`));
    await page.getByTestId(`emergency-mark-EXTERNAL-${contatoId}`).click();
    expect((await putEmergencia).status()).toBe(422);
    const dialog = await dialogPromise;
    expect(dialog.message()).not.toContain('Vecina'); // lex C1.3: nunca ecoa o payload
    await dialog.accept();

    // O botão continua dizendo "marcar" — nada foi marcado.
    await expect(page.getByTestId(`emergency-mark-EXTERNAL-${contatoId}`)).toContainText(/marcar/i);
    const marca = scalar(`SELECT emergency_external_contact_id FROM patients WHERE id = '${patientId}'`);
    expect(marca).not.toBe(contatoId);
  });
});
