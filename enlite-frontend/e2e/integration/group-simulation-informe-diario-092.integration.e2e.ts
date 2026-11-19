/**
 * group-simulation-informe-diario-092.integration.e2e.ts @integration — spec 092, T501 (CA-10): aba "Informes diarios" da ficha do paciente.
 *
 * O CAMINHO casa `group-simulation` (job engine ON, `_frontend-integration.yml` — workflow intocado) E `informe-diario-092` (o `--grep` da
 * task). Engine ABAC de verdade LIGADO: sem `daily_report:read` a aba nem existe; com ela, a lista e o detalhe; o TEXTO só com
 * `daily_report_narrative:read` — sem ela o servidor manda `narrative: null` + `narrativeRedacted: true` e o espião NÃO está em byte nenhum
 * da resposta nem da tela.
 *
 *   A = células de leitura da ficha + `daily_report:read`            → vê a lista e o detalhe, SEM o texto (aviso de redação).
 *   B = A + `daily_report_narrative:read`                            → vê o texto (`NARRATIVA-ESPIA-092`).
 *   C = só as células de leitura da ficha                            → sem a aba; a rota responde 403.
 *
 * Contas por `seedStaffInGroup`/`grantCell`, `role: 'recruiter'`, `country: 'AR'`. Células concedidas ANTES do 1º request; `pollAuthz`
 * confirma o contrato (presença/ausência da célula) antes de abrir a tela. Nenhum `page.route` de dado: o interceptor só troca o
 * Authorization, a resposta é a real. Semente por SQL (`informe-diario-092-seed.ts`), dado 100% sintético.
 *
 * Prints (só com `PRINTS_092_DIR` setado — nunca no commit): lista como A, detalhe como B, ficha de C.
 */
import { test, expect, type Page, type Response } from '@playwright/test';
import { insertTestPatient, insertTestWorker, cleanupTestPatient, cleanupTestWorker } from '../helpers/db-test-helper';
import {
  tokenFor, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, pollAuthz, ABAC_API_URL, type MockUser,
} from '../helpers/abac-stack-helper';
import { seedServiceWithLiveVacancySql, cleanupItineraryWrite } from '../helpers/itinerario-escrita-e2e-helper';
import { seedInformesDiarios, ESPIA_092 } from '../helpers/informe-diario-092-seed';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const mk = (slug: string): MockUser => {
  const uid = `qa.sim.informe092.${slug}.${RUN_ID}`;
  return { uid, email: `${uid}@enlite.test`, role: 'recruiter', country: 'AR' };
};
const A = mk('a');
const B = mk('b');
const C = mk('c');

const READ_CELLS: Array<[string, string]> = [['patient', 'read'], ['patient_identity', 'read']];
const TAB_LABEL = 'Informes diarios';
const PRINTS_DIR = process.env.PRINTS_092_DIR;

interface AuthzBody { enforcement?: string; permissions?: string[] }
const has = (b: AuthzBody | null, cell: string): boolean => Array.isArray(b?.permissions) && b.permissions.includes(cell);

const isDailyReportsGet = (r: Response, patientId: string): boolean =>
  r.request().method() === 'GET' && new RegExp(`/api/admin/patients/${patientId}/daily-reports(\\?|$)`).test(r.url());

/**
 * Ficha do paciente. Devolve o GET da lista (esperado com o listener registrado ANTES do `goto`): quem só tem `daily_report:read` não vê a aba
 * "Clínicos" e a PRIMEIRA aba visível (a dos informes) já abre ativa — o GET sai no carregamento, não no clique. `null` se a aba não existir.
 */
async function openFicha(page: Page, patientId: string, timeout = 25_000): Promise<Response | null> {
  const listGet = page
    .waitForResponse((r) => isDailyReportsGet(r, patientId) && r.status() === 200, { timeout })
    .catch(() => null);
  await page.goto(`/admin/patients/${patientId}`);
  await expect(page.getByTestId('patient-profile-tabs')).toBeVisible({ timeout: 15_000 });
  return listGet;
}

