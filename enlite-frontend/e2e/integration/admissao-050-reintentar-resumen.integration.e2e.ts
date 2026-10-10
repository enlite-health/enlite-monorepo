/**
 * admissao-050-reintentar-resumen.integration.e2e.ts @integration — spec 050 F11 (R-38), botão "Reintentar resumen" na aba Admisión.
 *
 * E2E DE TELA, sem mock de resposta: frontend + API + Postgres reais, engine ABAC LIGADO, staff REAL em grupo (células por SQL),
 * clique de humano (`loginAs`) e valor lido da tela. O estado "tentativas esgotadas" é semeado na TRILHA (`admission_events`,
 * 3 `summary_failed` do lado do modelo + o `import_blocked` de exaustão) — exatamente o que a importação grava; o clique, o POST, a
 * autorização e a volta da reunião à fila são REAIS. Nenhum canal real: a API roda com `ADMISSION_EXTERNALS=fake`.
 *
 *  feliz  — operadora COM `patient_admission:retry_summary` abre a aba: a reunião esgotada mostra o botão -> o modal diz o custo
 *           ("hasta 3 llamadas pagas") -> "Volver" não autoriza nada -> confirmar: 200 `authorized`, aviso na tela, UMA linha
 *           `summary_retry_authorized` na trilha com quem autorizou, a reunião volta a `waiting` e o botão some (rodada nova, sem falha).
 *  alt 1  — staff SÓ com `patient_admission:read`: a lista abre, o botão NÃO existe no DOM e o POST direto leva 403 `missing_cell`,
 *           com a trilha inalterada (controle: a MESMA reunião é autorizável por quem tem a célula).
 *  alt 2  — reunião com as 2 autorizações já gastas e a rodada esgotada de novo: sem botão, com o aviso "Límite de reintentos
 *           alcanzado"; o POST direto leva 409 `SUMMARY_RETRY_LIMIT_REACHED` e a trilha segue com 2 autorizações.
 *
 * ⚠️ Precisa do engine ABAC LIGADO (alt 1 mede AUSÊNCIA por falta de célula) e da API com `ADMISSION_EXTERNALS=fake` — o nome entra no
 * `--grep` do job `integration-e2e-group-simulation` do `_frontend-integration.yml`, junto de `admissao-049`. Escrito na F11; a
 * EXECUÇÃO é do job de CI/da tarefa do orquestrador com a stack do navegador (nunca rodou local neste branch).
 * Rodar local = o job do CI: `ABAC_API_URL`, `ABAC_TEST_DB_URL`, `E2E_PG_CONTAINER`, `E2E_BACKEND_URL`. Dados SINTÉTICOS.
 */
import { test, expect, type Page } from '@playwright/test';
import { seedActivatablePatient, cleanupPatientDeep } from '../helpers/patient-detail-c-helper';
import {
  psql, scalar, safeSql, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, tokenFor, ABAC_API_URL, ABAC_TENANT,
} from '../helpers/abac-stack-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const HOST = `ana.e2e050-${RUN_ID}@example.test`;
const CODE_BASE = RUN_ID.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(-5);

/** Reunião `booked`, terminada há 2 h, na fila de importação (`blocked`), com o código ADM único desta rodada. */
function semearReuniao(patientId: string, n: number): string {
  const id = scalar(
    `INSERT INTO admission_appointments
       (patient_id, country, host_email, host_display_name, slot_start, slot_end, status, meet_link, admission_code, created_at, conference_ended_at, import_status)
     VALUES ('${patientId}', 'AR', '${HOST}', 'Ana E2E050', now() - interval '3 hours', now() - interval '150 minutes', 'booked',
             'https://meet.google.com/abc-defg-hij', 'ADM-${CODE_BASE}${n}', now() - interval '1 day', now() - interval '2 hours', 'blocked')
     RETURNING id`,
  );
  return id.split('\n')[0].trim();
}

/** Uma rodada esgotada na trilha: 3 falhas do lado do modelo e a exaustão, tudo `minutosAtras` (ordem por `at`). */
function esgotar(apptId: string, minutosAtras: number): void {
  for (let i = 0; i < 3; i += 1) {
    psql(`INSERT INTO admission_events (appointment_id, kind, outcome, reason, at)
          VALUES ('${apptId}', 'summary_failed', 'failed', 'vertex_failed', now() - interval '${minutosAtras + 3 - i} minutes')`);
  }
  psql(`INSERT INTO admission_events (appointment_id, kind, outcome, reason, at)
        VALUES ('${apptId}', 'import_blocked', 'blocked', 'summary_attempts_exhausted', now() - interval '${minutosAtras} minutes')`);
}

