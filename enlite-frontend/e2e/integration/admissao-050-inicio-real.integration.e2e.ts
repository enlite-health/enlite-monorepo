/**
 * admissao-050-inicio-real.integration.e2e.ts @integration — spec 050 F14 (A14-4), a aba Admisión mostra o INÍCIO e o FIM reais da reunião.
 *
 * E2E DE TELA, sem mock de resposta: frontend + API + Postgres reais, engine ABAC LIGADO, staff REAL em grupo (células por SQL),
 * login de humano (`loginAs`) e texto lido da tela. Início e fim são o que o job de 15 min grava (`conference_started_at` = menor
 * `startTime` do Meet, `conference_ended_at` = maior `endTime`); a semeadura grava as colunas por SQL (o job tem e2e próprio no
 * backend), e a lista, os campos `conferenceStartedAt`/`conferenceEndedAt` e as linhas da tela são REAIS. Nenhum canal real
 * (`ADMISSION_EXTERNALS=fake`). Os horários saem no fuso do país do paciente (AR, -03): 15:04Z → "12:04".
 *
 *  feliz  — reunião com início e fim: a linha mostra "Inicio real 12:04" e "Fin real 12:52"; a API devolve os dois instantes.
 *  alt 1  — reunião sem conferência observada: nenhum dos dois aparece (controle: a do feliz, na MESMA tela, mostra).
 *  alt 2  — reunião em andamento (só o início gravado): mostra o início e NÃO mostra o fim.
 *
 * ⚠️ O nome entra no `--grep` do job `integration-e2e-group-simulation` do `_frontend-integration.yml` pelo token `admissao-050`.
 */
import { test, expect, type Page } from '@playwright/test';
import { seedActivatablePatient, cleanupPatientDeep } from '../helpers/patient-detail-c-helper';
import {
  psql, scalar, safeSql, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, tokenFor, ABAC_API_URL, ABAC_TENANT,
} from '../helpers/abac-stack-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const HOST = `ana.e2e050i-${RUN_ID}@example.test`;
const CODE_BASE = RUN_ID.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(-5);

/** Reunião sintética no passado (n dias atrás), 1 h, com início/fim reais opcionais (ISO UTC). */
function semearReuniao(patientId: string, n: number, real: { inicio?: string; fim?: string } = {}): string {
  const lit = (v?: string): string => (v ? `'${v}'::timestamptz` : 'NULL');
  const id = scalar(
    `INSERT INTO admission_appointments
       (patient_id, country, host_email, host_display_name, slot_start, slot_end, status, admission_code, created_at,
        conference_started_at, conference_ended_at)
     VALUES ('${patientId}', 'AR', '${HOST}', 'Ana E2E050I', now() - interval '${n + 1} days', now() - interval '${n + 1} days' + interval '1 hour',
             'booked', 'ADM-${CODE_BASE}${n}', now() - interval '10 days', ${lit(real.inicio)}, ${lit(real.fim)})
     RETURNING id`,
  );
  return id.split('\n')[0].trim();
}

