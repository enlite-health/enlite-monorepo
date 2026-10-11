/**
 * admissao-050-evento-pendente.integration.e2e.ts @integration — spec 050 F10 (T-103), selo "Cancelada, evento de Google pendiente"
 * na aba Admisión.
 *
 * E2E DE TELA, sem mock de resposta: frontend + API + Postgres reais, engine ABAC LIGADO, staff REAL em grupo (células por SQL),
 * login de humano (`loginAs`) e texto lido da tela. "Pendente" é o que a API deriva da TRILHA (`admission_events`, só-acréscimo):
 * reunião `cancelled` + `calendar_event_id` + `cancel_calendar_failed` SEM `cancel_calendar_deleted` — a semeadura grava exatamente
 * isso; a lista, o campo `calendarEventPending` e o selo são REAIS. Nenhum canal real: a API roda com `ADMISSION_EXTERNALS=fake`.
 *
 *  feliz  — reunião cancelada com o evento do Google pendente mostra o selo `admission-calendar-pending-<id>` com o texto
 *           "Cancelada, evento de Google pendiente", ao lado do status "Cancelada"; o campo da API diz `true`.
 *  alt 1  — reunião cancelada cujo apagar tardio JÁ rodou (`cancel_calendar_failed` + `cancel_calendar_deleted`): a linha está na
 *           lista como "Cancelada" e o selo NÃO existe (controle: a pendente da mesma tela mostra o selo).
 *  alt 2  — reunião AGENDADA (mesmo com `calendar_event_id` e uma falha antiga na trilha) NÃO mostra o selo: só `cancelled` conta.
 *
 * ⚠️ Mesma stack do `admissao-049-aba` (engine ABAC ligado + `ADMISSION_EXTERNALS=fake`): o nome entra no `--grep` do job
 * `integration-e2e-group-simulation` do `_frontend-integration.yml` pelo token `admissao-050`. Dados SINTÉTICOS.
 */
import { test, expect, type Page } from '@playwright/test';
import { seedActivatablePatient, cleanupPatientDeep } from '../helpers/patient-detail-c-helper';
import {
  psql, scalar, safeSql, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, tokenFor, ABAC_API_URL, ABAC_TENANT,
} from '../helpers/abac-stack-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const HOST = `ana.e2e050p-${RUN_ID}@example.test`;
const CODE_BASE = RUN_ID.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(-5);
const SELO = 'Cancelada, evento de Google pendiente';

/** Reunião sintética. `cancelada` = status `cancelled`; senão `booked` no futuro. Sempre com `calendar_event_id` (o selo depende dele). */
function semearReuniao(patientId: string, n: number, cancelada: boolean): string {
  const slot = cancelada
    ? `now() - interval '${n + 1} days', now() - interval '${n + 1} days' + interval '1 hour'`
    : `now() + interval '${n + 30} days', now() + interval '${n + 30} days' + interval '1 hour'`;
  const id = scalar(
    `INSERT INTO admission_appointments
       (patient_id, country, host_email, host_display_name, slot_start, slot_end, status, calendar_event_id, admission_code, created_at)
     VALUES ('${patientId}', 'AR', '${HOST}', 'Ana E2E050P', ${slot}, '${cancelada ? 'cancelled' : 'booked'}',
             'evt-e2e050-${RUN_ID}-${n}', 'ADM-${CODE_BASE}${n}', now() - interval '10 days')
     RETURNING id`,
  );
  return id.split('\n')[0].trim();
}

function trilha(apptId: string, kind: string, outcome: string, minutosAtras: number): void {
  psql(`INSERT INTO admission_events (appointment_id, kind, outcome, at)
        VALUES ('${apptId}', '${kind}', '${outcome}', now() - interval '${minutosAtras} minutes')`);
}

