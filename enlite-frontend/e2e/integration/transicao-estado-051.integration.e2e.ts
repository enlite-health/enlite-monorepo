/**
 * transicao-estado-051.integration.e2e.ts @integration — spec 051 (troca manual de estado do paciente, fora do fluxo, atrás de permissão por
 * destino), reescrito na F5 de estado-automatico-do-paciente: a troca livre dos estados DERIVADOS (Búsqueda, Reemplazo, Activo) e o arrasto
 * saíram; ficam as ações dos estados HUMANOS, que podem sair do fluxo da FSM atrás da célula do destino (`move_to_on_hold|suspended|alta|discharged`).
 *
 * E2E DE TELA, sem mock de resposta: navegador + API + Postgres reais, engine ABAC LIGADO, staff REAL em grupo (células por SQL), login como uma
 * pessoa faz (click + `keyboard.type`), valor lido da TELA e do BANCO. Nenhum canal externo. Dados SINTÉTICOS (paciente "E2E051", sobrenome " QA").
 *
 *  feliz       — conta com `patient:update` + `patient_status:move_to_suspended`, paciente ON_HOLD: ON_HOLD → SUSPENDED não está na FSM, então a
 *                ficha oferece a ação "Suspender" (via permissão); o clique a aplica; banco: `status='SUSPENDED'` e +1 linha no histórico
 *                `admin_panel_override` com `actor_uid`; o Historial mostra a origem traduzida ("fuera del flujo").
 *  sem célula  — conta só com `patient:update`: a ação "Suspender" NÃO existe na ficha (controle positivo: "Retomar" existe); o PUT cru leva 403
 *                `PATIENT_STATUS_MOVE_NOT_PERMITTED` com `details.cell`; banco inalterado.
 *  derivados   — a conta COM a célula também não escolhe estado derivado: PUT cru de Búsqueda/Reemplazo/Activo (origem `admin_panel`) e de qualquer
 *                destino pela origem `kanban` → 422 `PATIENT_STATUS_NOT_MANUAL`; banco e histórico inalterados.
 *  integridade — paciente DISCHARGED com serviço ativo SEM horário: a ação "Reactivar" (re-deriva para Búsqueda) aparece DESABILITADA com o motivo.
 *  Kanban      — o card não é arrastável e arrastar para outra coluna não manda PUT nem muda o banco.
 *
 * ⚠️ Precisa do engine ABAC LIGADO + sync do catálogo (as 4 células `patient_status:*` precisam existir em `iam.permissions`; `grantCell` falha alto
 * se não existirem). Por isso o nome entra no `--grep` do job `integration-e2e-group-simulation` do `_frontend-integration.yml` e NÃO no `grep:` do
 * `pr-gate.yml` (engine OFF: `cells===null` mostraria tudo e o "sem célula" ficaria verde sem medir nada). Molde: `admissao-049-aba.integration.e2e.ts`.
 * Rodar local = o job do CI: `ABAC_API_URL`, `ABAC_TEST_DB_URL`, `E2E_PG_CONTAINER`, `E2E_BACKEND_URL`.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { insertTestPatient, cleanupTestPatient } from '../helpers/db-test-helper';
import { dndKitDrag } from '../helpers/dndKitDrag';
import {
  scalar, safeSql, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, tokenFor, ABAC_API_URL, ABAC_TENANT,
} from '../helpers/abac-stack-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

const operadoraUid = `e2e-051-operadora-${RUN_ID}`;
const semCelulaUid = `e2e-051-sem-celula-${RUN_ID}`;
const operadora = { uid: operadoraUid, email: `${operadoraUid}@e2e.test`, role: 'admin', country: 'AR' };
const semCelula = { uid: semCelulaUid, email: `${semCelulaUid}@e2e.test`, role: 'admin', country: 'AR' };
const CELULAS_BASE: Array<[string, string]> = [['patient', 'read'], ['patient', 'update'], ['patient_identity', 'read']];

/** Paciente no `status` pedido, com 1 endereço e 1 serviço ativo; `horario` NULL = serviço sem horário (a integridade de Reactivar). */
function seedPaciente(tag: string, status: string, horario: boolean): string {
  const { patientId, addressId } = insertTestPatient({
    status, firstName: 'E2E051', lastName: `${tag}${RUN_ID} QA`.slice(0, 40),
    withAddress: true, hasConsent: true, insuranceInformed: 'OSDE',
  });
  if (!addressId) throw new Error('seedPaciente: insertTestPatient não devolveu addressId');
  const serviceId = scalar(`INSERT INTO patient_contracted_services (patient_id, service_code, active, country, created_by, updated_by, address_id, schedule)
          VALUES ('${patientId}', 'AT', true, 'AR', 'e2e051', 'e2e051', '${addressId}', NULL) RETURNING id`).split('\n')[0].trim();
  if (horario) {
    // Horário do serviço = 1 faixa vigente em `patient_itinerary_slot` (spec 056: `pcs.schedule` não é lido).
    safeSql(`INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, duration_minutes, valid, created_by, updated_by)
             VALUES ('${serviceId}', 1, '08:00', 240, '[2026-01-01,)'::daterange, 'e2e051', 'e2e051')`);
  }
  return patientId;
}

