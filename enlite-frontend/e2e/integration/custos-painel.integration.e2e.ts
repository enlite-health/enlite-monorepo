/**
 * custos-painel.integration.e2e.ts @integration — spec 082, T083 / CA-7 (refeito, direção A): `/admin/custos` com o engine ABAC LIGADO e staff REAL
 * em grupo (célula `platform_costs:read` por SQL), lendo um billing export SINTÉTICO num emulador BigQuery (`docker-compose.bigquery-emulator.yml`).
 * Os títulos levam o token `custos-abac`: entram no `--grep` do job `integration-e2e-group-simulation` sem editar o workflow.
 *
 *  (a) feliz com anomalia — "antes de sincronizar" sem chamada -> Sincronizar -> veredito "3 coisas fora do normal" + 3 números + "Quem gasta"
 *      nas 5 abas -> "Ver detalhe" -> A2 (série e quebra por recurso) -> "Voltar ao painel"; TOTAL de chamadas a `/costs/overview` = 1.
 *  (b) dia calmo           — a seed `calm` (mesmo dado, ontem igual à mediana): "Nada fora do normal", sem cartão.
 *  (c) histórico curto     — a seed `short` (5 dias): "Histórico insuficiente", NUNCA "nada fora do normal".
 *  (d) sem célula          — a URL redireciona, a tela não abre e a API recusa (403). (O 429 fica em `custos-abac.integration.e2e.ts`.)
 *
 * A seed troca de cenário por arquivo (`helpers/custos-painel-helper.ts#semearCenario`); o limite de 10 s da API é por PROCESSO, então cada
 * sincronização espera a janela. ⚠️ Roda só no job `integration-e2e-group-simulation` (engine ligado + emulador), com `--workers=1`.
 * Os números mudam com o dia do mês: os prints mascaram valores, datas e gráficos (medem LAYOUT).
 */
import { test, expect, type Page } from '@playwright/test';
import { escolherNoCombo } from '../helpers/combobox';
import {
  ABAC_API_URL, cleanupStaffAndGroup, grantCell, loginAs, pollAuthz, safeSql, seedStaffInGroup, tokenFor, type MockUser,
} from '../helpers/abac-stack-helper';
import { NOME_LONGO, contarChamadas, esperadoAnomaly, esperarJanela, semearCenario, sincronizar, valor } from '../helpers/custos-painel-helper';

const RUN = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
const mk = (nome: string): MockUser => ({ uid: `e2e-cpn-${nome}-${RUN}`, email: `cpn.${nome}.${RUN}@e2e.test`, role: 'recruiter', country: 'AR' });
const COM = mk('com');
const SEM = mk('sem');
const grupos: Record<string, string> = {};

// Os números, datas, gráficos e os textos que carregam o dia/mês mudam a cada dia: o print mede o LAYOUT com eles mascarados.
const MASCARAS = (page: Page) => [
  page.locator('[data-single-line="valor"], [data-single-line="data"], svg, [data-testid^="custos-card-"], [data-testid="custos-regra"], [data-testid="custos-meses"], [data-testid="custos-quem-gasta"] > div:first-child p, [data-testid="custos-detalhe"] h3, [data-testid="custos-anomalias-vazio"]'),
];

/** Print do elemento inteiro: viewport alto (o elemento maior que a tela sai com partes em branco) e largura fixa de 1440 px. */
async function prepararPrint(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 2400 });
  await page.mouse.move(0, 0);
}

async function abrir(page: Page, lng: 'pt-BR' | 'es'): Promise<void> {
  await page.goto(`/admin/custos?lng=${lng}`);
  await expect(page.getByTestId('custos-page')).toBeVisible({ timeout: 30_000 });
}

