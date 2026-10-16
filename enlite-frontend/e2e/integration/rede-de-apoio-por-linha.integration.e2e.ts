/**
 * rede-de-apoio-por-linha.integration.e2e.ts — spec 018, PR-1, ADR-1 (US-0; tasks.md 1.10).
 *
 * Um HUMANO, contra o stack REAL (frontend + API + Postgres + emulador Firebase), zero mock: click +
 * `keyboard.type` + valor lido da TELA. Prova que a rede de apoio (responsáveis) passou a ser
 * gravada POR LINHA — `PATCH /patients/:id/support-network` (a lista inteira) é 410 desde o PR-1.
 *
 * Fluxo POR LINHA na tela (igual às outras listas do paciente): "Nuevo" abre o drawer de UM familiar,
 * o lápis da linha edita aquele familiar, a lixeira da linha pede confirmação e desativa.
 *
 * O que se prova:
 *   1. feliz — criar 2 familiares (um drawer por familiar), editar o 1º pelo lápis; os DOIS ids
 *      continuam os mesmos antes/depois de editar um deles (identidade estável — nunca DELETE+INSERT);
 *   2. alternativo — remover um familiar pela lixeira + confirmação: ele some do card (a linha
 *      continua no banco, active=false);
 *   3. alternativo — editar um familiar que "outra aba" desativou enquanto este ficava com o drawer
 *      aberto: a API recusa (404, active passou a false) e o drawer mostra o erro genérico na tela
 *      (lex C1.3: nunca ecoa o payload);
 *   4. foto do card com os dois familiares (`toHaveScreenshot`).
 */
import { test, expect, type Page } from '@playwright/test';
import { insertTestPatient } from '../helpers/db-test-helper';
import { runSQL, cleanupPatientDeep } from '../helpers/patient-detail-c-helper';
import { loginComoHumano } from '../helpers/login-humano';

const STAFF_EMAIL = `e2e.rede.${Date.now()}@enlite.health`;

async function abrirAbaRedeDeApoio(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Red de Apoyo/i }).click();
}

/** Como um humano edita um campo que já tem valor: seleciona tudo (Ctrl/Cmd+A) e retype. */
async function digitar(page: Page, testId: string, texto: string): Promise<void> {
  const campo = page.getByTestId(testId);
  await campo.click();
  await expect(campo).toBeFocused();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.type(texto);
  await expect(campo).toHaveValue(texto);
}

/** Id do familiar (pelo nome) — o lápis/lixeira da linha levam o id no testid. */
const idDoFamiliar = (patientId: string, firstName: string): string => runSQL(
  `SELECT id FROM patient_responsibles WHERE patient_id = '${patientId}' AND first_name = '${firstName}'`,
).trim();

const responsaveisNoBanco = (patientId: string) => runSQL(
  `SELECT id, first_name, active FROM patient_responsibles WHERE patient_id = '${patientId}' ORDER BY created_at`,
).trim();

test.use({ viewport: { width: 1600, height: 1000 }, video: 'on' });

