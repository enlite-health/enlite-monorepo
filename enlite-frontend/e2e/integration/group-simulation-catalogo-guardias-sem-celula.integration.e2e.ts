/**
 * group-simulation-catalogo-guardias-sem-celula.integration.e2e.ts @integration — spec 074. Sem a célula
 * `catalog_service_shift_templates`, com o engine ABAC de verdade LIGADO: o item de menu "Guardias" NÃO aparece, a rota
 * redireciona para `/admin/dashboard`, POST e PATCH diretos respondem 403 (banco intacto) — e, MESMO assim, quem carrega
 * um serviço (`patient_services:read`) continua vendo as guardias na escolha do editor (`GET …/options`).
 *
 * O CAMINHO casa `group-simulation` do job engine ON (`_frontend-integration.yml`, workflow intocado). Contas por
 * `seedStaffInGroup`/`grantCell`, `role: 'recruiter'`, `country: 'AR'`; `pollAuthz` confirma o contrato (`enforcement: 'on'`
 * e a presença/ausência da célula) ANTES de abrir a tela. Nenhum mock de `/v1/me/authz`. Controles positivos na mesma
 * execução: o link "Pacientes" visível para o SEM (o menu renderizou) e o COM vendo o link, abrindo a tela e lendo a lista (200).
 *
 * Semente do paciente/serviço por SQL (sob engine ligado o token `role: 'admin'` sem grupo dá 403 — molde
 * `group-simulation-itinerario-celula`). Sem a célula nova, o SEM tem `patient`, `patient_identity` e `patient_services`
 * (read + update — o lápis do serviço pede o `update`); o COM ganha ainda as 3 células do catálogo.
 */
import { test, expect } from '@playwright/test';
import {
  ABAC_API_URL, tokenFor, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, pollAuthz, scalar, type MockUser,
} from '../helpers/abac-stack-helper';
import { insertTestPatient } from '../helpers/db-test-helper';
import { runSQL, cleanupPatientDeep } from '../helpers/patient-detail-a-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const COM_UID = `qa.sim.guardias.com.${RUN_ID}`;
const SEM_UID = `qa.sim.guardias.sem.${RUN_ID}`;
const STAFF_COM: MockUser = { uid: COM_UID, email: `${COM_UID}@enlite.test`, role: 'recruiter', country: 'AR' };
const STAFF_SEM: MockUser = { uid: SEM_UID, email: `${SEM_UID}@enlite.test`, role: 'recruiter', country: 'AR' };

const RESOURCE = 'catalog_service_shift_templates';
const CELL_READ = `${RESOURCE}:read`;
const ROTA = '/admin/catalogos/guardias';
const TITULO = 'Guardias predefinidas';
const MENU = 'Guardias';
const LABEL_TENTADO = `QA 074 Sin celula ${RUN_ID}`;
const LABEL_PATCH = `QA 074 Patch sin celula ${RUN_ID}`;
const API = '/api/admin/therapeutic-catalogs/service-shift-templates';

interface AuthzBody { enforcement?: string; permissions?: string[] }
const temLeitura = (b: AuthzBody | null): boolean => Array.isArray(b?.permissions) && b.permissions.includes(CELL_READ);
const headers = (u: MockUser): Record<string, string> => ({ Authorization: `Bearer ${tokenFor(u)}`, 'Content-Type': 'application/json' });

