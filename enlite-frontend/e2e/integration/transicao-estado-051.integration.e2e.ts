/**
 * transicao-estado-051.integration.e2e.ts @integration — spec 051 (troca manual de estado do paciente,
 * fora do fluxo, atrás de permissão por destino), F5.
 *
 * E2E DE TELA, sem mock de resposta: navegador + API + Postgres reais, engine ABAC LIGADO, staff REAL em grupo
 * (células por SQL), login e arrasto como uma pessoa faz, valor lido da TELA e do BANCO. Nenhum canal externo.
 *
 *  feliz       — conta com `patient:update` + `patient_status:move_to_searching`, paciente ACTIVE com serviço completo:
 *                a ficha oferece Búsqueda (ACTIVE→SEARCHING não está na FSM), a troca sai, a tela mostra o novo estado;
 *                banco: `status='SEARCHING'` e +1 linha no histórico `admin_panel_override` com `actor_uid`; o Historial
 *                mostra a origem traduzida ("fuera del flujo").
 *  sem célula  — conta só com `patient:update`: a opção Búsqueda NÃO existe no select (controle positivo: En espera existe);
 *                o PUT cru leva 403 `PATIENT_STATUS_MOVE_NOT_PERMITTED` com `details.cell`; banco inalterado.
 *  integridade — conta COM a célula, serviço ativo sem horário: Búsqueda aparece DESABILITADA com o motivo; o PUT cru leva
 *                422 `PATIENT_STATUS_NOT_READY` com o que falta; banco inalterado.
 *  Kanban      — com a célula: o card fica em Búsqueda e o histórico grava `kanban_override`; sem ela: o card volta, a
 *                frase amigável aparece, nenhum PUT sai e o banco fica inalterado.
 *
 * ⚠️ Precisa do engine ABAC LIGADO + sync do catálogo (as 7 células `patient_status:*` precisam existir em `iam.permissions`;
 * `grantCell` falha alto se não existirem). Por isso o nome entra no `--grep` do job `integration-e2e-group-simulation` do
 * `_frontend-integration.yml` e NÃO no `grep:` do `pr-gate.yml` (engine OFF: `cells===null` mostraria tudo e o "sem célula"
 * ficaria verde sem medir nada). Molde: `admissao-049-aba.integration.e2e.ts` e `pt-todavia-no-hay-048.integration.e2e.ts`.
 * Rodar local = o job do CI: `ABAC_API_URL`, `ABAC_TEST_DB_URL`, `E2E_PG_CONTAINER`, `E2E_BACKEND_URL`.
 * Dados SINTÉTICOS (paciente "E2E051").
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { insertTestPatient, cleanupTestPatient } from '../helpers/db-test-helper';
import { dndKitDrag } from '../helpers/dndKitDrag';
import {
  scalar, safeSql, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, tokenFor, ABAC_API_URL, ABAC_TENANT,
} from '../helpers/abac-stack-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const HORARIO = '[{"dayOfWeek":1,"startTime":"08:00","endTime":"12:00"}]';

const operadoraUid = `e2e-051-operadora-${RUN_ID}`;
const semCelulaUid = `e2e-051-sem-celula-${RUN_ID}`;
const operadora = { uid: operadoraUid, email: `${operadoraUid}@e2e.test`, role: 'admin', country: 'AR' };
const semCelula = { uid: semCelulaUid, email: `${semCelulaUid}@e2e.test`, role: 'admin', country: 'AR' };
const CELULAS_BASE: Array<[string, string]> = [['patient', 'read'], ['patient', 'update'], ['patient_identity', 'read']];

/** Paciente ACTIVE com 1 endereço e 1 serviço ativo; `horario` NULL = serviço sem horário (a integridade de Búsqueda). */
function seedPaciente(tag: string, horario: boolean): string {
  const { patientId, addressId } = insertTestPatient({
    status: 'ACTIVE', firstName: 'E2E051', lastName: `${tag}${RUN_ID}`.slice(0, 40),
    withAddress: true, hasConsent: true, insuranceInformed: 'OSDE',
  });
  if (!addressId) throw new Error('seedPaciente: insertTestPatient não devolveu addressId');
  scalar(`INSERT INTO patient_contracted_services (patient_id, service_code, active, country, created_by, updated_by, address_id, schedule)
          VALUES ('${patientId}', 'AT', true, 'AR', 'e2e051', 'e2e051', '${addressId}', ${horario ? `'${HORARIO}'::jsonb` : 'NULL'}) RETURNING id`);
  return patientId;
}

