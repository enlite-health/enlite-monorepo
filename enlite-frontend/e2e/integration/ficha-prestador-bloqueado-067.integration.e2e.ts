/**
 * ficha-prestador-bloqueado-067.integration.e2e.ts @integration — spec 067 (FR-08): o selo BLOQUEADO na ficha do prestador (card "Encuadres").
 *
 * E2E DE TELA, sem mock de resposta: frontend + API + Postgres reais (USE_MOCK_AUTH=true), engine OFF, clique de humano. SQL só MONTA o
 * cenário (vaga, prestador, candidatura em Completado); validar o documento é o CLIQUE do admin na ficha.
 *
 *  FELIZ — prestador REGISTERED com documentos enviados e NÃO validados, candidatura em Completado (QUALIFIED): o card "Encuadres" da ficha
 *          mostra a vaga com o selo "Bloqueados" (e NÃO "Completado"); o admin valida os dois documentos NA MESMA ficha (clique) e, ao reabri-la,
 *          o selo é "Completado" — a candidatura gravada continua QUALIFIED (o selo é derivado, nada foi movido).
 *
 * Outbound: nada (validar documento não envia). Dados SINTÉTICOS (@test.local), sem PII.
 * Pré-condições: API em localhost:8080 (USE_MOCK_AUTH=true), Vite em localhost:5173, Postgres no contêiner `E2E_PG_CONTAINER`.
 */
import { test, expect } from '@playwright/test';
import { insertAptoWorker } from '../helpers/eligibility-worker-helper';
import { loginAs, type MockUser } from '../helpers/abac-stack-helper';
import { seedMockStaff, cleanupMockStaff } from '../helpers/vacancy-notes-e2e-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { criarVagas, candidatar, limparMassa, novaMassa, abrirFicha, validarNaFicha } from '../helpers/bloqueados-067-helper';

const RUN = Date.now().toString(36);
const STAFF: MockUser = { uid: `e2e-int-ficha-bloq-067-${RUN}`, email: `ficha.bloq.067.${RUN}@e2e.test`, role: 'admin', country: 'AR' };
const massa = novaMassa();

test.describe('Ficha do prestador — selo Bloqueados no card Encuadres (spec 067) @integration', () => {
  test.use({ viewport: { width: 1500, height: 1300 }, locale: 'es-AR' });
  test.setTimeout(120_000);

  test.beforeAll(() => seedMockStaff(STAFF, 'E2E Ficha Bloq 067'));
  test.afterAll(() => {
    limparMassa(massa);
    cleanupMockStaff(STAFF);
  });

  test('FELIZ — o prestador não apto em Completado vê "Bloqueados" na ficha; validar os documentos (clique) troca o selo para "Completado"', async ({ page }) => {
    const [vaga] = criarVagas(massa, 1);
    const w = insertAptoWorker({ docs: 'unvalidated' });
    massa.workerIds.push(w.workerId);
    candidatar(w.workerId, vaga, 'QUALIFIED');

    await loginAs(page, STAFF);
    await abrirFicha(page, w.workerId);
    await page.getByRole('button', { name: 'Encuadre', exact: true }).click(); // a ficha abre em Documentos; o selo mora na aba Encuadres
    const card = page.getByTestId('worker-encuadres-card');
    await expect(card).toBeVisible();
    const linha = card.locator('tbody tr', { hasText: 'CASO' }).or(card.locator('tbody tr')).first();
    await expect(linha.getByText('Bloqueados', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(linha.getByText('Completado', { exact: true })).toHaveCount(0);
    await expect(card).toHaveScreenshot('ficha-bloqueado-067-feliz-1-selo-bloqueados.png', { maxDiffPixelRatio: 0.05, mask: [card.locator('tbody')] });

    // o admin valida os dois documentos obrigatórios, na mesma ficha (clique humano)
    await page.getByRole('button', { name: 'Documentos', exact: true }).click();
    await validarNaFicha(page, 'identity_document');
    await validarNaFicha(page, 'criminal_record');

    await abrirFicha(page, w.workerId); // reabre: o selo é lido ao vivo do dono do "apto"
    await page.getByRole('button', { name: 'Encuadre', exact: true }).click();
    const linha2 = page.getByTestId('worker-encuadres-card').locator('tbody tr').first();
    await expect(linha2.getByText('Completado', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(linha2.getByText('Bloqueados', { exact: true })).toHaveCount(0);
    expect(runSQL(`SELECT application_funnel_stage FROM worker_job_applications WHERE worker_id = '${w.workerId}' AND job_posting_id = '${vaga}'`)).toBe('QUALIFIED');
  });
});
