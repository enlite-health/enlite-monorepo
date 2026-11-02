/**
 * custos-abac.integration.e2e.ts @integration — spec 082, T043 / CA-7: `/admin/custos` com o engine ABAC LIGADO e staff REAL em grupo
 * (célula `platform_costs:read` por SQL), lendo um billing export SINTÉTICO num emulador BigQuery (`docker-compose.bigquery-emulator.yml`).
 *
 *  feliz   — com a célula: sem item no menu; abre a URL; estado "sin datos" sem nenhuma chamada; clica Sincronizar -> cartões, tabelas,
 *            linha "sin sector" e anomalia (valores do seed `worker-functions/test-fixtures/billing-export-seed.mjs`).
 *  alt 1   — sem a célula: a URL redireciona, a tela não abre e `GET /api/admin/costs/overview` -> 403.
 *  alt 2   — sincronizar de novo em < 10 s: a mensagem de espera do 429 aparece.
 *
 * ⚠️ Engine ligado + `admin.integrations` enforçada + emulador: só roda no job `integration-e2e-group-simulation` do `_frontend-integration.yml`
 * (token `custos-abac` no `--grep`). O limite de 10 s é do PROCESSO da API: o feliz é o 1º a sincronizar neste arquivo.
 */
import { test, expect } from '@playwright/test';
import {
  ABAC_API_URL, cleanupStaffAndGroup, grantCell, loginAs, pollAuthz, safeSql, seedStaffInGroup, tokenFor, type MockUser,
} from '../helpers/abac-stack-helper';

const RUN = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
const mk = (nome: string): MockUser => ({ uid: `e2e-cus-${nome}-${RUN}`, email: `cus.${nome}.${RUN}@e2e.test`, role: 'recruiter', country: 'AR' });
const COM = mk('com');
const SEM = mk('sem');
const grupos: Record<string, string> = {};

const hoje = new Date();
const diaDoMes = hoje.getUTCDate();
const ontemNoMes = diaDoMes > 1;
// Seed: 12 por dia (2+6+3+1); ontem +12. Mês corrente = dias 1..hoje; Cloud SQL = 6/dia.
const totalMes = 12 * diaDoMes + (ontemNoMes ? 12 : 0);
const sqlMes = 6 * diaDoMes;
const valor = (n: number) => new RegExp(`\\b${n},00\\b`);

test.describe('painel de custos 082 — feliz, sem célula, 429 @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  test.beforeAll(async ({ request }) => {
    for (const [chave, u] of [['com', COM], ['sem', SEM]] as Array<[string, MockUser]>) {
      grupos[chave] = seedStaffInGroup({ uid: u.uid, email: u.email, groupName: `Cus082 ${chave} ${RUN}`, country: 'AR' }).groupId;
    }
    grantCell(grupos.com, 'platform_costs', 'read');
    await pollAuthz(request, COM, (b) => b?.permissions?.includes('platform_costs:read'));
  });

  test.afterAll(() => {
    for (const [chave, u] of [['com', COM], ['sem', SEM]] as Array<[string, MockUser]>) cleanupStaffAndGroup(u.uid, grupos[chave] ?? '');
    safeSql(`DELETE FROM iam.permission_groups WHERE name LIKE 'Cus082 % ${RUN}'`);
  });

  test('feliz: sem link no menu; vazio sem chamada; Sincronizar traz cartões, tabelas, "sin sector" e anomalia', async ({ page }) => {
    const chamadas: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/costs/overview')) chamadas.push(r.url()); });

    await loginAs(page, COM);
    await expect(page.locator('a[href="/admin/custos"]')).toHaveCount(0); // DF-2: acesso só pela URL
    await page.goto('/admin/custos');
    await expect(page.getByTestId('custos-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('custos-idle')).toContainText('Sincronizar');
    await page.waitForTimeout(1_500);
    expect(chamadas).toHaveLength(0); // RF-2: abrir NÃO consulta
    await expect(page.getByTestId('custos-resultado')).toHaveCount(0);
    await expect(page.getByTestId('custos-page')).toHaveScreenshot('custos-vazio.png', { maxDiffPixelRatio: 0.002 });

    await page.getByTestId('custos-sincronizar').click();
    await expect(page.getByTestId('custos-resultado')).toBeVisible({ timeout: 60_000 });
    expect(chamadas).toHaveLength(1);
    await expect(page.getByTestId('custos-dados-ate')).toBeVisible();
    await expect(page.getByTestId('custos-card-mes-valor')).toHaveText(valor(totalMes));
    await expect(page.getByTestId('custos-card-previsao')).toBeVisible();
    await expect(page.getByTestId('custos-meses')).toBeVisible();

    const servico = page.getByTestId('custos-por-servico');
    for (const s of ['Cloud Run', 'Cloud SQL', 'Vertex AI']) await expect(servico).toContainText(s);
    await expect(servico.getByRole('row', { name: /Cloud SQL/ })).toHaveText(valor(sqlMes));
    const setor = page.getByTestId('custos-por-setor');
    await expect(setor).toContainText('plataforma');
    await expect(setor).toContainText('recrutamento');
    await expect(setor).toContainText('sin sector');
    await expect(page.getByTestId('custos-por-chamador')).toContainText('parser-sintetico');
    await expect(page.getByTestId('custos-anomalias')).toBeVisible();
    await expect(page.getByTestId('custos-anomalia').first()).toContainText('Cloud Run');

    // Os valores variam com o dia do mês: o print mede o LAYOUT, com os números e a data mascarados.
    await expect(page.getByTestId('custos-resultado')).toHaveScreenshot('custos-resultado.png', {
      maxDiffPixelRatio: 0.002,
      mask: [page.locator('[data-testid="custos-resultado"] td, [data-testid$="-valor"], [data-testid^="custos-mes-"], [data-testid^="custos-card-"] span')],
    });
  });

  test('sem célula: a URL redireciona, a tela não abre e a API recusa (403)', async ({ page }) => {
    await loginAs(page, SEM);
    await page.goto('/admin/custos');
    await expect(page).not.toHaveURL(/custos/, { timeout: 20_000 });
    await expect(page.getByTestId('custos-page')).toHaveCount(0);
    const res = await fetch(`${ABAC_API_URL}/api/admin/costs/overview`, { headers: { Authorization: `Bearer ${tokenFor(SEM)}` } });
    expect(res.status).toBe(403);
  });

  test('sincronizar de novo em < 10 s: aparece a mensagem de espera do 429', async ({ page }) => {
    await loginAs(page, COM);
    await page.goto('/admin/custos');
    const botao = page.getByTestId('custos-sincronizar');
    await botao.click();
    await expect(botao).toBeEnabled({ timeout: 60_000 }); // volta de "Sincronizando…"
    await botao.click(); // 2ª tentativa < 10 s depois da 1ª
    const erro = page.getByTestId('custos-erro');
    await expect(erro).toBeVisible({ timeout: 30_000 });
    await expect(erro).toHaveAttribute('data-code', 'admin.custos.errors.rateLimited');
    await expect(erro).toContainText('Sincronizaste hace poco');
  });
});