const statusDe = (id: string): string => scalar(`SELECT status FROM patients WHERE id = '${id}'`);
const linhasHistorico = (id: string): number => Number(scalar(`SELECT count(*) FROM patient_status_history WHERE patient_id = '${id}'`));
const ultimaLinha = (id: string): string =>
  scalar(`SELECT old_value || '|' || new_value || '|' || change_source || '|' || COALESCE(actor_uid, '<NULL>')
            FROM patient_status_history WHERE patient_id = '${id}' ORDER BY created_at DESC, id DESC LIMIT 1`);

async function abrirFicha(page: Page, patientId: string): Promise<Locator> {
  await page.goto(`/admin/patients/${patientId}`);
  const select = page.getByTestId('patient-status-select');
  await expect(select).toBeVisible({ timeout: 30_000 });
  // A lista vem do servidor: o select nasce travado e só habilita quando ela chega.
  await expect(select).toBeEnabled({ timeout: 20_000 });
  return select;
}

const opcao = (select: Locator, valor: string): Locator => select.locator(`option[value="${valor}"]`);

async function abrirKanban(page: Page, patientId: string): Promise<{ card: Locator; coluna: (s: string) => Locator }> {
  await page.goto('/admin/patients/kanban');
  await expect(page.getByTestId('patient-kanban-board')).toBeVisible({ timeout: 20_000 });
  const card = page.getByTestId(`patient-kanban-card-${patientId}`);
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.scrollIntoViewIfNeeded();
  return { card, coluna: (s) => page.getByTestId(`kanban-column-${s}`) };
}

test.use({ viewport: { width: 1600, height: 1000 }, video: 'on' });