const statusDe = (id: string): string => scalar(`SELECT status FROM patients WHERE id = '${id}'`);
const linhasHistorico = (id: string): number => Number(scalar(`SELECT count(*) FROM patient_status_history WHERE patient_id = '${id}'`));
const ultimaLinha = (id: string): string =>
  scalar(`SELECT old_value || '|' || new_value || '|' || change_source || '|' || COALESCE(actor_uid, '<NULL>')
            FROM patient_status_history WHERE patient_id = '${id}' ORDER BY created_at DESC, id DESC LIMIT 1`);

/** Abre a ficha e espera a lista de AÇÕES do servidor (o select livre não existe mais). */
async function abrirFicha(page: Page, patientId: string): Promise<Locator> {
  await page.goto(`/admin/patients/${patientId}`);
  await expect(page.getByTestId('patient-status-control')).toBeVisible({ timeout: 30_000 });
  const acoes = page.getByTestId('patient-status-actions');
  await expect(acoes).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('patient-status-select')).toHaveCount(0);
  return acoes;
}

const put = (request: import('@playwright/test').APIRequestContext, patientId: string, user: typeof operadora, data: Record<string, unknown>) =>
  request.put(`${ABAC_API_URL}/api/admin/patients/${patientId}/status`, {
    headers: { Authorization: `Bearer ${tokenFor(user)}` }, data, failOnStatusCode: false,
  });

test.use({ viewport: { width: 1600, height: 1000 }, video: 'on' });