test.describe('catalogo-guardias-sem-celula sob engine ligado @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: { width: 1600, height: 1000 } });
  test.setTimeout(180_000);

  let groupComId = '';
  let groupSemId = '';

  test.beforeAll(async ({ request }) => {
    ({ groupId: groupComId } = seedStaffInGroup({ uid: COM_UID, email: STAFF_COM.email, groupName: `Guardias COM ${RUN_ID}`, country: 'AR' }));
    ({ groupId: groupSemId } = seedStaffInGroup({ uid: SEM_UID, email: STAFF_SEM.email, groupName: `Guardias SEM ${RUN_ID}`, country: 'AR' }));
    // Os dois abrem o painel (menu "Pacientes") e a ficha do paciente; o SEM também edita o serviço (lápis), sem a célula nova.
    for (const g of [groupComId, groupSemId]) {
      grantCell(g, 'patient', 'read');
      grantCell(g, 'patient_identity', 'read');
      grantCell(g, 'patient_services', 'read');
      grantCell(g, 'patient_services', 'update');
    }
    for (const action of ['read', 'create', 'update']) grantCell(groupComId, RESOURCE, action);

    const com = await pollAuthz(request, STAFF_COM, (b: AuthzBody) => b?.enforcement === 'on' && temLeitura(b));
    const sem = await pollAuthz(request, STAFF_SEM, (b: AuthzBody) => b?.enforcement === 'on' && Array.isArray(b?.permissions));
    expect(com.body?.enforcement, 'COM: engine ligado').toBe('on');
    expect(temLeitura(com.body), `COM: tem ${CELL_READ}`).toBe(true);
    expect(sem.body?.enforcement, 'SEM: engine ligado').toBe('on');
    expect(temLeitura(sem.body), `SEM: sem ${CELL_READ}`).toBe(false);
    expect(sem.body?.permissions, 'SEM: tem patient_services:read').toContain('patient_services:read');
  });

  test.afterAll(() => {
    try { cleanupStaffAndGroup(COM_UID, groupComId); } catch (err) { console.error('[cleanup] staff COM falhou (seguindo)', err); }
    try { cleanupStaffAndGroup(SEM_UID, groupSemId); } catch (err) { console.error('[cleanup] staff SEM falhou (seguindo)', err); }
  });

  test('sem célula não vê Guardias no menu e a rota volta a /admin', async ({ page, browser }) => {
    // ── SEM: o menu renderiza, sem o item; a rota redireciona ────────────────────────────
    await loginAs(page, STAFF_SEM);
    const nav = page.getByRole('navigation').first();
    await expect(nav.getByRole('link', { name: 'Pacientes' }), 'controle: o menu do SEM renderizou').toBeVisible({ timeout: 30_000 });
    await expect(nav.getByRole('link', { name: MENU, exact: true })).toHaveCount(0);

    await page.goto(ROTA);
    await expect(page).toHaveURL(/\/admin\/dashboard$/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { level: 1, name: TITULO })).toHaveCount(0);
    await expect(page.getByTestId('therapeutic-catalog-table')).toHaveCount(0);

    // ── COM (controle positivo): mesma tela, contexto novo ────────────────────────────────
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    try {
      const pageCom = await ctx.newPage();
      await loginAs(pageCom, STAFF_COM);
      const link = pageCom.getByRole('navigation').first().getByRole('link', { name: MENU, exact: true });
      await expect(link).toBeVisible({ timeout: 30_000 });
      await link.click();
      await expect(pageCom).toHaveURL(/\/admin\/catalogos\/guardias$/);
      await expect(pageCom.getByRole('heading', { level: 1, name: TITULO })).toBeVisible({ timeout: 30_000 });
      await expect(pageCom.getByTestId('therapeutic-catalog-table')).toBeVisible();
    } finally {
      await ctx.close();
    }
  });

  test('POST e PATCH diretos respondem 403 e nenhuma linha nova', async ({ request }) => {
    const idSemente = scalar(`SELECT id FROM service_shift_templates WHERE code = 'GUARDIA_24H'`).trim();
    expect(idSemente, 'a semente GUARDIA_24H existe').toMatch(/^[0-9a-f-]{36}$/);
    const rotuloAntes = scalar(`SELECT label FROM service_shift_templates WHERE id = '${idSemente}'`).trim();
    const totalAntes = scalar(`SELECT count(*) FROM service_shift_templates`).trim();

    // Controle positivo: o COM lê a lista (200) — a rota existe e o 403 do SEM é da célula, não de outra coisa.
    const comLista = await request.get(`${ABAC_API_URL}${API}`, { headers: headers(STAFF_COM), failOnStatusCode: false });
    expect(comLista.status(), 'COM: GET da lista com a célula').toBe(200);
    // O SEM nem lista o catálogo de gestão (a leitura dele é só pelas `options`).
    const semLista = await request.get(`${ABAC_API_URL}${API}`, { headers: headers(STAFF_SEM), failOnStatusCode: false });
    expect(semLista.status(), 'SEM: GET da lista sem a célula').toBe(403);

    const post = await request.post(`${ABAC_API_URL}${API}`, {
      headers: headers(STAFF_SEM),
      data: { label: LABEL_TENTADO, items: [{ startTime: '09:00', durationMinutes: 60 }] },
      failOnStatusCode: false,
    });
    expect(post.status(), 'SEM: POST sem a célula').toBe(403);
    const patch = await request.patch(`${ABAC_API_URL}${API}/${idSemente}`, {
      headers: headers(STAFF_SEM),
      data: { label: LABEL_PATCH },
      failOnStatusCode: false,
    });
    expect(patch.status(), 'SEM: PATCH sem a célula').toBe(403);

    expect(scalar(`SELECT count(*) FROM service_shift_templates WHERE label IN ('${LABEL_TENTADO}', '${LABEL_PATCH}')`).trim(), 'banco intacto: nenhum rótulo tentado').toBe('0');
    expect(scalar(`SELECT label FROM service_shift_templates WHERE id = '${idSemente}'`).trim(), 'o rótulo da semente segue o mesmo').toBe(rotuloAntes);
    expect(scalar(`SELECT count(*) FROM service_shift_templates`).trim(), 'nenhuma linha nova').toBe(totalAntes);
  });

  test('sem célula continua vendo as guardias na escolha do editor do serviço', async ({ page, request }) => {
    const rotuloSemente = scalar(`SELECT label FROM service_shift_templates WHERE code = 'GUARDIAS_8_14_20'`).trim();
    const rotulo24h = scalar(`SELECT label FROM service_shift_templates WHERE code = 'GUARDIA_24H'`).trim();
    expect(rotuloSemente.length, 'a semente GUARDIAS_8_14_20 existe').toBeGreaterThan(0);
    expect(rotulo24h.length, 'a semente GUARDIA_24H existe').toBeGreaterThan(0);

    // ── API: `options` está sob `patient_services:read`, não sob a célula do catálogo ───────
    const opcoes = await request.get(`${ABAC_API_URL}${API}/options`, { headers: headers(STAFF_SEM), failOnStatusCode: false });
    expect(opcoes.status(), 'SEM: GET options com patient_services:read').toBe(200);
    const items = ((await opcoes.json()) as { data: { items: Array<{ label: string; items: unknown[] }> } }).data.items;
    const rotulos = items.map((i) => i.label);
    expect(rotulos, 'as 2 sementes vêm nas opções do SEM').toEqual(expect.arrayContaining([rotuloSemente, rotulo24h]));
    expect(items.find((i) => i.label === rotuloSemente)?.items, 'a semente traz os 3 turnos').toHaveLength(3);

    // ── TELA: o editor do serviço mostra as sementes no select de guardia ───────────────────
    const { patientId, addressId } = insertTestPatient({
      withAddress: true, insuranceInformed: 'OSDE', firstName: 'GuardiasSemCelula', lastName: `Seed-${RUN_ID}`,
    });
    try {
      const saida = runSQL(
        `INSERT INTO patient_contracted_services (patient_id, address_id, service_code, active, country, created_by, updated_by) ` +
          `VALUES ('${patientId}', '${addressId}', 'AT', true, 'AR', 'e2e-guardias-sem-celula', 'e2e-guardias-sem-celula') RETURNING id`,
      );
      const serviceId = saida.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
      if (!serviceId) throw new Error('catalogo-guardias-sem-celula: serviço não criado');

      await loginAs(page, STAFF_SEM);
      await page.goto(`/admin/patients/${patientId}`);
      await page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Servicio Contratado' }).click();
      await page.getByTestId(`contracted-service-edit-${serviceId}`).click();
      await expect(page.getByRole('dialog', { name: 'Editar servicio contratado' })).toBeVisible();

      await page.getByTestId('svc-shift-template-select-1').click();
      const lista = page.getByRole('listbox');
      await expect(lista.getByRole('option', { name: rotuloSemente, exact: true })).toBeVisible();
      await expect(lista.getByRole('option', { name: rotulo24h, exact: true })).toBeVisible();
    } finally {
      cleanupPatientDeep(patientId);
    }
  });
});