test.describe('transicao-estado-051 — troca manual de estado com permissão por destino (spec 051) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  let operadoraGroupId = '';
  let semCelulaGroupId = '';

  test.beforeAll(() => {
    operadoraGroupId = seedStaffInGroup({ uid: operadoraUid, email: operadora.email, groupName: `Est051 Operadora ${RUN_ID}`, country: 'AR' }).groupId;
    for (const [r, a] of CELULAS_BASE) grantCell(operadoraGroupId, r, a);
    grantCell(operadoraGroupId, 'patient_status', 'move_to_searching'); // falha alto se o sync do catálogo não criou a célula
    semCelulaGroupId = seedStaffInGroup({ uid: semCelulaUid, email: semCelula.email, groupName: `Est051 SemCelula ${RUN_ID}`, country: 'AR' }).groupId;
    for (const [r, a] of CELULAS_BASE) grantCell(semCelulaGroupId, r, a);
  });

  test.afterAll(() => {
    cleanupStaffAndGroup(operadoraUid, operadoraGroupId);
    cleanupStaffAndGroup(semCelulaUid, semCelulaGroupId);
    safeSql(`DELETE FROM iam.permission_groups WHERE tenant_id = '${ABAC_TENANT}' AND name LIKE 'Est051 % ${RUN_ID}'`);
  });

  test('feliz: com patient_status:move_to_searching a ficha troca ACTIVE → Búsqueda; tela, banco e Historial concordam', async ({ page }) => {
    const patientId = seedPaciente('Feliz', true);
    try {
      await loginAs(page, operadora);
      const select = await abrirFicha(page, patientId);
      const antes = linhasHistorico(patientId);
      expect(statusDe(patientId)).toBe('ACTIVE');

      // A lista do servidor traz Búsqueda (fora da FSM, liberada pela célula) sem marca nem aviso, e traz a FSM (En espera).
      await expect(opcao(select, 'ON_HOLD')).toHaveCount(1);
      await expect(opcao(select, 'SEARCHING')).toHaveCount(1);
      await expect(opcao(select, 'SEARCHING')).toBeEnabled();
      await expect(opcao(select, 'SEARCHING')).toHaveText('Búsqueda');

      await select.selectOption('SEARCHING');
      await expect(select).toHaveValue('SEARCHING'); // lido da tela
      const save = page.getByTestId('patient-status-save');
      await expect(save).toBeEnabled();
      const put = page.waitForResponse((r) => r.request().method() === 'PUT' && /\/status$/.test(r.url()));
      await save.click();
      expect((await put).status()).toBe(200);
      await expect(page.getByTestId('patient-status-error')).toHaveCount(0);
      await expect(page.getByTestId('patient-status-badge')).toContainText(/squeda/i, { timeout: 20_000 });

      // banco: o estado mudou e há UMA linha nova, marcada como troca fora do fluxo, com o ator.
      await expect.poll(() => statusDe(patientId)).toBe('SEARCHING');
      expect(linhasHistorico(patientId)).toBe(antes + 1);
      expect(ultimaLinha(patientId)).toBe(`ACTIVE|SEARCHING|admin_panel_override|${operadoraUid}`);

      // Historial EM TELA: a origem traduzida deixa claro que foi fora do fluxo (nunca o valor cru do banco).
      await page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Historial' }).click();
      const card = page.getByTestId('patient-status-history-card');
      await expect(card).toBeVisible();
      await expect(card).toContainText('Panel (fuera del flujo)');
      await expect(card).toContainText(operadoraUid);
      expect(await card.textContent()).not.toContain('admin_panel_override');
    } finally {
      cleanupTestPatient(patientId);
    }
  });

  test('sem a permissão: só patient:update — Búsqueda NÃO aparece no select; o PUT cru leva 403 com a célula; banco inalterado', async ({ page, request }) => {
    const patientId = seedPaciente('SemCelula', true);
    try {
      await loginAs(page, semCelula);
      const select = await abrirFicha(page, patientId);
      // Controle positivo: o select TEM opções (a FSM) — a ausência de Búsqueda não é lista vazia nem tela quebrada.
      await expect(opcao(select, 'ON_HOLD')).toHaveCount(1);
      await expect(opcao(select, 'SEARCHING')).toHaveCount(0);
      const values = await select.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
      expect(values).not.toContain('SEARCHING');

      const antes = linhasHistorico(patientId);
      const direto = await request.put(`${ABAC_API_URL}/api/admin/patients/${patientId}/status`, {
        headers: { Authorization: `Bearer ${tokenFor(semCelula)}` },
        data: { status: 'SEARCHING', changeSource: 'admin_panel' },
        failOnStatusCode: false,
      });
      expect(direto.status()).toBe(403);
      const corpo = await direto.json();
      expect(corpo).toMatchObject({ code: 'PATIENT_STATUS_MOVE_NOT_PERMITTED', details: { from: 'ACTIVE', to: 'SEARCHING', cell: 'patient_status:move_to_searching' } });

      expect(statusDe(patientId), 'banco inalterado').toBe('ACTIVE');
      expect(linhasHistorico(patientId), 'histórico inalterado').toBe(antes);
    } finally {
      cleanupTestPatient(patientId);
    }
  });

  test('integridade: com a célula, serviço ativo SEM horário — Búsqueda aparece desabilitada com o motivo; o PUT cru leva 422; banco inalterado', async ({ page, request }) => {
    const patientId = seedPaciente('SemHorario', false);
    try {
      await loginAs(page, operadora);
      const select = await abrirFicha(page, patientId);
      const busqueda = opcao(select, 'SEARCHING');
      await expect(busqueda).toHaveCount(1); // a célula a libera...
      await expect(busqueda).toBeDisabled(); // ...mas a integridade a trava, em vez de falhar no clique
      await expect(busqueda).toHaveText(/Búsqueda \(falta: .*horario del servicio/);
      await expect(opcao(select, 'ON_HOLD')).toBeEnabled(); // controle positivo: o bloqueio é só deste destino

      const antes = linhasHistorico(patientId);
      const direto = await request.put(`${ABAC_API_URL}/api/admin/patients/${patientId}/status`, {
        headers: { Authorization: `Bearer ${tokenFor(operadora)}` },
        data: { status: 'SEARCHING', changeSource: 'admin_panel' },
        failOnStatusCode: false,
      });
      expect(direto.status()).toBe(422);
      const corpo = await direto.json();
      expect(corpo.code).toBe('PATIENT_STATUS_NOT_READY');
      expect(corpo.details.missing).toContain('SERVICE_SCHEDULE');

      expect(statusDe(patientId), 'banco inalterado').toBe('ACTIVE');
      expect(linhasHistorico(patientId), 'histórico inalterado').toBe(antes);
    } finally {
      cleanupTestPatient(patientId);
    }
  });

  test('Kanban com a célula: arrastar ACTIVE → Búsqueda fica no lugar e o histórico grava kanban_override', async ({ page }) => {
    const patientId = seedPaciente('KanbanCom', true);
    try {
      await loginAs(page, operadora);
      const { card, coluna } = await abrirKanban(page, patientId);
      const antes = linhasHistorico(patientId);

      const put = page.waitForResponse((r) => r.request().method() === 'PUT' && /\/status$/.test(r.url()));
      await dndKitDrag(page, card, coluna('SEARCHING'));
      expect((await put).status()).toBe(200);

      await expect(coluna('SEARCHING').getByTestId(`patient-kanban-card-${patientId}`)).toHaveCount(1, { timeout: 15_000 });
      await expect(coluna('ACTIVE').getByTestId(`patient-kanban-card-${patientId}`)).toHaveCount(0);
      await expect.poll(() => statusDe(patientId)).toBe('SEARCHING');
      expect(linhasHistorico(patientId)).toBe(antes + 1);
      expect(ultimaLinha(patientId)).toBe(`ACTIVE|SEARCHING|kanban_override|${operadoraUid}`);
    } finally {
      cleanupTestPatient(patientId);
    }
  });

  test('Kanban sem a célula: o card volta, a frase amigável aparece, nenhum PUT sai e o banco fica inalterado', async ({ page }) => {
    const patientId = seedPaciente('KanbanSem', true);
    try {
      let putSaiu = false;
      page.on('request', (r) => { if (r.method() === 'PUT' && /\/status$/.test(r.url())) putSaiu = true; });
      await loginAs(page, semCelula);
      const { card, coluna } = await abrirKanban(page, patientId);
      const antes = linhasHistorico(patientId);

      // A lista do servidor é lida no drop: a tela só segue se o destino está nela.
      const lista = page.waitForResponse((r) => r.request().method() === 'GET' && new RegExp(`/patients/${patientId}/status-options\\?changeSource=kanban$`).test(r.url()));
      await dndKitDrag(page, card, coluna('SEARCHING'));
      expect((await lista).status()).toBe(200);

      await expect(page.getByText('Este cambio de estado no está disponible.')).toBeVisible({ timeout: 8_000 });
      await expect(coluna('ACTIVE').getByTestId(`patient-kanban-card-${patientId}`)).toHaveCount(1); // o card voltou (nunca saiu)
      await expect(coluna('SEARCHING').getByTestId(`patient-kanban-card-${patientId}`)).toHaveCount(0);
      expect(putSaiu, 'a tela recusa antes do PUT').toBe(false);
      expect(statusDe(patientId), 'banco inalterado').toBe('ACTIVE');
      expect(linhasHistorico(patientId), 'histórico inalterado').toBe(antes);
    } finally {
      cleanupTestPatient(patientId);
    }
  });
});