test.describe('spec 018/PR-1 — rede de apoio por LINHA: um HUMANO no stack real @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  let patientId: string;

  test.beforeAll(() => {
    const seeded = insertTestPatient({ status: 'ADMISSION', firstName: 'RedeApoio', lastName: `Linha${Date.now()}` });
    patientId = seeded.patientId;
  });
  test.afterAll(() => {
    cleanupPatientDeep(patientId);
  });

  test('feliz: criar 2 familiares pelo drawer, editar o 1º → os DOIS ids continuam os mesmos (identidade estável, nunca DELETE+INSERT)', async ({ page }) => {
    await loginComoHumano(page, STAFF_EMAIL, 'E2E Rede de Apoio');
    await page.goto(`/admin/patients/${patientId}`);
    await expect(page.getByTestId('patient-profile-tabs')).toBeVisible({ timeout: 30_000 });
    await abrirAbaRedeDeApoio(page);
    const card = page.getByTestId('familiares-card');
    await expect(card).toBeVisible({ timeout: 30_000 });

    // Primeiro familiar: "Nuevo" abre o drawer de UM familiar em branco.
    await page.getByTestId('familiares-add').click();
    const drawer = page.getByTestId('responsible-edit-drawer');
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId('responsible-firstName')).toHaveValue('');
    await digitar(page, 'responsible-firstName', 'Ana');
    await digitar(page, 'responsible-lastName', 'Sintética');
    await digitar(page, 'responsible-phone', '+54 11 5555-0001');
    const postAna = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes(`/patients/${patientId}/responsibles`));
    await page.getByTestId('responsible-save').click();
    expect((await postAna).status()).toBe(201);
    await expect(drawer).toHaveCount(0, { timeout: 15_000 });

    // Segundo familiar: outro "Nuevo", outro drawer em branco.
    await page.getByTestId('familiares-add').click();
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId('responsible-firstName')).toHaveValue('');
    await digitar(page, 'responsible-firstName', 'Beatriz');
    await digitar(page, 'responsible-lastName', 'Sintética');
    await digitar(page, 'responsible-phone', '+54 11 5555-0002');
    const postBeatriz = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes(`/patients/${patientId}/responsibles`));
    await page.getByTestId('responsible-save').click();
    expect((await postBeatriz).status()).toBe(201);
    await expect(drawer).toHaveCount(0, { timeout: 15_000 });

    await expect(card).toContainText('Ana');
    await expect(card).toContainText('Beatriz');

    const antes = responsaveisNoBanco(patientId);
    const linhasAntes = antes.split('\n').filter(Boolean);
    expect(linhasAntes).toHaveLength(2);
    const idAna = linhasAntes.find((l) => l.includes('Ana'))!.trim().split('|')[0].trim();

    // Editar SÓ o telefone da Ana pelo lápis da linha dela — o id dela e o da Beatriz continuam os mesmos.
    await page.getByTestId(`familiares-edit-${idAna}`).click();
    await expect(page.getByTestId('responsible-firstName')).toHaveValue('Ana');
    const patch = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes(`/patients/${patientId}/responsibles/`));
    await digitar(page, 'responsible-phone', '+54 11 5555-9999');
    await page.getByTestId('responsible-save').click();
    expect((await patch).status()).toBe(200);
    await expect(page.getByTestId('responsible-edit-drawer')).toHaveCount(0, { timeout: 15_000 });

    const depois = responsaveisNoBanco(patientId).split('\n').filter(Boolean);
    expect(depois).toHaveLength(2);
    const idsAntes = linhasAntes.map((l) => l.trim().split('|')[0].trim()).sort();
    const idsDepois = depois.map((l) => l.trim().split('|')[0].trim()).sort();
    expect(idsDepois).toEqual(idsAntes); // MESMOS ids — nunca DELETE+INSERT
    expect(idAna).toBeTruthy();

    await expect(card).toHaveScreenshot('rede-de-apoio-card-2-familiares.png', {
      mask: [page.locator('.firebase-emulator-warning')],
      maxDiffPixelRatio: 0.02,
    });
  });

  test('alternativo: remover a Beatriz pela lixeira + confirmação → some do card; a linha continua no banco com active=false', async ({ page }) => {
    await loginComoHumano(page, STAFF_EMAIL, 'E2E Rede de Apoio');
    await page.goto(`/admin/patients/${patientId}`);
    await expect(page.getByTestId('patient-profile-tabs')).toBeVisible({ timeout: 30_000 });
    await abrirAbaRedeDeApoio(page);
    const card = page.getByTestId('familiares-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText('Beatriz', { timeout: 30_000 });

    const idBeatriz = idDoFamiliar(patientId, 'Beatriz');
    await page.getByTestId(`familiares-deactivate-${idBeatriz}`).click();
    // A lixeira só ABRE a confirmação — nada foi desativado ainda.
    const confirmar = page.getByTestId('deactivate-responsible-confirm');
    await expect(confirmar).toBeVisible();
    await expect(page.getByTestId('deactivate-responsible-name')).toContainText('Beatriz');
    await expect(card).toContainText('Beatriz');
    const deactivate = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/responsibles/') && r.url().includes('/deactivate'));
    await page.getByTestId('deactivate-responsible-confirm-button').click();
    expect((await deactivate).status()).toBe(200);
    await expect(confirmar).toHaveCount(0, { timeout: 15_000 });

    await expect(card).not.toContainText('Beatriz');
    await expect(card).toContainText('Ana'); // a outra linha sobrevive intacta

    const linhas = responsaveisNoBanco(patientId).split('\n').filter(Boolean);
    expect(linhas).toHaveLength(2); // NUNCA DELETE — as duas linhas continuam existindo
    const beatriz = linhas.find((l) => l.includes('Beatriz'))!;
    expect(beatriz).toContain('|f'); // active = false (psql -tAc imprime "f", sem espaço)
  });

  test('alternativo: editar um familiar que "outra aba" acabou de desativar → a API recusa (404) e o drawer mostra o erro na tela', async ({ page }) => {
    await loginComoHumano(page, STAFF_EMAIL, 'E2E Rede de Apoio');
    await page.goto(`/admin/patients/${patientId}`);
    await expect(page.getByTestId('patient-profile-tabs')).toBeVisible({ timeout: 30_000 });
    await abrirAbaRedeDeApoio(page);
    await expect(page.getByTestId('familiares-card')).toBeVisible({ timeout: 30_000 });

    await page.getByTestId(`familiares-edit-${idDoFamiliar(patientId, 'Ana')}`).click();
    await expect(page.getByTestId('responsible-firstName')).toHaveValue('Ana');

    // "Outra aba" desativa a Ana ENQUANTO este drawer está aberto com os dados antigos na tela.
    runSQL(`UPDATE patient_responsibles SET active = false, deactivated_at = NOW(), deactivated_by = 'outra-aba-e2e' WHERE patient_id = '${patientId}' AND first_name = 'Ana'`);

    await digitar(page, 'responsible-phone', '+54 11 5555-0000');
    await page.getByTestId('responsible-save').click();
    // lex C1.3: mensagem genérica, nunca ecoa o payload.
    const erro = page.getByTestId('responsible-error');
    await expect(erro).toBeVisible({ timeout: 15_000 });
    await expect(erro).not.toContainText('5555-0000');
    // O drawer continua aberto (a régua de erro não fecha sozinha).
    await expect(page.getByTestId('responsible-edit-drawer')).toBeVisible();

    // Restaura a Ana como ativa para não contaminar o resto da suíte (nenhum outro teste depende
    // disto, mas o afterAll já limpa o paciente inteiro de qualquer forma).
    runSQL(`UPDATE patient_responsibles SET active = true, deactivated_at = NULL, deactivated_by = NULL WHERE patient_id = '${patientId}' AND first_name = 'Ana'`);
  });
});
