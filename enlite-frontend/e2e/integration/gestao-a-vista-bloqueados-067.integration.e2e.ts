/**
 * gestao-a-vista-bloqueados-067.integration.e2e.ts @integration — spec 067 (FR-08, FR-09): a coluna BLOQUEADO do funil da Gestão à Vista.
 *
 * E2E DE TELA, sem mock de resposta: frontend + API + Postgres reais (USE_MOCK_AUTH=true), engine OFF, clique de humano. SQL só MONTA o
 * cenário (vaga, prestador, candidatura); validar o documento é o CLIQUE do admin na ficha. O número lido é o que a TELA mostra.
 * O banco do CI é compartilhado: cada asserção é um DELTA sobre o que a tela mostrava antes de a massa entrar (a mesma conta, lida duas vezes).
 *
 *  FELIZ — prestador REGISTERED com documentos NÃO validados e candidatura em Completado: a coluna Bloqueados sobe 1 e Completos NÃO o conta
 *          (nas duas vistas do funil); o "?" da coluna abre a ajuda dela.
 *  ALT 1 — o admin valida os dois documentos na ficha (clique): o inverso — Bloqueados volta ao que era e Completos sobe 1.
 *  ALT 2 — a coluna aparece SEMPRE, com número (nunca ausente nem vazia) — inclusive depois que o prestador saiu de Bloqueados; no stack limpo
 *          o valor lido é "0" literal.
 *
 * Outbound: nada (validar documento não envia; sem webhook, sem Pub/Sub, sem Twilio). Dados SINTÉTICOS (@test.local), sem PII.
 * Pré-condições: API em localhost:8080 (USE_MOCK_AUTH=true), Vite em localhost:5173, Postgres no contêiner `E2E_PG_CONTAINER`.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { insertAptoWorker } from '../helpers/eligibility-worker-helper';
import { tokenFor, loginAs, type MockUser } from '../helpers/abac-stack-helper';
import {
  criarVagas, candidatar, limparMassa, novaMassa, validarOsDoisDocumentos, seedStaffComPais, cleanupStaffComPais,
} from '../helpers/bloqueados-067-helper';

const RUN = Date.now().toString(36);
const STAFF: MockUser = { uid: `e2e-int-gestao-bloq-067-${RUN}`, email: `gestao.bloq.067.${RUN}@e2e.test`, role: 'admin', country: 'AR' };
const massa = novaMassa();
let groupId = '';

/** A Gestão à Vista chama `/analytics/**`, que o interceptador padrão não cobre (sairia com o JWT fake -> 401): troca o token só ali. */
async function trocarTokenEmAnalytics(page: Page): Promise<void> {
  await page.route('**/analytics/**', async (route: Route) => {
    await route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${tokenFor(STAFF)}` } });
  });
}

type Vista = 'mgmt-funnel-consolidado' | 'mgmt-funnel-por-etapa';
const VISTAS: Vista[] = ['mgmt-funnel-consolidado', 'mgmt-funnel-por-etapa'];

/** O número que a TELA mostra na coluna `coluna` da vista `vista`. Falha se a coluna não existir ou o texto não for um inteiro. */
async function lerColuna(page: Page, vista: Vista, coluna: 'BLOQUEADO' | 'COMPLETED'): Promise<number> {
  const celula = page.getByTestId(`${vista}-${coluna}`);
  await expect(celula, `a coluna ${coluna} da vista ${vista} tem de existir`).toBeVisible({ timeout: 30_000 });
  const texto = (await celula.locator('p.font-poppins').innerText()).trim();
  expect(texto, `a coluna ${coluna} mostra um número`).toMatch(/^\d+$/);
  return Number(texto);
}

/** Abre a Gestão à Vista do zero (a página busca o painel ao montar) e devolve Bloqueados/Completos das duas vistas. */
async function lerFunil(page: Page): Promise<Record<Vista, { bloqueado: number; completos: number }>> {
  await page.goto('/admin/dashboard');
  await expect(page.getByTestId('mgmt-funnel')).toBeVisible({ timeout: 30_000 });
  const out = {} as Record<Vista, { bloqueado: number; completos: number }>;
  for (const v of VISTAS) out[v] = { bloqueado: await lerColuna(page, v, 'BLOQUEADO'), completos: await lerColuna(page, v, 'COMPLETED') };
  return out;
}

test.describe('Gestão à Vista — coluna Bloqueados do funil (spec 067) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(150_000);
  test.use({ viewport: { width: 1600, height: 1300 }, locale: 'es-AR' });

  let antes: Record<Vista, { bloqueado: number; completos: number }>;
  let workerId = '';
  let vagaId = '';

  test.beforeAll(() => {
    groupId = seedStaffComPais(STAFF, `Gestao Bloq 067 ${RUN}`);
    const [vaga] = criarVagas(massa, 1);
    // REGISTERED, documentos enviados e NÃO validados -> não apto; candidatura em Completado (QUALIFIED) numa vaga viva
    const w = insertAptoWorker({ docs: 'unvalidated' });
    workerId = w.workerId;
    massa.workerIds.push(workerId);
    vagaId = vaga;
  });

  test.afterAll(() => {
    limparMassa(massa);
    cleanupStaffComPais(STAFF.uid, groupId);
  });

  test('FELIZ — o prestador não apto em Completado soma 1 em Bloqueados e NÃO conta em Completos; o "?" da coluna abre a ajuda', async ({ page }) => {
    await trocarTokenEmAnalytics(page);
    await loginAs(page, STAFF);
    antes = await lerFunil(page); // a mesma tela, lida ANTES de a candidatura do não apto entrar no funil
    candidatar(workerId, vagaId, 'QUALIFIED');

    const depois = await lerFunil(page);
    for (const v of VISTAS) {
      expect(depois[v].bloqueado, `${v}: Bloqueados sobe 1`).toBe(antes[v].bloqueado + 1);
      expect(depois[v].completos, `${v}: Completos NÃO conta o não apto`).toBe(antes[v].completos);
    }

    await expect(page.getByTestId('mgmt-funnel-consolidado-BLOQUEADO')).toHaveScreenshot('gestao-bloqueados-067-feliz-coluna.png', {
      maxDiffPixelRatio: 0.05,
      mask: [page.getByTestId('mgmt-funnel-consolidado-BLOQUEADO').locator('p.font-poppins')], // o número depende do banco compartilhado
    });

    // a ajuda da coluna (FR-09): clique no "?" da coluna Bloqueados da vista consolidada
    await page.getByTestId('mgmt-funnel-consolidado-BLOQUEADO').getByTestId('metric-help').click();
    const gaveta = page.getByTestId('mgmt-help-drawer');
    await expect(gaveta).toBeVisible();
    await expect(gaveta).toContainText('Bloqueados (columna)');
    await expect(gaveta).toContainText('documentos obligatorios no están todos validados');
    await expect(gaveta).toContainText('panel y Kanban cuentan igual');
    await page.getByTestId('mgmt-help-close').click();
    await expect(page.getByTestId('mgmt-help-drawer')).toHaveCount(0);
  });

  test('ALT 1 — o admin valida os dois documentos na ficha (clique): o inverso — Bloqueados volta ao que era e Completos sobe 1', async ({ page }) => {
    await trocarTokenEmAnalytics(page);
    await loginAs(page, STAFF);
    await validarOsDoisDocumentos(page, workerId);

    const depois = await lerFunil(page);
    for (const v of VISTAS) {
      expect(depois[v].bloqueado, `${v}: Bloqueados volta ao de antes`).toBe(antes[v].bloqueado);
      expect(depois[v].completos, `${v}: Completos sobe 1`).toBe(antes[v].completos + 1);
    }
  });

  test('ALT 2 — a coluna Bloqueados aparece SEMPRE, com número, mesmo quando ninguém do funil está bloqueado por MIM (nunca ausente nem vazia)', async ({ page }) => {
    await trocarTokenEmAnalytics(page);
    await loginAs(page, STAFF);
    const lido = await lerFunil(page); // o prestador já está apto (ALT 1): nada meu em Bloqueados
    for (const v of VISTAS) {
      expect(lido[v].bloqueado, `${v}: nenhum prestador MEU em Bloqueados`).toBe(antes[v].bloqueado);
      await expect(page.getByTestId(`${v}-BLOQUEADO`).locator('p.font-poppins')).toHaveText(String(antes[v].bloqueado));
    }
    test.info().annotations.push({ type: 'bloqueados-lido', description: `consolidado=${lido['mgmt-funnel-consolidado'].bloqueado} por-etapa=${lido['mgmt-funnel-por-etapa'].bloqueado}` });
  });
});