/** Clique real na aba (a ativa por padrão fica ativa) e a raiz visível; devolve a resposta da lista. */
async function openTab(page: Page, resp: Response | null): Promise<Response> {
  await page.getByTestId('patient-profile-tabs').getByRole('button', { name: TAB_LABEL }).click();
  await expect(page.getByTestId('informes-diarios-aba')).toBeVisible({ timeout: 15_000 });
  if (!resp) throw new Error('informe-diario-092: o GET daily-reports não saiu');
  return resp;
}

async function print(page: Page, name: string): Promise<void> {
  // A aba fica abaixo das duas fichas: rola até o topo dela para o print (1440x900) mostrar lista + detalhe.
  if (PRINTS_DIR && (await page.getByTestId('informes-diarios-aba').count()) > 0) {
    await page.getByTestId('informes-diarios-aba').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  }
  if (PRINTS_DIR) await page.screenshot({ path: `${PRINTS_DIR}/${name}.png`, fullPage: false });
}

test.describe('informe-diario-092 sob engine ligado @integration', () => {
  test.use({ viewport: { width: 1440, height: 900 }, locale: 'es-AR', timezoneId: 'America/Argentina/Buenos_Aires', deviceScaleFactor: 1 });
  test.setTimeout(240_000);

  test('informe-diario-092', async ({ page, request, browser }) => {
    const groups: Record<string, string> = {};
    let patientId = '';
    let workerId = '';
    let recentId = '';
    try {
      for (const [key, u] of [['a', A], ['b', B], ['c', C]] as const) {
        ({ groupId: groups[key] } = seedStaffInGroup({ uid: u.uid, email: u.email, groupName: `Informe092 ${key.toUpperCase()} ${RUN_ID}`, country: 'AR' }));
        for (const [resource, action] of READ_CELLS) grantCell(groups[key], resource, action);
      }
      grantCell(groups.a, 'daily_report', 'read');
      grantCell(groups.b, 'daily_report', 'read');
      grantCell(groups.b, 'daily_report_narrative', 'read');

      const a = await pollAuthz(request, A, (b: AuthzBody) => b?.enforcement === 'on' && has(b, 'daily_report:read'));
      const b = await pollAuthz(request, B, (x: AuthzBody) => x?.enforcement === 'on' && has(x, 'daily_report_narrative:read'));
      const c = await pollAuthz(request, C, (x: AuthzBody) => x?.enforcement === 'on' && Array.isArray(x?.permissions));
      expect(has(a.body, 'daily_report_narrative:read'), 'A: sem a célula do texto').toBe(false);
      expect(has(b.body, 'daily_report:read'), 'B: com a célula de estrutura').toBe(true);
      expect(has(c.body, 'daily_report:read'), 'C: sem daily_report:read').toBe(false);

      const seeded = insertTestPatient({ withAddress: true, insuranceInformed: 'OSDE', firstName: 'InformeDiario', lastName: `Seed-${RUN_ID}` });
      patientId = seeded.patientId;
      const svc = seedServiceWithLiveVacancySql(patientId, seeded.addressId!);
      workerId = insertTestWorker({ occupation: 'AT' });
      const informes = seedInformesDiarios(svc.serviceId, workerId);
      recentId = informes.recentReportId;

      // ── A: estrutura sem texto ────────────────────────────────────────────────────────────
      await loginAs(page, A);
      const respA = await openTab(page, await openFicha(page, patientId));
      const bodyA = await respA.text();
      expect(bodyA, 'A: o espião não está em byte nenhum da resposta').not.toContain(ESPIA_092);
      const jsonA = JSON.parse(bodyA) as { items: Array<{ id: string; narrative: string | null; narrativeRedacted: boolean }> };
      expect(jsonA.items).toHaveLength(2);
      expect(jsonA.items.every((i) => i.narrative === null && i.narrativeRedacted === true)).toBe(true);

      const rowRecent = page.getByTestId(`informe-diario-linha-${informes.recentReportId}`);
      await expect(rowRecent).toBeVisible();
      await expect(rowRecent).toContainText(workerId.slice(-8));
      await expect(page.getByTestId(`informe-diario-respuestas-${informes.recentReportId}`)).toHaveText('2');
      await expect(page.getByTestId(`informe-diario-senal-${informes.recentReportId}`)).toContainText('Aviso inmediato');
      await expect(page.getByTestId(`informe-diario-atraso-${informes.recentReportId}`)).toHaveCount(0);
      await expect(page.getByTestId(`informe-diario-senal-${informes.oldReportId}`)).toHaveText('—');
      await expect(page.getByTestId(`informe-diario-atraso-${informes.oldReportId}`)).toBeVisible(); // fora do prazo (DC-2), derivado no servidor
      await page.getByTestId(`informe-diario-ver-${informes.recentReportId}`).click();
      await expect(page.getByTestId('informe-diario-detalle')).toBeVisible();
      await expect(page.getByTestId('informe-diario-texto-oculto')).toBeVisible();
      await expect(page.getByTestId('informe-diario-texto')).toHaveCount(0);
      expect(await page.content(), 'A: o espião não está no DOM').not.toContain(ESPIA_092);
      await print(page, '1-lista-usuario-A-sem-texto');

      // ── B: com a célula do texto (controle positivo: o espião EXISTE no banco) ─────────────
      const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'es-AR', timezoneId: 'America/Argentina/Buenos_Aires', deviceScaleFactor: 1 });
      try {
        const pageB = await ctxB.newPage();
        await loginAs(pageB, B);
        const respB = await openTab(pageB, await openFicha(pageB, patientId));
        const jsonB = (await respB.json()) as { items: Array<{ id: string; narrative: string | null; narrativeRedacted: boolean }> };
        const recentB = jsonB.items.find((i) => i.id === recentId);
        expect(recentB?.narrativeRedacted).toBe(false);
        expect(recentB?.narrative).toContain(ESPIA_092);
        await pageB.getByTestId(`informe-diario-ver-${recentId}`).click();
        await expect(pageB.getByTestId('informe-diario-texto')).toContainText(ESPIA_092);
        await expect(pageB.getByTestId('informe-diario-texto-oculto')).toHaveCount(0);
        await expect(pageB.getByTestId('informe-diario-respuestas').locator('li')).toHaveCount(2);
        await print(pageB, '2-detalle-usuario-B-con-texto');
      } finally {
        await ctxB.close();
      }

      // ── C: sem a célula — a aba não existe, a rota recusa ────────────────────────────────
      const ctxC = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'es-AR', timezoneId: 'America/Argentina/Buenos_Aires', deviceScaleFactor: 1 });
      try {
        const pageC = await ctxC.newPage();
        await loginAs(pageC, C);
        expect(await openFicha(pageC, patientId, 6_000), 'C: nenhum GET da lista sai').toBeNull();
        await expect(pageC.getByTestId('patient-profile-tabs').getByRole('button', { name: TAB_LABEL })).toHaveCount(0);
        await expect(pageC.getByTestId('informes-diarios-aba')).toHaveCount(0);
        expect(await pageC.content(), 'C: o espião não está no DOM').not.toContain(ESPIA_092);
        const denied = await request.get(`${ABAC_API_URL}/api/admin/patients/${patientId}/daily-reports`, {
          headers: { Authorization: `Bearer ${tokenFor(C)}` }, failOnStatusCode: false,
        });
        expect(denied.status(), 'C: a rota exige daily_report:read').toBe(403);
        expect(await denied.text()).not.toContain(ESPIA_092);
        await print(pageC, '3-ficha-usuario-C-sem-celula');
      } finally {
        await ctxC.close();
      }
      console.log('[092-T501]', jsonA.items.length, a.elapsedMs >= 0, b.elapsedMs >= 0, c.elapsedMs >= 0);
    } finally {
      if (patientId) cleanupItineraryWrite(patientId);
      // Paciente ANTES do prestador: apagar o paciente leva faixa e informes por CASCADE (o purge real); o informe prende o prestador por FK.
      if (patientId) cleanupTestPatient(patientId);
      if (workerId) cleanupTestWorker(workerId);
      for (const [key, u] of [['a', A], ['b', B], ['c', C]] as const) cleanupStaffAndGroup(u.uid, groups[key] ?? '');
    }
  });
});
