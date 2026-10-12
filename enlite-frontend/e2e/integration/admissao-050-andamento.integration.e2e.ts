/**
 * admissao-050-andamento.integration.e2e.ts @integration — spec 050 F29 (A29-4), a aba Admisión mostra o ANDAMENTO da reunião (§19.3).
 *
 * E2E DE TELA, sem mock de resposta: frontend + API + Postgres reais, engine ABAC LIGADO, staff REAL em grupo (células por SQL),
 * login de humano (`loginAs`) e texto lido da tela. O estado do andamento é decidido pela função pura do servidor
 * (`callProgressOf`); a semeadura grava as colunas e o documento por SQL (o job tem e2e próprio no backend), e a lista, o campo
 * `callProgress` e a linha da tela são REAIS. Nenhum canal real (`ADMISSION_EXTERNALS=fake`). Horas no fuso do país do paciente (AR, -03).
 *
 *  feliz  — UMA reunião que avança: em andamento -> terminou -> resumo em preparação -> resumo pronto (a hora é a do DOCUMENTO).
 *  alt 1  — reaberta DEPOIS do resumo: a tela avisa e NÃO mostra "resumo pronto" nem promete botão de refazer.
 *  alt 2  — fim cedo (sem armar o resumo): "Terminó a las", NUNCA "Resumen en preparación" (controle: outra reunião, preparando, na mesma tela).
 *
 * ⚠️ O nome entra no `--grep` do job `integration-e2e-group-simulation` do `_frontend-integration.yml` pelo token `admissao-050`.
 */
import { test, expect, type Page } from '@playwright/test';
import { seedActivatablePatient, cleanupPatientDeep } from '../helpers/patient-detail-c-helper';
import {
  psql, scalar, safeSql, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, ABAC_TENANT,
} from '../helpers/abac-stack-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const HOST = `ana.e2e050a-${RUN_ID}@example.test`;
const CODE_BASE = RUN_ID.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(-5);

const T = {
  inicio: '2026-10-01T15:04:00Z', // 12:04 em AR
  fim: '2026-10-01T15:52:00Z', // 12:52
  documento: '2026-10-01T15:59:00Z', // 12:59
  reabertura: '2026-10-01T16:30:00Z',
};

/** Reunião sintética no passado (n dias atrás), 1 h. */
function semearReuniao(patientId: string, n: number, f: { inicio?: string; fim?: string; importStatus?: string } = {}): string {
  const lit = (v?: string): string => (v ? `'${v}'::timestamptz` : 'NULL');
  const id = scalar(
    `INSERT INTO admission_appointments
       (patient_id, country, host_email, host_display_name, slot_start, slot_end, status, admission_code, created_at,
        conference_started_at, conference_ended_at, import_status)
     VALUES ('${patientId}', 'AR', '${HOST}', 'Ana E2E050A', now() - interval '${n + 1} days', now() - interval '${n + 1} days' + interval '1 hour',
             'booked', 'ADM-${CODE_BASE}${n}', now() - interval '10 days', ${lit(f.inicio)}, ${lit(f.fim)}, ${f.importStatus ? `'${f.importStatus}'` : 'NULL'})
     RETURNING id`,
  );
  return id.split('\n')[0].trim();
}

function semearDocumento(patientId: string, apptId: string, criadoEm: string): void {
  psql(
    `INSERT INTO patient_documents (patient_id, origin, label_encrypted, file_path_encrypted, original_name_encrypted, content_type, size_bytes, sha256, created_by_uid, source_appointment_id, created_at)
     VALUES ('${patientId}', 'admission', 'enc:resumo', 'enc:p', 'enc:n', 'application/pdf', 10, '\\x00', 'e050-andamento', '${apptId}', '${criadoEm}'::timestamptz)`,
  );
}

function semearReaberturaDepoisDoResumo(apptId: string, quando: string): void {
  psql(`INSERT INTO admission_events (appointment_id, kind, outcome, reason, at) VALUES ('${apptId}', 'conference_reopened', 'reopened', 'after_summary', '${quando}'::timestamptz)`);
}

