/**
 * custos-linha-unica.integration.e2e.ts @integration — spec 082, T084 / CA-14 (linha única, UI-1/UI-2/UI-3) e CA-18 (contraste >= 7:1, UI-4).
 * Títulos com o token `custos-abac` (entram no `--grep` do job `integration-e2e-group-simulation`). Mesmo stack do `custos-painel`.
 *
 *  CA-14  matriz {1440, 400} px x {es, pt-BR} com o dado MAIS LONGO (recurso `assistants-service-maria-whatsapp-handler-prd`, 45 caracteres):
 *         0 elementos `[data-single-line]` com mais de 1 linha, contagem por tipo (nome, selo, cabeçalho, data, valor) > 0 (contagem 0 é falha),
 *         sem rolagem horizontal da PÁGINA. Controle positivo: um elemento SEM `nowrap` com o nome longo TEM de medir > 1 linha.
 *  CA-18  nenhum nó de texto de `[data-testid^="custos"]` abaixo de 7:1, no A1, no A2 e no dia calmo. Controle positivo: `text-gray-800` reprova.
 *
 * O viewport muda SEM recarregar (o resultado vive em memória): 1 sincronização por idioma. Respeita a janela de 10 s da API entre elas.
 */
import { test, expect, type Page } from '@playwright/test';
import { cleanupStaffAndGroup, grantCell, loginAs, pollAuthz, safeSql, seedStaffInGroup, type MockUser } from '../helpers/abac-stack-helper';
import {
  NOME_LONGO, controlePositivoContraste, controlePositivoLinhaUnica, esperarJanela, medirContraste, medirLinhaUnica, semearCenario,
  semRolagemHorizontal, sincronizar,
} from '../helpers/custos-painel-helper';

const RUN = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
const COM: MockUser = { uid: `e2e-clu-com-${RUN}`, email: `clu.com.${RUN}@e2e.test`, role: 'recruiter', country: 'AR' };
let grupo = '';

const VIEWPORTS = [{ nome: '1440', width: 1440, height: 900 }, { nome: '400', width: 400, height: 800 }] as const;
const IDIOMAS = ['es', 'pt-BR'] as const;
const TIPOS = ['nome', 'selo', 'cabecalho', 'data', 'valor'];
const ABAS = ['service', 'resource', 'sector', 'ai', 'project'];

async function medirLinhas(page: Page, onde: string): Promise<void> {
  const m = await medirLinhaUnica(page, '[data-testid="custos-page"]');
  expect(m.multilinha, `${onde}: elementos com mais de 1 linha`).toEqual([]);
  for (const tipo of TIPOS) expect(m.porTipo[tipo] ?? 0, `${onde}: contagem de [data-single-line="${tipo}"]`).toBeGreaterThan(0);
  const { scrollWidth, innerWidth } = await semRolagemHorizontal(page);
  expect(scrollWidth, `${onde}: rolagem horizontal da página`).toBeLessThanOrEqual(innerWidth);
}

async function medirContrasteTela(page: Page, onde: string): Promise<void> {
  const m = await medirContraste(page);
  expect(m.nos, `${onde}: nós de texto medidos (0 é falha)`).toBeGreaterThan(20);
  expect(m.abaixo, `${onde}: texto abaixo de 7:1`).toEqual([]);
}

test.describe('custos-abac · linha única e contraste 082 (CA-14, CA-18) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300_000);

  test.beforeAll(async ({ request }) => {
    grupo = seedStaffInGroup({ uid: COM.uid, email: COM.email, groupName: `Clu082 ${RUN}`, country: 'AR' }).groupId;
    grantCell(grupo, 'platform_costs', 'read');
    await pollAuthz(request, COM, (b) => b?.permissions?.includes('platform_costs:read'));
    await esperarJanela(true);
  });

  test.afterAll(() => {
    cleanupStaffAndGroup(COM.uid, grupo);
    safeSql(`DELETE FROM iam.permission_groups WHERE name LIKE 'Clu082 ${RUN}'`);
  });

  test('custos-abac controles positivos: sem nowrap o nome longo mede > 1 linha; text-gray-800 reprova a 7:1', async ({ page }) => {
    semearCenario('anomaly');
    await loginAs(page, COM);
    await page.goto('/admin/custos?lng=pt-BR');
    await expect(page.getByTestId('custos-page')).toBeVisible({ timeout: 30_000 });
    await page.setViewportSize({ width: 1440, height: 900 });
    expect(await controlePositivoLinhaUnica(page)).toBeGreaterThan(1);
    const c = await controlePositivoContraste(page);
    expect(c.nos).toBe(1);
    expect(c.abaixo).toHaveLength(1);
    expect(c.abaixo[0].razao).toBeLessThan(7);
  });

  for (const lng of IDIOMAS) {
    test(`custos-abac CA-14/CA-18 linha única e contraste, ${lng}, A1 e A2 a 1440 e 400 px`, async ({ page }) => {
      semearCenario('anomaly');
      await loginAs(page, COM);
      await page.goto(`/admin/custos?lng=${lng}`);
      await expect(page.getByTestId('custos-page')).toBeVisible({ timeout: 30_000 });
      await sincronizar(page);
      await expect(page.getByTestId('custos-anomalias')).toContainText(NOME_LONGO);

      for (const vp of VIEWPORTS) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        for (const aba of ABAS) {
          await page.getByTestId(`custos-aba-${aba}`).click();
          await medirLinhas(page, `A1 ${lng} ${vp.nome}px aba ${aba}`);
        }
        await page.getByTestId('custos-aba-resource').click();
        await medirContrasteTela(page, `A1 ${lng} ${vp.nome}px (recurso)`);
        await page.getByTestId('custos-aba-service').click();
        await medirContrasteTela(page, `A1 ${lng} ${vp.nome}px (serviço)`);

        await page.getByTestId('custos-ver-detalhe').first().click();
        await expect(page.getByTestId('custos-detalhe')).toBeVisible();
        await expect(page.getByTestId('custos-detalhe-recursos')).toContainText(NOME_LONGO);
        await medirLinhas(page, `A2 ${lng} ${vp.nome}px`);
        await medirContrasteTela(page, `A2 ${lng} ${vp.nome}px`);
        await page.getByTestId('custos-voltar').click();
        await expect(page.getByTestId('custos-quem-gasta')).toBeVisible();
      }
    });
  }

  test('custos-abac CA-18 contraste do dia calmo (pt-BR, 1440 e 400 px)', async ({ page }) => {
    semearCenario('calm');
    await loginAs(page, COM);
    await page.goto('/admin/custos?lng=pt-BR');
    await expect(page.getByTestId('custos-page')).toBeVisible({ timeout: 30_000 });
    await sincronizar(page);
    await expect(page.getByTestId('custos-anomalias-vazio')).toBeVisible();
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await medirContrasteTela(page, `calmo ${vp.nome}px`);
      await medirLinhas(page, `calmo ${vp.nome}px`);
    }
  });
});