async function abrirAba(page: Page, patientId: string): Promise<void> {
  await page.goto(`/admin/patients/${patientId}`);
  await expect(page.getByTestId('patient-profile-tabs')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Admisión', exact: true }).click();
  await expect(page.getByTestId('admission-tab')).toBeVisible({ timeout: 15_000 });
}

test.use({ viewport: { width: 1600, height: 1100 }, video: 'on' });

test.describe('admissao-050 — aba Admisión: início e fim reais da reunião (spec 050 F14) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  let seed: { patientId: string; addressId: string; stamp: string };
  let groupId = '';
  const uid = `e2e-050i-leitora-${RUN_ID}`;
  const leitora = { uid, email: `${uid}@e2e.test`, role: 'admin', country: 'AR' };

  test.beforeAll(() => {
    seed = seedActivatablePatient(752000);
    groupId = seedStaffInGroup({ uid, email: leitora.email, groupName: `Adm050I Leitora ${RUN_ID}`, country: 'AR' }).groupId;
    for (const [r, a] of [['patient', 'read'], ['patient_identity', 'read'], ['patient_admission', 'read']]) grantCell(groupId, r, a);
  });

  test.afterAll(() => {
    safeSql(`DELETE FROM admission_appointments WHERE patient_id = '${seed.patientId}'`);
    safeSql(`DELETE FROM patients WHERE id = '${seed.patientId}'`);
    cleanupPatientDeep(seed.patientId);
    cleanupStaffAndGroup(uid, groupId);
    safeSql(`DELETE FROM iam.permission_groups WHERE tenant_id = '${ABAC_TENANT}' AND name LIKE 'Adm050I % ${RUN_ID}'`);
  });

  test('feliz: reunião com início e fim reais mostra "Inicio real 12:04" e "Fin real 12:52" (fuso do país)', async ({ page, request }, testInfo) => {
    const apptId = semearReuniao(seed.patientId, 1, { inicio: '2026-10-01T15:04:00Z', fim: '2026-10-01T15:52:00Z' });

    await loginAs(page, leitora);
    await abrirAba(page, seed.patientId);
    await expect(page.getByTestId(`admission-row-${apptId}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`admission-conference-start-${apptId}`)).toHaveText('Inicio real 12:04');
    await expect(page.getByTestId(`admission-conference-end-${apptId}`)).toHaveText('Fin real 12:52');
    await page.screenshot({ path: testInfo.outputPath('1-feliz-inicio-e-fim.png'), fullPage: true });

    // Os dois instantes vêm da API (colunas gravadas pelo job), não da tela.
    const lista = await request.get(`${ABAC_API_URL}/api/admin/patients/${seed.patientId}/admission-appointments`, {
      headers: { Authorization: `Bearer ${tokenFor(leitora)}` },
    });
    expect(lista.status()).toBe(200);
    const corpo = JSON.stringify(await lista.json());
    expect(corpo).toContain('"conferenceStartedAt":"2026-10-01T15:04:00.000Z"');
    expect(corpo).toContain('"conferenceEndedAt":"2026-10-01T15:52:00.000Z"');
  });

  test('alt 1: reunião sem conferência observada NÃO mostra início nem fim (a do feliz, na mesma tela, mostra)', async ({ page }, testInfo) => {
    const comReal = semearReuniao(seed.patientId, 2, { inicio: '2026-10-01T15:04:00Z', fim: '2026-10-01T15:52:00Z' });
    const vazia = semearReuniao(seed.patientId, 3);

    await loginAs(page, leitora);
    await abrirAba(page, seed.patientId);
    await expect(page.getByTestId(`admission-row-${vazia}`)).toBeVisible({ timeout: 15_000 });
    // Controle positivo na MESMA tela: a reunião com início e fim mostra os dois, então o seletor mede de verdade.
    await expect(page.getByTestId(`admission-conference-start-${comReal}`)).toHaveText('Inicio real 12:04');
    await expect(page.getByTestId(`admission-conference-end-${comReal}`)).toHaveText('Fin real 12:52');
    await expect(page.getByTestId(`admission-conference-start-${vazia}`)).toHaveCount(0);
    await expect(page.getByTestId(`admission-conference-end-${vazia}`)).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('2-alt1-sem-conferencia.png'), fullPage: true });
  });

  test('alt 2: reunião em andamento (só o início gravado) mostra o início e NÃO mostra o fim', async ({ page }, testInfo) => {
    const andamento = semearReuniao(seed.patientId, 4, { inicio: '2026-10-01T15:07:00Z' });
    const completa = semearReuniao(seed.patientId, 5, { inicio: '2026-10-01T15:04:00Z', fim: '2026-10-01T15:52:00Z' });

    await loginAs(page, leitora);
    await abrirAba(page, seed.patientId);
    await expect(page.getByTestId(`admission-row-${andamento}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`admission-conference-start-${andamento}`)).toHaveText('Inicio real 12:07');
    await expect(page.getByTestId(`admission-conference-end-${completa}`)).toHaveText('Fin real 12:52'); // controle: o fim aparece quando existe
    await expect(page.getByTestId(`admission-conference-end-${andamento}`)).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('3-alt2-em-andamento.png'), fullPage: true });
  });
});
