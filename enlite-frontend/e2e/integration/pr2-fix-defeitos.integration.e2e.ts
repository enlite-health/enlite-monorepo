/**
 * pr2-fix-defeitos.integration.e2e.ts — conserto Gabriel 13/09 dos 2 defeitos do PR-2 (spec 018,
 * `contracts/support-network.md`, D-A). Um HUMANO no stack real (frontend + API + Postgres,
 * engine de permissão LIGADO), zero mock: click + `keyboard.type`. Molde:
 * `rede-de-apoio-humano.integration.e2e.ts`.
 *
 * O que se prova:
 *   1. Defeito 1 — apagar o telefone do contato marcado de emergência dá 422; a mensagem
 *      (`pxc-error`) fica VISÍVEL e o drawer continua ABERTO (antes: o catch chamava `onSaved()`
 *      → `refetch` → `isLoading` → a página inteira ia pro skeleton e o drawer sumia junto).
 *   2. Defeito 1, alternativo — salvar um valor VÁLIDO fecha o drawer e recarrega a lista.
 *   3. Defeito 2 — a coluna "Emergencia" de `FamiliaresCard` mostra o marcador na linha do
 *      responsável marcado mesmo para um ator SEM `patient_family:write` (só `:read`) — antes,
 *      o único indicador era o `EmergencyMarkButton` (um `ActionButton`, D269: some sem escrita).
 *   4. Defeito 2, alternativo — desmarcar faz o indicador sumir.
 */
import { test, expect, type Page } from '@playwright/test';
import { insertTestPatient } from '../helpers/db-test-helper';
import { runSQL, cleanupPatientDeep } from '../helpers/patient-detail-c-helper';
import {
  psql, scalar, safeSql, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, ABAC_TENANT,
} from '../helpers/abac-stack-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
// Evidência visual pedida pelo Gabriel (fora do baseline pixel-diff do Playwright — dado
// SINTÉTICO gerado por corrida, uma comparação de pixel contra baseline fixo quebraria a cada
// execução por causa do nome aleatório; screenshot solto em disco é o que a task pediu). Caminho
// vem de `EVIDENCIAS_DIR` (env) — `ebrain/specs/` vive FORA deste repo (a worktree do monorepo
// `infra` está em `repos/_worktrees/018-pr2-fix/`, `specs/` é do checkout principal do `ebrain`,
// então não há caminho relativo estável daqui até lá). Sem a env, os screenshots são pulados —
// os prints locais continuam funcionando para quem exporta a variável.
const EVIDENCIAS_DIR = process.env.EVIDENCIAS_DIR;
async function screenshot(target: Page | ReturnType<Page['getByTestId']>, path: string): Promise<void> {
  if (!EVIDENCIAS_DIR) return;
  await target.screenshot({ path: `${EVIDENCIAS_DIR}/${path}` });
}

async function abrirAbaRedeDeApoio(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Red de Apoyo/i }).click();
}

// Atalho de "selecionar tudo" — igual a `rede-de-apoio-por-linha.integration.e2e.ts:33`
// (Meta+A só seleciona no macOS; Control+A no resto).
const SELECT_ALL = process.platform === 'darwin' ? 'Meta+A' : 'Control+A';

/**
 * Substitui o conteúdo de um campo por HUMANO: seleciona tudo pelo teclado e digita por cima
 * (a seleção some o texto velho na primeira tecla, como um humano faz). SEM clicar de novo
 * depois do Ctrl/Cmd+A — um `click()` no meio reposiciona o cursor e desfaz a seleção, e o
 * texto novo entra INTERCALADO no antigo em vez de substituí-lo (defeito medido 13/09: telefone
 * gravado saiu `+54911555500+549115555007799` — nem o antigo nem o novo, os dois emendados).
 */
async function substituir(page: Page, testId: string, texto: string): Promise<void> {
  const campo = page.getByTestId(testId);
  await campo.click();
  await expect(campo).toBeFocused();
  await page.keyboard.press(SELECT_ALL);
  await page.keyboard.type(texto);
  await expect(campo).toHaveValue(texto);
}

