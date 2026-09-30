/**
 * group-simulation-catalogo-motivos-sem-celula.integration.e2e.ts @integration — Fase 1 da change
 * itinerario-trocas-motivos-e-figma. Sem `catalog_service_exit_reasons:read`, com o engine ABAC de
 * verdade LIGADO: o item de menu "Motivos de salida" NÃO aparece, a rota da tela redireciona para
 * `/admin` e o POST da API responde 403 (banco intacto). Controle positivo, mesma execução: o admin
 * COM as 3 células vê o item de menu e abre a tela.
 *
 * O CAMINHO casa `group-simulation` do job engine ON (`_frontend-integration.yml`, workflow intocado);
 * no job padrão (engine OFF) ele não entra — o menu nunca esconderia. Contas por `seedStaffInGroup`/
 * `grantCell`, `role: 'recruiter'`, `country: 'AR'` (mock-token sem `country` = 401/403 mudo);
 * `pollAuthz` confirma o contrato (`enforcement: 'on'` e a presença/ausência da célula) ANTES de abrir a
 * tela. Nenhum mock de `/v1/me/authz`. Prova de que o menu renderizou para o SEM: o link "Pacientes"
 * (célula `patient:read`, concedida aos dois) está visível — sem isso "não vê o item" seria vazio.
 */
import { test, expect } from '@playwright/test';
import {
  ABAC_API_URL, tokenFor, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, pollAuthz, scalar, type MockUser,
} from '../helpers/abac-stack-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const COM_UID = `qa.sim.motivos.com.${RUN_ID}`;
const SEM_UID = `qa.sim.motivos.sem.${RUN_ID}`;
const STAFF_COM: MockUser = { uid: COM_UID, email: `${COM_UID}@enlite.test`, role: 'recruiter', country: 'AR' };
const STAFF_SEM: MockUser = { uid: SEM_UID, email: `${SEM_UID}@enlite.test`, role: 'recruiter', country: 'AR' };

const RESOURCE = 'catalog_service_exit_reasons';
const CELL_READ = `${RESOURCE}:read`;
const ROTA = '/admin/catalogos/motivos-de-salida';
const TITULO = 'Motivos de salida';
const LABEL_TENTADO = `Sin celula ${RUN_ID}`;

interface AuthzBody { enforcement?: string; permissions?: string[] }
const temLeitura = (b: AuthzBody | null): boolean => Array.isArray(b?.permissions) && b.permissions.includes(CELL_READ);

test.describe('catalogo-motivos-sem-celula sob engine ligado @integration', () => {
  test.use({ viewport: { width: 1600, height: 1000 } });
  test.setTimeout(180_000);

  test('catalogo-motivos-sem-celula', async ({ page, request, browser }) => {
    let groupComId = '';
    let groupSemId = '';
    try {
      ({ groupId: groupComId } = seedStaffInGroup({ uid: COM_UID, email: STAFF_COM.email, groupName: `Motivos COM ${RUN_ID}`, country: 'AR' }));
      ({ groupId: groupSemId } = seedStaffInGroup({ uid: SEM_UID, email: STAFF_SEM.email, groupName: `Motivos SEM ${RUN_ID}`, country: 'AR' }));
      // Os dois abrem o painel (menu "Pacientes"); só o COM ganha o catálogo de motivos.
      for (const g of [groupComId, groupSemId]) grantCell(g, 'patient', 'read');
      for (const action of ['read', 'create', 'update']) grantCell(groupComId, RESOURCE, action);

      const com = await pollAuthz(request, STAFF_COM, (b: AuthzBody) => b?.enforcement === 'on' && temLeitura(b));
      const sem = await pollAuthz(request, STAFF_SEM, (b: AuthzBody) => b?.enforcement === 'on' && Array.isArray(b?.permissions));
      expect(com.body?.enforcement, 'COM: engine ligado').toBe('on');
      expect(temLeitura(com.body), `COM: tem ${CELL_READ}`).toBe(true);
      expect(sem.body?.enforcement, 'SEM: engine ligado').toBe('on');
      expect(temLeitura(sem.body), `SEM: sem ${CELL_READ}`).toBe(false);

      // ── SEM: o menu renderiza, sem o item; a rota redireciona; o POST é 403 ────────────────
      await loginAs(page, STAFF_SEM);
      const nav = page.getByRole('navigation').first();
      await expect(nav.getByRole('link', { name: 'Pacientes' }), 'controle: o menu do SEM renderizou').toBeVisible({ timeout: 30_000 });
      await expect(nav.getByRole('link', { name: TITULO })).toHaveCount(0);

      await page.goto(ROTA);
      await expect(page).toHaveURL(/\/admin\/?$/, { timeout: 30_000 });
      await expect(page.getByRole('heading', { level: 1, name: TITULO })).toHaveCount(0);
      await expect(page.getByTestId('therapeutic-catalog-table')).toHaveCount(0);

      const post = await request.post(`${ABAC_API_URL}/api/admin/therapeutic-catalogs/service-exit-reasons`, {
        headers: { Authorization: `Bearer ${tokenFor(STAFF_SEM)}`, 'Content-Type': 'application/json' },
        data: { label: LABEL_TENTADO },
        failOnStatusCode: false,
      });
      expect(post.status(), 'SEM: POST sem a célula').toBe(403);
      expect(scalar(`SELECT count(*) FROM service_exit_reasons WHERE label = '${LABEL_TENTADO}'`).trim(), 'banco intacto').toBe('0');

      // ── COM (controle positivo): mesma tela, contexto novo ────────────────────────────────
      const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
      try {
        const pageCom = await ctx.newPage();
        await loginAs(pageCom, STAFF_COM);
        const link = pageCom.getByRole('navigation').first().getByRole('link', { name: TITULO });
        await expect(link).toBeVisible({ timeout: 30_000 });
        await link.click();
        await expect(pageCom).toHaveURL(/\/admin\/catalogos\/motivos-de-salida$/);
        await expect(pageCom.getByRole('heading', { level: 1, name: TITULO })).toBeVisible({ timeout: 30_000 });
      } finally {
        await ctx.close();
      }
    } finally {
      cleanupStaffAndGroup(COM_UID, groupComId);
      cleanupStaffAndGroup(SEM_UID, groupSemId);
    }
  });
});