test.describe('transicao-estado-051 — ações de estado humano com permissão por destino (spec 051 + F5) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  let operadoraGroupId = '';
  let semCelulaGroupId = '';

  test.beforeAll(() => {
    operadoraGroupId = seedStaffInGroup({ uid: operadoraUid, email: operadora.email, groupName: `Est051 Operadora ${RUN_ID}`, country: 'AR' }).groupId;
    for (const [r, a] of CELULAS_BASE) grantCell(operadoraGroupId, r, a);
    grantCell(operadoraGroupId, 'patient_status', 'move_to_suspended'); // falha alto se o sync do catálogo não criou a célula
    semCelulaGroupId = seedStaffInGroup({ uid: semCelulaUid, email: semCelula.email, groupName: `Est051 SemCelula ${RUN_ID}`, country: 'AR' }).groupId;
    for (const [r, a] of CELULAS_BASE) grantCell(semCelulaGroupId, r, a);
  });

  test.afterAll(() => {
    cleanupStaffAndGroup(operadoraUid, operadoraGroupId);
    cleanupStaffAndGroup(semCelulaUid, semCelulaGroupId);
    safeSql(`DELETE FROM iam.permission_groups WHERE tenant_id = '${ABAC_TENANT}' AND name LIKE 'Est051 % ${RUN_ID}'`);
  });

  test('feliz: com patient_status:move_to_suspended a ficha oferece "Suspender" (ON_HOLD → Suspendido, fora da FSM); tela, banco e Historial concordam', async ({ page }) => {
    const patientId = seedPaciente('Feliz', 'ON_HOLD', true);
    try {
      await loginAs(page, operadora);
      await abrirFicha(page, patientId);
      const antes = linhasHistorico(patientId);
      expect(statusDe(patientId)).toBe('ON_HOLD');

      // A lista do servidor traz a ação liberada pela célula e a da FSM (Retomar).
      await expect(page.getByTestId('patient-status-action-retomar')).toBeVisible();
      const suspender = page.getByTestId('patient-status-action-suspender');
      await expect(suspender).toBeVisible();
      await expect(suspender).toBeEnabled();

      await suspender.click();
      await expect(page.getByTestId('patient-status-action-error')).toHaveCount(0);
      await expect(page.getByTestId('patient-status-badge')).toContainText('Suspendido', { timeout: 20_000 }); // lido da TELA

      // banco: o estado mudou e há UMA linha nova, marcada como troca fora do fluxo, com o ator.
      await expect.poll(() => statusDe(patientId)).toBe('SUSPENDED');
      expect(linhasHistorico(patientId)).toBe(antes + 1);
      expect(ultimaLinha(patientId)).toBe(`ON_HOLD|SUSPENDED|admin_panel_override|${operadoraUid}`);

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

  test('sem a permissão: só patient:update — "Suspender" NÃO aparece; o PUT cru leva 403 com a célula; banco inalterado', async ({ page, request }) => {
    const patientId = seedPaciente('SemCelula', 'ON_HOLD', true);
    try {
      await loginAs(page, semCelula);
      await abrirFicha(page, patientId);
      // Controle positivo: a lista TEM ações (a FSM) — a ausência de "Suspender" não é lista vazia nem tela quebrada.
      await expect(page.getByTestId('patient-status-action-retomar')).toBeVisible();
      await expect(page.getByTestId('patient-status-action-suspender')).toHaveCount(0);

      const antes = linhasHistorico(patientId);
      const direto = await put(request, patientId, semCelula, { status: 'SUSPENDED', changeSource: 'admin_panel' });
      expect(direto.status()).toBe(403);
      expect(await direto.json()).toMatchObject({ code: 'PATIENT_STATUS_MOVE_NOT_PERMITTED', details: { from: 'ON_HOLD', to: 'SUSPENDED', cell: 'patient_status:move_to_suspended' } });

      expect(statusDe(patientId), 'banco inalterado').toBe('ON_HOLD');
      expect(linhasHistorico(patientId), 'histórico inalterado').toBe(antes);
    } finally {
      cleanupTestPatient(patientId);
    }
  });

  test('derivados: nem a conta COM célula escolhe Búsqueda, Reemplazo ou Activo — PUT cru 422 PATIENT_STATUS_NOT_MANUAL; a origem kanban é recusada para qualquer destino', async ({ request }) => {
    const patientId = seedPaciente('Derivados', 'ON_HOLD', true);
    try {
      const antes = linhasHistorico(patientId);
      for (const [status, changeSource] of [['SEARCHING', 'admin_panel'], ['REPLACEMENT', 'admin_panel'], ['ACTIVE', 'admin_panel'], ['SUSPENDED', 'kanban'], ['SEARCHING', 'kanban']]) {
        const r = await put(request, patientId, operadora, { status, changeSource });
        expect(r.status(), `${changeSource} → ${status}`).toBe(422);
        expect((await r.json()).code).toBe('PATIENT_STATUS_NOT_MANUAL');
      }
      expect(statusDe(patientId), 'banco inalterado').toBe('ON_HOLD');
      expect(linhasHistorico(patientId), 'histórico inalterado').toBe(antes);
    } finally {
      cleanupTestPatient(patientId);
    }
  });

  test('integridade: DISCHARGED com serviço ativo SEM horário — "Reactivar" (re-deriva para Búsqueda) aparece desabilitada com o motivo; banco inalterado', async ({ page }) => {
    const patientId = seedPaciente('SemHorario', 'DISCHARGED', false);
    try {
      await loginAs(page, operadora);
      await abrirFicha(page, patientId);
      const reativar = page.getByTestId('patient-status-action-reativar');
      await expect(reativar).toBeVisible();
      await expect(reativar).toBeDisabled(); // a integridade a trava, em vez de falhar no clique
      await expect(reativar).toHaveAttribute('title', /horario del servicio/);
      expect(statusDe(patientId), 'banco inalterado').toBe('DISCHARGED');
    } finally {
      cleanupTestPatient(patientId);
    }
  });

  test('Kanban: o card não é arrastável; arrastar para outra coluna não manda PUT e o banco fica inalterado', async ({ page }) => {
    const patientId = seedPaciente('Kanban', 'ON_HOLD', true);
    try {
      const escritas: string[] = [];
      page.on('request', (r) => { if (['PUT', 'POST', 'PATCH', 'DELETE'].includes(r.method()) && /\/api\/admin\/patients\//.test(r.url())) escritas.push(r.method()); });
      await loginAs(page, operadora);
      await page.goto('/admin/patients/kanban');
      await expect(page.getByTestId('patient-kanban-board')).toBeVisible({ timeout: 20_000 });
      const card = page.getByTestId(`patient-kanban-card-${patientId}`);
      await expect(card).toBeVisible({ timeout: 20_000 });
      await card.scrollIntoViewIfNeeded();
      await expect(page.getByTestId(`kanban-card-${patientId}`)).not.toHaveAttribute('aria-roledescription', /.+/);
      const antes = linhasHistorico(patientId);

      await dndKitDrag(page, card, page.getByTestId('kanban-column-SUSPENDED'));

      expect(escritas, 'nenhuma escrita sai do gesto').toEqual([]);
      await expect(page.getByTestId('kanban-column-ON_HOLD').getByTestId(`patient-kanban-card-${patientId}`)).toHaveCount(1);
      expect(statusDe(patientId), 'banco inalterado').toBe('ON_HOLD');
      expect(linhasHistorico(patientId), 'histórico inalterado').toBe(antes);
    } finally {
      cleanupTestPatient(patientId);
    }
  });
});