test.use({ viewport: { width: 1600, height: 1000 }, video: 'on' });

test.describe('conserto PR-2 (13/09) — defeito 1 (422 mudo) e defeito 2 (coluna Emergencia vazia) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  // DOIS pacientes: `patients_emergency_one` (CHECK, migration 423) proíbe as duas marcas
  // (responsável + contato externo) no MESMO paciente — cada defeito usa a marca do SEU kind.
  let patientId1: string; // defeito 1 — contato externo marcado
  let patientId2: string; // defeito 2 — responsável marcado
  let externalContactId: string;
  let responsibleId: string;
  const completaUid = `e2e-pr2fix-completa-${RUN_ID}`;
  const completaEmail = `${completaUid}@e2e.test`;
  const soLeituraUid = `e2e-pr2fix-soleitura-${RUN_ID}`;
  const soLeituraEmail = `${soLeituraUid}@e2e.test`;
  let completaGroupId = '';
  let soLeituraGroupId = '';

  test.beforeAll(() => {
    patientId1 = insertTestPatient({ status: 'ADMISSION', firstName: 'PR2Fix1', lastName: `Humano${Date.now()}` }).patientId;
    patientId2 = insertTestPatient({ status: 'ADMISSION', firstName: 'PR2Fix2', lastName: `Humano${Date.now()}` }).patientId;

    psql(`INSERT INTO iam.permissions (resource, action, description, category) VALUES
            ('patient', 'read', 'e2e PR-2 fix', 'Pacientes'),
            ('patient_family', 'read', 'e2e PR-2 fix', 'Pacientes'),
            ('patient_family', 'write', 'e2e PR-2 fix', 'Pacientes')
          ON CONFLICT DO NOTHING`);

    // Contato externo COM telefone, marcado de emergência — usado no defeito 1.
    runSQL(
      `INSERT INTO patient_external_contacts (patient_id, relation, name, phone_encrypted, active, created_by)
       VALUES ('${patientId1}', 'TEACHER', 'Profesora PR2Fix', '${b64('+5491155550099')}', true, 'e2e:pr2-fix')`,
    );
    externalContactId = scalar(`SELECT id FROM patient_external_contacts WHERE patient_id = '${patientId1}' AND name = 'Profesora PR2Fix'`);
    expect(externalContactId).toBeTruthy();
    psql(`UPDATE patients SET emergency_external_contact_id = '${externalContactId}' WHERE id = '${patientId1}'`);

    // Responsável COM telefone, marcado de emergência — usado no defeito 2.
    runSQL(
      `INSERT INTO patient_responsibles (patient_id, first_name, last_name, relationship, phone_encrypted, is_primary, display_order, source, active)
       VALUES ('${patientId2}', 'Responsavel', 'MarcadoPR2Fix', 'PARENT', '${b64('+5491155550088')}', true, 1, 'web_form', true)`,
    );
    responsibleId = scalar(`SELECT id FROM patient_responsibles WHERE patient_id = '${patientId2}' AND last_name = 'MarcadoPR2Fix'`);
    expect(responsibleId).toBeTruthy();
    psql(`UPDATE patients SET emergency_responsible_id = '${responsibleId}' WHERE id = '${patientId2}'`);

    completaGroupId = seedStaffInGroup({ uid: completaUid, email: completaEmail, groupName: `PR2Fix Completa ${RUN_ID}`, country: 'AR' }).groupId;
    grantCell(completaGroupId, 'patient', 'read');
    grantCell(completaGroupId, 'patient_family', 'read');
    grantCell(completaGroupId, 'patient_family', 'write');

    soLeituraGroupId = seedStaffInGroup({ uid: soLeituraUid, email: soLeituraEmail, groupName: `PR2Fix SoLeitura ${RUN_ID}`, country: 'AR' }).groupId;
    grantCell(soLeituraGroupId, 'patient', 'read');
    grantCell(soLeituraGroupId, 'patient_family', 'read'); // SEM :write — é o que o defeito 2 prova
  });

  test.afterAll(() => {
    // Limpa a MARCA de emergência antes de apagar a linha que ela referencia — a FK composta
    // da migration 423 (`patients_emergency_resp_fk`/`..._ext_fk`) recusa deletar uma linha
    // enquanto `patients.emergency_*_id` ainda apontar pra ela.
    safeSql(`UPDATE patients SET emergency_external_contact_id = NULL WHERE id = '${patientId1}'`);
    safeSql(`UPDATE patients SET emergency_responsible_id = NULL WHERE id = '${patientId2}'`);
    cleanupPatientDeep(patientId1);
    cleanupPatientDeep(patientId2);
    cleanupStaffAndGroup(completaUid, completaGroupId);
    cleanupStaffAndGroup(soLeituraUid, soLeituraGroupId);
    safeSql(`DELETE FROM iam.permission_groups WHERE tenant_id = '${ABAC_TENANT}' AND name LIKE 'PR2Fix % ${RUN_ID}'`);
  });

  test('defeito 1: apagar o telefone do contato marcado de emergência dá 422 — a mensagem fica visível, o drawer continua aberto', async ({ page }) => {
    await loginAs(page, { uid: completaUid, email: completaEmail, role: 'admin', country: 'AR' });
    await page.goto(`/admin/patients/${patientId1}`);
    await expect(page.getByTestId('patient-profile-tabs')).toBeVisible({ timeout: 30_000 });
    await abrirAbaRedeDeApoio(page);
    const card = page.getByTestId('external-contacts-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText('Profesora PR2Fix');

    await page.getByTestId('edit-external-contacts-btn').click();
    const drawer = page.getByTestId('patient-external-contacts-edit-drawer');
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId('pxc-phone-0')).toHaveValue('+5491155550099');

    // Apaga o telefone do contato MARCADO de emergência — o backend recusa com 422
    // (EMERGENCY_CONTACT_REQUIRES_PHONE / trigger de validação da 423).
    const phone = page.getByTestId('pxc-phone-0');
    await phone.click();
    await phone.press(SELECT_ALL);
    await phone.press('Backspace');
    await expect(phone).toHaveValue('');

    const patch = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes(`/external-contacts/${externalContactId}`));
    await page.getByTestId('pxc-save').click();
    const patchResponse = await patch;
    expect(patchResponse.status()).toBe(422);

    // O CONSERTO: a mensagem pinta e o drawer NÃO fecha/some (antes, `onSaved()` no catch
    // ligava `isLoading` do pai e a página inteira ia pro skeleton, levando o drawer junto).
    await expect(page.getByTestId('pxc-error')).toBeVisible({ timeout: 10_000 });
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId('patient-profile-tabs')).toBeVisible();

    await screenshot(page, '1-erro-422-drawer-continua-aberto.png');

    // Fecha sem salvar (Escape + confirma descarte) para não deixar o telefone apagado no banco
    // — a próxima verificação (alternativo: salvar válido) parte do telefone original.
    await page.keyboard.press('Escape');
    if (await page.getByTestId('discard-changes-confirm').isVisible().catch(() => false)) {
      await page.getByTestId('discard-changes-discard').click();
    }
    await expect(drawer).toHaveCount(0, { timeout: 10_000 });

    const phoneNoBanco = runSQL(`SELECT convert_from(decode(phone_encrypted,'base64'),'UTF8') FROM patient_external_contacts WHERE id = '${externalContactId}'`);
    expect(phoneNoBanco.trim()).toContain('+5491155550099');
  });

  test('defeito 1, alternativo: salvar um telefone VÁLIDO fecha o drawer e recarrega a lista', async ({ page }) => {
    await loginAs(page, { uid: completaUid, email: completaEmail, role: 'admin', country: 'AR' });
    await page.goto(`/admin/patients/${patientId1}`);
    await expect(page.getByTestId('patient-profile-tabs')).toBeVisible({ timeout: 30_000 });
    await abrirAbaRedeDeApoio(page);
    await page.getByTestId('edit-external-contacts-btn').click();
    const drawer = page.getByTestId('patient-external-contacts-edit-drawer');
    await expect(drawer).toBeVisible();

    // O CONSERTO (defeito B do gate): substituir por teclado, sem clique no meio — ver
    // `substituir()`. O telefone digitado é o que tem de ficar gravado, não uma emenda com o
    // antigo.
    const NOVO_TELEFONE = '+5491155550077';
    await substituir(page, 'pxc-phone-0', NOVO_TELEFONE);

    const patch = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes(`/external-contacts/${externalContactId}`));
    await page.getByTestId('pxc-save').click();
    expect((await patch).status()).toBe(200);
    await expect(drawer).toHaveCount(0, { timeout: 15_000 });
    const card = page.getByTestId('external-contacts-card');
    await expect(card).toContainText('Profesora PR2Fix');
    // O valor GRAVADO, lido de volta na linha do card — não só "salvou 200 e o nome apareceu".
    // Sem isto, o teste passa mesmo se o telefone tivesse sido concatenado com o antigo.
    await expect(card).toContainText(NOVO_TELEFONE);
    await expect(card).not.toContainText('+5491155550099');
    const phoneNoBanco = runSQL(`SELECT convert_from(decode(phone_encrypted,'base64'),'UTF8') FROM patient_external_contacts WHERE id = '${externalContactId}'`);
    expect(phoneNoBanco.trim()).toBe(NOVO_TELEFONE);
    await screenshot(card, '1-alt-sucesso-fecha-e-recarrega.png');
  });

  test('defeito 2: SEM patient_family:write, a linha do responsável MARCADO mostra o indicador de emergência (botão de ação some, D269 — mas a informação fica)', async ({ page }) => {
    await loginAs(page, { uid: soLeituraUid, email: soLeituraEmail, role: 'admin', country: 'AR' });
    await page.goto(`/admin/patients/${patientId2}`);
    await expect(page.getByTestId('patient-profile-tabs')).toBeVisible({ timeout: 30_000 });
    await abrirAbaRedeDeApoio(page);
    const card = page.getByTestId('familiares-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText('Responsavel MarcadoPR2Fix', { timeout: 30_000 });

    // D269 continua valendo para a AÇÃO: sem :write, o botão de marcar/desmarcar some.
    await expect(page.locator('[data-testid^="emergency-mark-"]')).toHaveCount(0);
    // O CONSERTO: mesmo assim, o indicador de emergência (informação) aparece na linha marcada.
    await expect(page.getByTestId(`familiares-emergency-marked-${responsibleId}`)).toBeVisible();

    await screenshot(card, '2-indicador-sem-write.png');
  });

  test('defeito 2, alternativo: desmarcar (com write) faz o indicador sumir da linha', async ({ page }) => {
    await loginAs(page, { uid: completaUid, email: completaEmail, role: 'admin', country: 'AR' });
    await page.goto(`/admin/patients/${patientId2}`);
    await expect(page.getByTestId('patient-profile-tabs')).toBeVisible({ timeout: 30_000 });
    await abrirAbaRedeDeApoio(page);
    const card = page.getByTestId('familiares-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId(`familiares-emergency-marked-${responsibleId}`)).toBeVisible();

    const del = page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes(`/patients/${patientId2}/emergency-contact`));
    await page.getByTestId(`emergency-mark-RESPONSIBLE-${responsibleId}`).click();
    expect((await del).status()).toBe(200);

    await expect(page.getByTestId(`familiares-emergency-marked-${responsibleId}`)).toHaveCount(0, { timeout: 15_000 });
    const marca = scalar(`SELECT emergency_responsible_id FROM patients WHERE id = '${patientId2}'`);
    expect(marca).toBe('');
    await screenshot(card, '2-alt-desmarcado-indicador-some.png');
  });
});
