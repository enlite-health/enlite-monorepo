/**
 * spec 018 PR-3 (Emenda 13/09, migration 425) — cabeçalho da ficha + gênero/idiomas, contra o
 * stack REAL (frontend + API + Postgres, engine de permissão LIGADO): zero mock, click +
 * `keyboard.type` + valor lido da TELA (memória `e2e-humano-nao-e-fill`). Molde:
 * `cobertura-emergencia-humano.integration.e2e.ts` (417/D301) + `abac-stack-helper.ts` (specs
 * de acesso por célula).
 *
 * O que se prova:
 *   1. feliz — ADMISSION sem marca de emergência: "Não definido", sem chip de alta.
 *   2. alternativo — marcar um responsável como emergência (SQL, espelha o botão da
 *      FamiliaresCard): o bloco mostra nome/telefone/documento MASCARADO (não a string crua).
 *   3. alternativo — status DISCHARGED: chip "Egresado" + linha "Desligamento" com data.
 *   4. ator SEM patient_family:read: o cabeçalho continua visível (tem patient_identity:read),
 *      mas o bloco de emergência mostra o marcador de redação — nunca o nome do responsável.
 *   5. editar gênero/idiomas pelo drawer (click + type/click) e ler de volta após reload.
 *   6. ator SEM patient_identity:write: o botão "Editar" do card "Informações Gerais" não existe.
 *   Screenshots em specs/018-planning-0909-ficha-admissao/evidencias/pr-3-local/.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { seedStaffInGroup, grantCell, cleanupStaffAndGroup, loginAs, type MockUser } from '../helpers/abac-stack-helper';
import { runSQL, cleanupPatientDeep } from '../helpers/patient-detail-a-helper';
import { insertTestPatient } from '../helpers/db-test-helper';

// `specs/` vive na raiz do ebrain, FORA desta worktree (repos/_worktrees/018-cabecalho-ficha/…) —
// caminho absoluto para não depender de quantos níveis a worktree está aninhada.
const EVID_DIR = '/Users/gabrielstein-dev/projects/enlite/ebrain/specs/018-planning-0909-ficha-admissao/evidencias/pr-3-local';

test.use({ viewport: { width: 1600, height: 1000 } });

test.describe('spec 018 PR-3 — cabeçalho da ficha (gênero/idiomas/emergência): HUMANO no stack real, engine LIGADO @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  const stamp = Date.now().toString().slice(-6);
  let patientId: string;
  let responsibleId: string;
  const completa: MockUser = { uid: `pr3h-completa-${stamp}`, email: `pr3h-completa-${stamp}@e2e.local`, role: 'admin', country: 'AR' };
  const semFamilia: MockUser = { uid: `pr3h-sem-familia-${stamp}`, email: `pr3h-sem-familia-${stamp}@e2e.local`, role: 'admin', country: 'AR' };
  const semEscrita: MockUser = { uid: `pr3h-sem-escrita-${stamp}`, email: `pr3h-sem-escrita-${stamp}@e2e.local`, role: 'admin', country: 'AR' };
  let grupoCompleta: string;
  let grupoSemFamilia: string;
  let grupoSemEscrita: string;

  test.beforeAll(() => {
    const { patientId: pid } = insertTestPatient({ status: 'ADMISSION', firstName: 'CabecalhoPR3', lastName: `Humano${stamp}` });
    patientId = pid;
    responsibleId = runSQL(
      `INSERT INTO patient_responsibles (patient_id, first_name, last_name, relationship, phone_encrypted, document_type, document_number_encrypted, is_primary, display_order, source, active)
       VALUES ('${patientId}', 'Responsavel', 'Marcado${stamp}', 'PARENT', '${Buffer.from('+54 11 5555-0001').toString('base64')}', 'DNI', '${Buffer.from('30111222').toString('base64')}', true, 1, 'admin_manual', true)
       RETURNING id`,
    ).split('\n')[0].trim();

    ({ groupId: grupoCompleta } = seedStaffInGroup({ uid: completa.uid, email: completa.email, groupName: `PR3H Completa ${stamp}`, country: 'AR' }));
    grantCell(grupoCompleta, 'patient', 'read');
    grantCell(grupoCompleta, 'patient_identity', 'read');
    grantCell(grupoCompleta, 'patient_identity', 'write');
    grantCell(grupoCompleta, 'patient_family', 'read');

    ({ groupId: grupoSemFamilia } = seedStaffInGroup({ uid: semFamilia.uid, email: semFamilia.email, groupName: `PR3H SemFamilia ${stamp}`, country: 'AR' }));
    grantCell(grupoSemFamilia, 'patient', 'read');
    grantCell(grupoSemFamilia, 'patient_identity', 'read');
    grantCell(grupoSemFamilia, 'patient_identity', 'write');
    // patient_family:read PROPOSITALMENTE ausente.

    ({ groupId: grupoSemEscrita } = seedStaffInGroup({ uid: semEscrita.uid, email: semEscrita.email, groupName: `PR3H SemEscrita ${stamp}`, country: 'AR' }));
    grantCell(grupoSemEscrita, 'patient', 'read');
    grantCell(grupoSemEscrita, 'patient_identity', 'read');
    // patient_identity:write PROPOSITALMENTE ausente.
  });

  test.afterAll(() => {
    cleanupStaffAndGroup(completa.uid, grupoCompleta);
    cleanupStaffAndGroup(semFamilia.uid, grupoSemFamilia);
    cleanupStaffAndGroup(semEscrita.uid, grupoSemEscrita);
    // Limpa a MARCA antes de apagar o responsável — senão a FK composta `patients_emergency_resp_fk`
    // (migration 423) barra o DELETE de `patient_responsibles` dentro de `cleanupPatientDeep`.
    runSQL(`UPDATE patients SET emergency_responsible_id = NULL WHERE id = '${patientId}'`);
    cleanupPatientDeep(patientId);
  });

  async function abrirFicha(page: Page, u: MockUser): Promise<void> {
    await loginAs(page, u);
    await page.goto(`/admin/patients/${patientId}`);
    await expect(page.getByTestId('patient-identity-card')).toBeVisible({ timeout: 30_000 });
  }

  test('1. feliz: ADMISSION sem marca de emergência → "Não definido", sem chip de alta', async ({ page }) => {
    await abrirFicha(page, completa);
    await expect(page.getByTestId('emergency-contact-not-set')).toHaveText('No definido');
    await expect(page.getByTestId('patient-discharge-chip')).toHaveCount(0);
    await page.screenshot({ path: path.join(EVID_DIR, '1-admission-sem-marca.png'), fullPage: false });
  });

  test('2. alternativo: marcar o responsável (SQL, espelha o botão) → nome/telefone visíveis, documento MASCARADO', async ({ page }) => {
    runSQL(`UPDATE patients SET emergency_responsible_id = '${responsibleId}' WHERE id = '${patientId}'`);
    await abrirFicha(page, completa);
    await expect(page.getByTestId('emergency-contact-name')).toHaveText('Responsavel Marcado' + stamp);
    await expect(page.getByTestId('emergency-contact-phone')).toContainText('5555-0001');
    const doc = page.getByTestId('emergency-contact-document-number');
    await expect(doc).toBeVisible();
    const docText = (await doc.textContent()) ?? '';
    expect(docText).not.toContain('30111222'); // nunca o número inteiro no DOM
    expect(docText).toContain('222'); // últimos 3 visíveis
    await page.screenshot({ path: path.join(EVID_DIR, '2-admission-com-marca.png'), fullPage: false });
  });

  test('3. alternativo: status DISCHARGED → chip de alta + linha "Desligamento" com data', async ({ page }) => {
    // migration 254: trigger `trg_patient_status_history` grava a linha sozinha no UPDATE.
    runSQL(`UPDATE patients SET status = 'DISCHARGED' WHERE id = '${patientId}'`);
    await abrirFicha(page, completa);
    await expect(page.getByTestId('patient-discharge-chip')).toBeVisible();
    await expect(page.getByTestId('patient-discharged-at')).not.toContainText('—');
    await page.screenshot({ path: path.join(EVID_DIR, '3-discharged.png'), fullPage: false });
    runSQL(`UPDATE patients SET status = 'ADMISSION' WHERE id = '${patientId}'`); // devolve pro estado dos próximos testes
  });

  test('4. ator SEM patient_family:read: cabeçalho continua visível (tem patient_identity:read), bloco de emergência mostra o marcador de redação — nunca o nome', async ({ page }) => {
    await abrirFicha(page, semFamilia);
    await expect(page.getByTestId('patient-identity-card')).toBeVisible();
    await expect(page.getByTestId('emergency-contact-redacted')).toBeVisible();
    await expect(page.getByText('Responsavel Marcado' + stamp)).toHaveCount(0);
    const innerHtml = await page.getByTestId('patient-emergency-contact-section').innerHTML();
    expect(innerHtml).not.toContain('5555-0001');
    expect(innerHtml).not.toContain('30111222');
    await page.screenshot({ path: path.join(EVID_DIR, '4-sem-patient-family-read.png'), fullPage: false });
  });

  test('5. editar gênero e idiomas pelo drawer (click + type/click) e ler de volta após reload', async ({ page }) => {
    await abrirFicha(page, completa);
    await page.getByTestId('edit-general-btn').click();
    const drawer = page.getByTestId('patient-general-edit-drawer');
    await expect(drawer).toBeVisible();
    await page.getByTestId('pge-gender').selectOption('NON_BINARY');
    const languagesBtn = page.locator('#pge-languages button');
    await languagesBtn.click();
    await page.getByRole('option', { name: 'Portugués' }).locator('button').click();
    await page.getByRole('option', { name: 'Inglés' }).locator('button').click();
    await page.getByTestId('pge-save').click();
    await expect(drawer).toBeHidden({ timeout: 10_000 });

    await page.reload();
    await expect(page.getByTestId('patient-general-info-card')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('patient-gender')).toHaveText('No binario');
    const langsText = (await page.getByTestId('patient-languages').textContent()) ?? '';
    expect(langsText).toContain('Portugués');
    expect(langsText).toContain('Inglés');
    await page.screenshot({ path: path.join(EVID_DIR, '5-gender-idiomas-editados.png'), fullPage: false });
  });

  test('6. ator SEM patient_identity:write: o botão "Editar" do card Informações Gerais não existe', async ({ page }) => {
    await abrirFicha(page, semEscrita);
    await expect(page.getByTestId('patient-general-info-card')).toBeVisible();
    await expect(page.getByTestId('edit-general-btn')).toHaveCount(0);
    await page.screenshot({ path: path.join(EVID_DIR, '6-sem-patient-identity-write.png'), fullPage: false });
  });
});