async function abrirAba(page: Page, patientId: string): Promise<void> {
  await page.goto(`/admin/patients/${patientId}`);
  await expect(page.getByTestId('patient-profile-tabs')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Admisión', exact: true }).click();
  await expect(page.getByTestId('admission-tab')).toBeVisible({ timeout: 15_000 });
}

test.use({ viewport: { width: 1600, height: 1100 }, video: 'on' });

test.describe('admissao-050 — aba Admisión: andamento da reunión (spec 050 F29) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  let seed: { patientId: string; addressId: string; stamp: string };
  let groupId = '';
  const uid = `e2e-050a-leitora-${RUN_ID}`;
  const leitora = { uid, email: `${uid}@e2e.test`, role: 'admin', country: 'AR' };

  test.beforeAll(() => {
    seed = seedActivatablePatient(753000);
    groupId = seedStaffInGroup({ uid, email: leitora.email, groupName: `Adm050A Leitora ${RUN_ID}`, country: 'AR' }).groupId;
    for (const [r, a] of [['patient', 'read'], ['patient_identity', 'read'], ['patient_admission', 'read']]) grantCell(groupId, r, a);
  });

  test.afterAll(() => {
    safeSql(`DELETE FROM patient_documents WHERE patient_id = '${seed.patientId}' AND created_by_uid = 'e050-andamento'`);
    safeSql(`DELETE FROM admission_appointments WHERE patient_id = '${seed.patientId}'`);
    safeSql(`DELETE FROM patients WHERE id = '${seed.patientId}'`);
    cleanupPatientDeep(seed.patientId);
    cleanupStaffAndGroup(uid, groupId);
    safeSql(`DELETE FROM iam.permission_groups WHERE tenant_id = '${ABAC_TENANT}' AND name LIKE 'Adm050A % ${RUN_ID}'`);
  });

  test('feliz: a MESMA reunião avança — "En curso desde 12:04" -> "Terminó a las 12:52" -> "Resumen en preparación" -> "Resumen listo a las 12:59"', async ({ page }, testInfo) => {
    const id = semearReuniao(seed.patientId, 1, { inicio: T.inicio });
    const linha = page.getByTestId(`admission-call-progress-${id}`);

    await loginAs(page, leitora);
    await abrirAba(page, seed.patientId);
    await expect(page.getByTestId(`admission-row-${id}`)).toBeVisible({ timeout: 15_000 });
    await expect(linha).toHaveText('En curso desde 12:04');
    await page.getByTestId(`admission-row-${id}`).screenshot({ path: testInfo.outputPath('1-em-andamento.png') });

    // terminou (fim gravado, sem armar o resumo)
    psql(`UPDATE admission_appointments SET conference_ended_at = '${T.fim}'::timestamptz WHERE id = '${id}'`);
    await abrirAba(page, seed.patientId);
    await expect(linha).toHaveText('Terminó a las 12:52');
    await page.getByTestId(`admission-row-${id}`).screenshot({ path: testInfo.outputPath('2-terminou.png') });

    // a importação assumiu: resumo em preparação
    psql(`UPDATE admission_appointments SET import_status = 'pending' WHERE id = '${id}'`);
    await abrirAba(page, seed.patientId);
    await expect(linha).toHaveText('Resumen en preparación');
    await page.getByTestId(`admission-row-${id}`).screenshot({ path: testInfo.outputPath('3-resumo-em-preparacao.png') });

    // o resumo saiu: a hora é a do DOCUMENTO (12:59), não a do fim (12:52)
    psql(`UPDATE admission_appointments SET import_status = 'done' WHERE id = '${id}'`);
    semearDocumento(seed.patientId, id, T.documento);
    await abrirAba(page, seed.patientId);
    await expect(linha).toHaveText('Resumen listo a las 12:59');
    await page.getByTestId(`admission-row-${id}`).screenshot({ path: testInfo.outputPath('4-resumo-pronto.png') });
    // os dois spans que já existiam seguem na linha da reunião
    await expect(page.getByTestId(`admission-conference-start-${id}`)).toHaveText('Inicio real 12:04');
    await expect(page.getByTestId(`admission-conference-end-${id}`)).toHaveText('Fin real 12:52');
  });

  test('alt 1: reaberta DEPOIS do resumo — a tela avisa, não mostra "resumo listo" e não promete botão de refazer', async ({ page }, testInfo) => {
    const pronta = semearReuniao(seed.patientId, 2, { inicio: T.inicio, fim: T.fim, importStatus: 'done' });
    semearDocumento(seed.patientId, pronta, T.documento);
    const reaberta = semearReuniao(seed.patientId, 3, { inicio: T.inicio, fim: T.fim, importStatus: 'done' });
    semearDocumento(seed.patientId, reaberta, T.documento);
    semearReaberturaDepoisDoResumo(reaberta, T.reabertura);

    await loginAs(page, leitora);
    await abrirAba(page, seed.patientId);
    await expect(page.getByTestId(`admission-row-${reaberta}`)).toBeVisible({ timeout: 15_000 });
    // controle positivo na MESMA tela: a reunião sem reabertura mostra o resumo pronto
    await expect(page.getByTestId(`admission-call-progress-${pronta}`)).toHaveText('Resumen listo a las 12:59');
    const aviso = page.getByTestId(`admission-call-progress-${reaberta}`);
    await expect(aviso).toHaveText('Volvió a abrirse después del resumen');
    await expect(aviso).not.toContainText('Resumen listo');
    const texto = (await aviso.textContent()) ?? '';
    expect(texto).not.toMatch(/reintent|rehacer|bot[oó]n|clic/i);
    // não existe botão de refazer nesta reunião (a regra do "Reintentar resumen" não mudou)
    await expect(page.getByTestId(`admission-retry-summary-${reaberta}`)).toHaveCount(0);
    await page.getByTestId('admission-tab').screenshot({ path: testInfo.outputPath('5-reaberta-depois-do-resumo.png') });
  });

  test('alt 2: fim cedo (sem armar o resumo) mostra "Terminó a las", NUNCA "Resumen en preparación"', async ({ page }, testInfo) => {
    const cedo = semearReuniao(seed.patientId, 4, { inicio: T.inicio, fim: '2026-10-01T15:12:00Z' }); // import_status vazio
    const preparando = semearReuniao(seed.patientId, 5, { inicio: T.inicio, fim: T.fim, importStatus: 'pending' });

    await loginAs(page, leitora);
    await abrirAba(page, seed.patientId);
    await expect(page.getByTestId(`admission-row-${cedo}`)).toBeVisible({ timeout: 15_000 });
    // controle positivo na MESMA tela: a que está de fato preparando mostra "en preparación"
    await expect(page.getByTestId(`admission-call-progress-${preparando}`)).toHaveText('Resumen en preparación');
    await expect(page.getByTestId(`admission-call-progress-${cedo}`)).toHaveText('Terminó a las 12:12');
    await expect(page.getByTestId(`admission-call-progress-${cedo}`)).not.toContainText('preparación');
    await page.getByTestId('admission-tab').screenshot({ path: testInfo.outputPath('6-fim-cedo-sem-preparacao.png') });
  });
});