function autorizar(apptId: string, minutosAtras: number, n: number): void {
  psql(`INSERT INTO admission_events (appointment_id, kind, outcome, ref, at)
        VALUES ('${apptId}', 'summary_retry_authorized', 'authorized', '{"actorUid":"seed","authorization":${n}}'::jsonb, now() - interval '${minutosAtras} minutes')`);
}

const eventos = (apptId: string, kind: string): number =>
  Number(scalar(`SELECT count(*) FROM admission_events WHERE appointment_id = '${apptId}' AND kind = '${kind}'`));

async function abrirAba(page: Page, patientId: string): Promise<void> {
  await page.goto(`/admin/patients/${patientId}`);
  await expect(page.getByTestId('patient-profile-tabs')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Admisión', exact: true }).click();
  await expect(page.getByTestId('admission-tab')).toBeVisible({ timeout: 15_000 });
}

const RETRY_ROUTE = /\/api\/admin\/patients\/[0-9a-f-]+\/admission-appointments\/[0-9a-f-]+\/summary-retry$/;

test.use({ viewport: { width: 1600, height: 1100 }, video: 'on' });

test.describe('admissao-050 — aba Admisión: Reintentar resumen (spec 050 F11, R-38) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  let seed: { patientId: string; addressId: string; stamp: string };
  let operadoraGroupId = '';
  let leitoraGroupId = '';
  const operadoraUid = `e2e-050-operadora-${RUN_ID}`;
  const leitoraUid = `e2e-050-leitora-${RUN_ID}`;
  const operadora = { uid: operadoraUid, email: `${operadoraUid}@e2e.test`, role: 'admin', country: 'AR' };
  const leitora = { uid: leitoraUid, email: `${leitoraUid}@e2e.test`, role: 'admin', country: 'AR' };
  const CELULAS_VER: Array<[string, string]> = [['patient', 'read'], ['patient_identity', 'read'], ['patient_admission', 'read']];

  test.beforeAll(() => {
    seed = seedActivatablePatient(750000);
    operadoraGroupId = seedStaffInGroup({ uid: operadoraUid, email: operadora.email, groupName: `Adm050 Operadora ${RUN_ID}`, country: 'AR' }).groupId;
    for (const [r, a] of CELULAS_VER) grantCell(operadoraGroupId, r, a);
    grantCell(operadoraGroupId, 'patient_admission', 'retry_summary');
    leitoraGroupId = seedStaffInGroup({ uid: leitoraUid, email: leitora.email, groupName: `Adm050 Leitora ${RUN_ID}`, country: 'AR' }).groupId;
    for (const [r, a] of CELULAS_VER) grantCell(leitoraGroupId, r, a);
  });

  test.afterAll(() => {
    safeSql(`DELETE FROM admission_appointments WHERE patient_id = '${seed.patientId}'`);
    safeSql(`DELETE FROM patients WHERE id = '${seed.patientId}'`);
    cleanupPatientDeep(seed.patientId);
    cleanupStaffAndGroup(operadoraUid, operadoraGroupId);
    cleanupStaffAndGroup(leitoraUid, leitoraGroupId);
    safeSql(`DELETE FROM iam.permission_groups WHERE tenant_id = '${ABAC_TENANT}' AND name LIKE 'Adm050 % ${RUN_ID}'`);
  });

  test('feliz: reunião esgotada -> botão -> modal com o custo -> confirmar autoriza UMA rodada, a trilha diz quem e a reunião volta à fila', async ({ page }, testInfo) => {
    const apptId = semearReuniao(seed.patientId, 1);
    esgotar(apptId, 30);
    expect(eventos(apptId, 'summary_retry_authorized'), 'começa sem autorização').toBe(0);

    await loginAs(page, operadora);
    await abrirAba(page, seed.patientId);
    await expect(page.getByTestId(`admission-row-${apptId}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`admission-seal-import-chip-${apptId}`)).toHaveText('Bloqueada');
    const botao = page.getByTestId(`admission-retry-summary-${apptId}`);
    await expect(botao).toHaveText('Reintentar resumen');
    await page.screenshot({ path: testInfo.outputPath('1-feliz-botao.png'), fullPage: true });

    // O modal diz o custo; "Volver" não autoriza nada.
    await botao.click();
    const dialogo = page.getByTestId('admission-retry-dialog');
    await expect(dialogo).toBeVisible();
    await expect(dialogo).toContainText('hasta 3 llamadas pagas');
    await expect(page.getByTestId('admission-retry-dialog-back')).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath('2-feliz-modal-custo.png') });
    await page.getByTestId('admission-retry-dialog-back').click();
    await expect(dialogo).toHaveCount(0);
    expect(eventos(apptId, 'summary_retry_authorized'), 'Volver não autoriza').toBe(0);

    await botao.click();
    const enviou = page.waitForResponse((r) => r.request().method() === 'POST' && RETRY_ROUTE.test(r.url()));
    await page.getByTestId('admission-retry-dialog-confirm').click();
    const resposta = await enviou;
    expect(resposta.status()).toBe(200);
    expect(((await resposta.json()) as { data: { mode: string; authorizationsLeft: number } }).data).toMatchObject({ mode: 'authorized', authorizationsLeft: 1 });
    await expect(dialogo).toHaveCount(0);
    await expect(page.getByTestId('admission-notice')).toHaveText('Nueva ronda autorizada: el resumen se generará en la próxima importación.');

    // O banco concorda: UMA autorização com quem autorizou, a reunião voltou à fila e a trilha antiga segue intacta (só-acréscimo).
    expect(eventos(apptId, 'summary_retry_authorized')).toBe(1);
    expect(scalar(`SELECT ref->>'actorUid' FROM admission_events WHERE appointment_id = '${apptId}' AND kind = 'summary_retry_authorized'`)).toBe(operadoraUid);
    expect(scalar(`SELECT import_status FROM admission_appointments WHERE id = '${apptId}'`)).toBe('waiting');
    expect(eventos(apptId, 'summary_failed'), 'as 3 falhas continuam na trilha').toBe(3);
    // A rodada nova não falhou ainda: o botão some e o selo da importação mostra a fila.
    await expect(botao).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId(`admission-seal-import-chip-${apptId}`)).toHaveText('Esperando');
    await page.screenshot({ path: testInfo.outputPath('3-feliz-autorizada.png'), fullPage: true });
  });

  test('alt 1: staff SÓ com patient_admission:read vê a reunião mas o botão não existe; o POST direto leva 403 e a trilha fica inalterada', async ({ page, request }, testInfo) => {
    const apptId = semearReuniao(seed.patientId, 2);
    esgotar(apptId, 30);

    await loginAs(page, leitora);
    await abrirAba(page, seed.patientId);
    // Controle positivo: a linha esgotada ESTÁ na lista (a ausência do botão não é aba vazia nem quebrada).
    await expect(page.getByTestId(`admission-row-${apptId}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`admission-seal-import-chip-${apptId}`)).toHaveText('Bloqueada');
    await expect(page.getByTestId(`admission-retry-summary-${apptId}`)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reintentar resumen' })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('4-alt1-sem-botao.png') });

    const direto = await request.post(`${ABAC_API_URL}/api/admin/patients/${seed.patientId}/admission-appointments/${apptId}/summary-retry`, {
      headers: { Authorization: `Bearer ${tokenFor(leitora)}` },
    });
    expect(direto.status()).toBe(403);
    expect(await direto.json()).toMatchObject({ code: 'missing_cell' });
    expect(eventos(apptId, 'summary_retry_authorized'), 'trilha inalterada').toBe(0);
    expect(scalar(`SELECT import_status FROM admission_appointments WHERE id = '${apptId}'`)).toBe('blocked');
    // Controle positivo: a MESMA reunião é autorizável por quem tem a célula (o 403 acima é da célula, não do corpo ou da rota).
    const comCelula = await request.post(`${ABAC_API_URL}/api/admin/patients/${seed.patientId}/admission-appointments/${apptId}/summary-retry`, {
      headers: { Authorization: `Bearer ${tokenFor(operadora)}` },
    });
    expect(comCelula.status()).toBe(200);
    expect(eventos(apptId, 'summary_retry_authorized')).toBe(1);
  });

  test('alt 2: com as 2 autorizações gastas e a rodada esgotada de novo não há botão (só o aviso) e o POST direto leva 409', async ({ page, request }, testInfo) => {
    const apptId = semearReuniao(seed.patientId, 3);
    esgotar(apptId, 300);
    autorizar(apptId, 200, 1);
    esgotar(apptId, 150);
    autorizar(apptId, 100, 2);
    esgotar(apptId, 30);
    expect(eventos(apptId, 'summary_retry_authorized')).toBe(2);

    await loginAs(page, operadora);
    await abrirAba(page, seed.patientId);
    await expect(page.getByTestId(`admission-row-${apptId}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`admission-retry-limit-${apptId}`)).toHaveText('Límite de reintentos alcanzado');
    await expect(page.getByTestId(`admission-retry-summary-${apptId}`)).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('5-alt2-teto.png') });

    const direto = await request.post(`${ABAC_API_URL}/api/admin/patients/${seed.patientId}/admission-appointments/${apptId}/summary-retry`, {
      headers: { Authorization: `Bearer ${tokenFor(operadora)}` },
    });
    expect(direto.status()).toBe(409);
    expect(await direto.json()).toMatchObject({ code: 'SUMMARY_RETRY_LIMIT_REACHED' });
    expect(eventos(apptId, 'summary_retry_authorized'), 'a 3ª autorização não entrou').toBe(2);
    expect(scalar(`SELECT import_status FROM admission_appointments WHERE id = '${apptId}'`)).toBe('blocked');
  });
});