test.describe('custos-abac · painel 082 direção A — anomalia, dia calmo, histórico curto, sem célula @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  test.beforeAll(async ({ request }) => {
    for (const [chave, u] of [['com', COM], ['sem', SEM]] as Array<[string, MockUser]>) {
      grupos[chave] = seedStaffInGroup({ uid: u.uid, email: u.email, groupName: `Cpn082 ${chave} ${RUN}`, country: 'AR' }).groupId;
    }
    grantCell(grupos.com, 'platform_costs', 'read');
    await pollAuthz(request, COM, (b) => b?.permissions?.includes('platform_costs:read'));
    await esperarJanela(true); // o arquivo anterior (custos-abac) pode ter sincronizado há instantes
  });

  test.afterAll(() => {
    for (const [chave, u] of [['com', COM], ['sem', SEM]] as Array<[string, MockUser]>) cleanupStaffAndGroup(u.uid, grupos[chave] ?? '');
    safeSql(`DELETE FROM iam.permission_groups WHERE name LIKE 'Cpn082 % ${RUN}'`);
  });

  test('custos-abac (a) feliz com anomalia: antes de sincronizar, veredito, números, 5 abas, detalhe, voltar — e UMA chamada só', async ({ page }) => {
    semearCenario('anomaly');
    const esp = esperadoAnomaly();
    const chamadas = contarChamadas(page);

    await loginAs(page, COM);
    await abrir(page, 'pt-BR');
    await expect(page.getByTestId('custos-idle')).toContainText('Sincronizar');
    await page.waitForTimeout(1_500);
    expect(chamadas.total()).toBe(0); // RF-2: abrir NÃO consulta
    await expect(page.getByTestId('custos-resultado')).toHaveCount(0);

    await sincronizar(page);
    expect(chamadas.total()).toBe(1);
    await expect(page.getByTestId('custos-dados-ate')).toBeVisible();

    // Veredito: serviço + recurso + recurso novo = 3 itens (o "novo" conta no título, DF-5 não muda).
    await expect(page.getByTestId('custos-veredito-titulo')).toContainText('3 coisas fora do normal');
    await expect(page.getByTestId('custos-anomalia')).toHaveCount(3);
    await expect(page.getByTestId('custos-anomalia').first()).toContainText('Cloud Run');
    await expect(page.getByTestId('custos-selo-novo').first()).toBeVisible();
    await expect(page.getByTestId('custos-anomalias')).toContainText(NOME_LONGO); // UI-2: recurso novo de nome longo como item de anomalia

    // 3 números do mês
    await expect(page.getByTestId('custos-card-mes-valor')).toHaveText(valor(esp.total));
    await expect(page.getByTestId('custos-card-previsao-valor')).toBeVisible();
    await expect(page.getByTestId('custos-card-variacao')).toBeVisible();

    // "Quem gasta": as 5 abas
    const quem = page.getByTestId('custos-quem-gasta');
    await expect(quem.getByRole('tab')).toHaveCount(5);
    const servico = page.getByTestId('custos-por-servico');
    for (const s of ['Cloud Run', 'Cloud SQL', 'Vertex AI', 'Cloud Storage']) await expect(servico).toContainText(s);
    await expect(servico.getByRole('row', { name: /Cloud SQL/ }).getByRole('cell').nth(1)).toHaveText(valor(esp.cloudSql));

    await page.getByTestId('custos-aba-resource').click();
    const recurso = page.getByTestId('custos-por-recurso');
    await expect(recurso).toContainText(NOME_LONGO);
    await expect(recurso.locator('[data-kind="none"]')).toHaveCount(1); // "sem recurso", garantido mesmo com > 30 recursos
    await expect(recurso.locator('[data-kind="rest"]')).toHaveCount(1); // "demais recursos"
    await expect(recurso.getByTestId('custos-linha')).not.toHaveCount(0);

    await page.getByTestId('custos-aba-sector').click();
    const setor = page.getByTestId('custos-por-setor');
    await expect(setor).toContainText('plataforma');
    await expect(setor).toContainText('recrutamento');
    await expect(setor).toContainText('sem setor');

    await page.getByTestId('custos-aba-ai').click();
    await expect(page.getByTestId('custos-por-chamador')).toContainText('parser-sintetico');

    await page.getByTestId('custos-aba-project').click();
    const projeto = page.getByTestId('custos-por-projeto');
    await expect(projeto).toContainText('enlite-test');
    await expect(projeto).toContainText('enlite-stg');
    await expect(projeto.locator('[data-kind="none"]')).toHaveCount(1); // "sem projeto"
    await page.getByTestId('custos-aba-service').click();

    await prepararPrint(page);
    await expect(page.getByTestId('custos-resultado')).toHaveScreenshot('custos-a1.png', { maxDiffPixelRatio: 0.002, mask: MASCARAS(page) });

    // A2: "Ver detalhe" troca o estado, sem reconsultar
    await page.getByTestId('custos-ver-detalhe').first().click();
    await expect(page.getByTestId('custos-detalhe')).toBeVisible();
    await expect(page.getByTestId('custos-barras-diarias')).toBeVisible();
    await expect(page.getByTestId('custos-detalhe-no-mes')).toHaveText(valor(esp.cloudRun)); // = byService (mesmo número do A1)
    const linhas = page.getByTestId('custos-detalhe-linha');
    await expect(linhas.first()).toContainText('api-sintetica');
    await expect(page.getByTestId('custos-selo-maior')).toHaveCount(1);
    await expect(page.getByTestId('custos-detalhe-recursos')).toContainText(NOME_LONGO);
    await prepararPrint(page);
    await expect(page.getByTestId('custos-resultado')).toHaveScreenshot('custos-a2.png', { maxDiffPixelRatio: 0.002, mask: MASCARAS(page) });

    await page.getByTestId('custos-voltar').click();
    await expect(page.getByTestId('custos-quem-gasta')).toBeVisible();
    await expect(page.getByTestId('custos-detalhe')).toHaveCount(0);
    expect(chamadas.total()).toBe(1); // sincronizar + abrir o detalhe + voltar = UMA requisição (CA-7)
  });

  test('custos-abac (b) dia calmo: "Nada fora do normal" com a regra, sem cartão de anomalia', async ({ page }) => {
    semearCenario('calm');
    await loginAs(page, COM);
    await abrir(page, 'pt-BR');
    await sincronizar(page);
    await expect(page.getByTestId('custos-anomalias-vazio')).toContainText('Nada fora do normal');
    await expect(page.getByTestId('custos-regra').or(page.getByTestId('custos-anomalias-vazio'))).toContainText('Regra:');
    await expect(page.getByTestId('custos-anomalia')).toHaveCount(0);
    await expect(page.getByTestId('custos-anomalias-insuficiente')).toHaveCount(0);
    await expect(page.getByTestId('custos-quem-gasta')).toBeVisible();
    await prepararPrint(page);
    await expect(page.getByTestId('custos-resultado')).toHaveScreenshot('custos-calmo.png', { maxDiffPixelRatio: 0.002, mask: MASCARAS(page) });
  });

  test('custos-abac (c) histórico insuficiente: diz que não calculou, nunca "nada fora do normal"', async ({ page }) => {
    semearCenario('short');
    await loginAs(page, COM);
    await abrir(page, 'pt-BR');
    await sincronizar(page);
    await expect(page.getByTestId('custos-anomalias-insuficiente')).toContainText('Histórico insuficiente');
    await expect(page.getByTestId('custos-anomalias-vazio')).toHaveCount(0);
    await expect(page.getByTestId('custos-anomalia')).toHaveCount(0);
    await expect(page.getByTestId('custos-quem-gasta')).toBeVisible(); // o resto da tela segue
  });

  test('custos-abac (e) mês fechado: sem aviso de atraso, linha "Mês fechado…", sem previsão e +1 chamada com `month`', async ({ page }) => {
    semearCenario('anomaly', 45); // 45 dias: o mês anterior tem linhas em qualquer dia do mês
    const chamadas = contarChamadas(page);
    const urls: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/costs/overview')) urls.push(r.url()); });
    await loginAs(page, COM);
    await abrir(page, 'pt-BR');
    await sincronizar(page);
    expect(chamadas.total()).toBe(1);
    await expect(page.getByTestId('custos-card-previsao')).toBeVisible(); // mês corrente: 3 cartões
    await expect(page.getByTestId('custos-anomalias-mes-fechado')).toHaveCount(0);

    const hoje = new Date();
    const anterior = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - 1, 1));
    const rotulo = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(anterior);
    await esperarJanela();
    await escolherNoCombo(page, '[data-testid="custos-mes-select"]', rotulo);
    await expect(page.getByTestId('custos-anomalias-mes-fechado')).toContainText('Mês fechado: a detecção de anomalias olha só o mês corrente.', { timeout: 60_000 });
    expect(chamadas.total()).toBe(2); // 1 chamada a mais, e só uma
    const mes = `${anterior.getUTCFullYear()}-${String(anterior.getUTCMonth() + 1).padStart(2, '0')}`;
    expect(urls[1]).toContain(`month=${mes}`);
    await expect(page.getByTestId('custos-atrasado')).toHaveCount(0);
    await expect(page.getByTestId('custos-card-previsao')).toHaveCount(0);
    await expect(page.getByTestId('custos-card-mes')).toContainText('Total do mês');
    await expect(page.getByTestId('custos-anomalia')).toHaveCount(0);
    await expect(page.getByTestId('custos-anomalias-insuficiente')).toHaveCount(0);
    await expect(page.getByTestId('custos-anomalias-vazio')).toHaveCount(0);
  });

  test('custos-abac (d) sem célula: a URL redireciona, a tela não abre e a API recusa (403)', async ({ page }) => {
    await loginAs(page, SEM);
    await page.goto('/admin/custos');
    await expect(page).not.toHaveURL(/custos/, { timeout: 20_000 });
    await expect(page.getByTestId('custos-page')).toHaveCount(0);
    await expect(page.getByTestId('custos-sincronizar')).toHaveCount(0);
    const res = await fetch(`${ABAC_API_URL}/api/admin/costs/overview`, { headers: { Authorization: `Bearer ${tokenFor(SEM)}` } });
    expect(res.status).toBe(403);
  });
});