async function abrirAba(page: Page, patientId: string): Promise<void> {
  await page.goto(`/admin/patients/${patientId}`);
  await expect(page.getByTestId('patient-profile-tabs')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Admisión', exact: true }).click();
  await expect(page.getByTestId('admission-tab')).toBeVisible({ timeout: 15_000 });
}

test.use({ viewport: { width: 1600, height: 1100 }, video: 'on' });

test.describe('admissao-050 — aba Admisión: selo "Cancelada, evento de Google pendiente" (spec 050 F10) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  let seed: { patientId: string; addressId: string; stamp: string };
  let groupId = '';
  const uid = `e2e-050p-leitora-${RUN_ID}`;
  const leitora = { uid, email: `${uid}@e2e.test`, role: 'admin', country: 'AR' };

  test.beforeAll(() => {
    seed = seedActivatablePatient(751000);
    groupId = seedStaffInGroup({ uid, email: leitora.email, groupName: `Adm050P Leitora ${RUN_ID}`, country: 'AR' }).groupId;
    for (const [r, a] of [['patient', 'read'], ['patient_identity', 'read'], ['patient_admission', 'read']]) grantCell(groupId, r, a);
  });

  test.afterAll(() => {
    safeSql(`DELETE FROM admission_appointments WHERE patient_id = '${seed.patientId}'`);
    safeSql(`DELETE FROM patients WHERE id = '${seed.patientId}'`);
    cleanupPatientDeep(seed.patientId);
    cleanupStaffAndGroup(uid, groupId);
    safeSql(`DELETE FROM iam.permission_groups WHERE tenant_id = '${ABAC_TENANT}' AND name LIKE 'Adm050P % ${RUN_ID}'`);
  });

  test('feliz: reunião cancelada com o evento do Google pendente mostra o selo "Cancelada, evento de Google pendiente"', async ({ page, request }, testInfo) => {
    const apptId = semearReuniao(seed.patientId, 1, true);
    trilha(apptId, 'cancel_calendar_failed', 'failed', 30);

    await loginAs(page, leitora);
    await abrirAba(page, seed.patientId);
    await expect(page.getByTestId(`admission-row-${apptId}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`admission-status-${apptId}`)).toHaveText('Cancelada');
    await expect(page.getByTestId(`admission-calendar-pending-${apptId}`)).toHaveText(SELO);
    await page.screenshot({ path: testInfo.outputPath('1-feliz-selo-pendente.png'), fullPage: true });

    // O campo vem da API (derivado da trilha), não da tela: a lista diz `calendarEventPending: true` para esta reunião.
    const lista = await request.get(`${ABAC_API_URL}/api/admin/patients/${seed.patientId}/admission-appointments`, {
      headers: { Authorization: `Bearer ${tokenFor(leitora)}` },
    });
    expect(lista.status()).toBe(200);
    const corpo = JSON.stringify(await lista.json());
    expect(corpo).toContain(apptId);
    expect(corpo).toMatch(/"calendarEventPending":true/);
  });

  test('alt 1: cancelada cujo apagar tardio já rodou NÃO mostra o selo (a pendente da mesma tela mostra)', async ({ page }, testInfo) => {
    const limpa = semearReuniao(seed.patientId, 2, true);
    trilha(limpa, 'cancel_calendar_failed', 'failed', 60);
    trilha(limpa, 'cancel_calendar_deleted', 'deleted', 20);
    expect(scalar(`SELECT count(*) FROM admission_events WHERE appointment_id = '${limpa}'`)).toBe('2');
    const pendente = semearReuniao(seed.patientId, 4, true);
    trilha(pendente, 'cancel_calendar_failed', 'failed', 30);

    await loginAs(page, leitora);
    await abrirAba(page, seed.patientId);
    await expect(page.getByTestId(`admission-row-${limpa}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`admission-status-${limpa}`)).toHaveText('Cancelada');
    // Controle positivo na MESMA tela: a pendente (semeada acima) mostra o selo, então o seletor mede de verdade.
    await expect(page.getByTestId(`admission-calendar-pending-${pendente}`)).toHaveText(SELO);
    await expect(page.getByTestId(`admission-calendar-pending-${limpa}`)).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('2-alt1-sem-selo.png'), fullPage: true });
  });

  test('alt 2: reunião agendada não mostra o selo, mesmo com evento e uma falha antiga na trilha', async ({ page }, testInfo) => {
    const agendada = semearReuniao(seed.patientId, 3, false);
    trilha(agendada, 'cancel_calendar_failed', 'failed', 60);
    const pendente = semearReuniao(seed.patientId, 5, true);
    trilha(pendente, 'cancel_calendar_failed', 'failed', 30);

    await loginAs(page, leitora);
    await abrirAba(page, seed.patientId);
    await expect(page.getByTestId(`admission-row-${agendada}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`admission-status-${agendada}`)).toHaveText('Agendada');
    await expect(page.getByTestId(`admission-calendar-pending-${pendente}`)).toHaveText(SELO); // controle: a pendente está na tela
    await expect(page.getByTestId(`admission-calendar-pending-${agendada}`)).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('3-alt2-agendada-sem-selo.png'), fullPage: true });
  });
});
