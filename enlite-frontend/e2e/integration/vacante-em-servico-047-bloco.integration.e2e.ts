/**
 * vacante-em-servico-047-bloco.integration.e2e.ts @integration — spec 047, F4: o bloco "Vacantes Generadas" mostra o
 * código da vaga em `EN1234#01` (`formatVacancyCase`, o MESMO dono da coluna "Código de la vacante" da tabela de
 * serviços) — e não mais `CASO 1234-n`.
 *
 * E2E DE TELA, sem mock de resposta: API real + Postgres real, engine ABAC LIGADO, staff real em grupo, clique humano.
 * Nenhum canal real: só Postgres; a vaga já nasce com `social_short_links.site` semeado e `is_test`.
 *
 *  feliz — o bloco mostra `EN<caso>#01`, IGUAL ao texto da coluna da tabela de serviços, na MESMA tela (e o caso vem do
 *          PACIENTE: `jp.case_number` fica NULL de propósito).
 *  alt 1 — vaga SEM serviço vinculado (`contracted_service_id` NULL) aparece no bloco.
 *  alt 2 — paciente sem vaga: o texto de vazio do bloco.
 *
 * ⚠️ ABAC LIGADO (job `integration-e2e-group-simulation`; casa o `--grep "vacante-em-servico-047"`).
 */
import { test, expect, type Page } from '@playwright/test';
import {
  seedPatientQA, cleanupPatientQA, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, safeSql, scalar,
  type MockUser,
} from '../helpers/patient-conversation-helper';

const TAB_BAR = 'patient-profile-tabs';
const CASE_NUMBER = 948100 + (Date.now() % 800);
const CODIGO = `EN${CASE_NUMBER}#01`;

interface Seeded { patientId: string; groupId: string; user: MockUser; serviceId: string; vacancyId: string }

function seed(tag: string, cells: Array<[string, string]>, opts: { vaga: 'com-servico' | 'sem-servico' | 'nenhuma' }): Seeded {
  const run = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const uid = `e2e-v047b-${tag}-${run}`;
  const user: MockUser = { uid, email: `${uid}@e2e.test`, role: 'recruiter', country: 'AR' };
  const patientId = seedPatientQA();
  safeSql(`UPDATE patients SET case_number = ${CASE_NUMBER} WHERE id = '${patientId}'`);
  const { groupId } = seedStaffInGroup({ uid, email: user.email, groupName: `E2E Vacante047b ${tag} ${run}`, country: 'AR' });
  for (const [resource, action] of cells) grantCell(groupId, resource, action);
  const serviceId = opts.vaga === 'com-servico'
    ? scalar(`INSERT INTO patient_contracted_services (patient_id, service_code, active, country, created_by, updated_by)
        VALUES ('${patientId}', 'AT', true, 'AR', '${uid}', '${uid}') RETURNING id`)
    : '';
  const vacancyId = opts.vaga === 'nenhuma' ? '' : scalar(`INSERT INTO job_postings (vacancy_number, title, description, patient_id, contracted_service_id, case_ordinal,
        required_professions, status, is_draft, is_test, country, social_short_links, created_at, updated_at)
      VALUES (nextval('job_postings_vacancy_number_seq'), 'Vaga e2e 047 bloco', '', '${patientId}', ${serviceId ? `'${serviceId}'` : 'NULL'}, 1,
        ARRAY['AT']::varchar[], 'SEARCHING', false, true, 'AR', '{"site": {"id": "link_x", "url": "https://exemplo.test/x"}}'::jsonb, NOW(), NOW()) RETURNING id`);
  return { patientId, groupId, user, serviceId, vacancyId };
}

function cleanup(s: Seeded): void {
  safeSql(`DELETE FROM job_postings WHERE patient_id = '${s.patientId}'`);
  safeSql(`DELETE FROM patient_contracted_services WHERE patient_id = '${s.patientId}'`);
  cleanupStaffAndGroup(s.user.uid, s.groupId);
  cleanupPatientQA(s.patientId);
}

async function abrirServicioContratado(page: Page, patientId: string): Promise<void> {
  await page.goto(`/admin/patients/${patientId}`);
  await expect(page.getByTestId(TAB_BAR)).toBeVisible({ timeout: 20_000 });
  await page.getByTestId(TAB_BAR).getByRole('button', { name: 'Servicio Contratado', exact: true }).click();
  await expect(page.getByTestId('patient-vacancies-card')).toBeVisible({ timeout: 20_000 });
}

const LEITURA: Array<[string, string]> = [
  ['patient', 'read'], ['patient_identity', 'read'], ['patient_coverage', 'read'], ['patient_address', 'read'], ['patient_services', 'read'], ['vacancy', 'read'],
];

test.use({ viewport: { width: 1600, height: 1100 } });

test.describe('Vacante dentro de Servicio Contratado — bloco Vacantes Generadas (spec 047, F4) @integration', () => {
  test.setTimeout(120_000);

  test('feliz — o bloco mostra EN<caso>#01, IGUAL à coluna da tabela de serviços na mesma tela', async ({ page }) => {
    const s = seed('feliz', LEITURA, { vaga: 'com-servico' });
    try {
      await loginAs(page, s.user);
      await abrirServicioContratado(page, s.patientId);
      const bloco = page.getByTestId(`patient-vacancy-code-${s.vacancyId}`);
      const coluna = page.getByTestId(`contracted-service-vacancy-link-${s.serviceId}`);
      await expect(bloco).toHaveText(CODIGO, { timeout: 20_000 });
      await expect(coluna).toHaveText(CODIGO);
      expect(await bloco.innerText()).toBe(await coluna.innerText());
      await expect(page.getByTestId('patient-vacancies-card')).not.toContainText(/CASO \d+-\d+/);
    } finally {
      cleanup(s);
    }
  });

  test('alt 1 — vaga SEM serviço vinculado aparece no bloco (só vacancy:read: a aba mostra só o bloco)', async ({ page }) => {
    const s = seed('sem-servico', [['patient', 'read'], ['vacancy', 'read']], { vaga: 'sem-servico' });
    try {
      expect(scalar(`SELECT count(*) FROM job_postings WHERE id = '${s.vacancyId}' AND contracted_service_id IS NULL`)).toBe('1');
      await loginAs(page, s.user);
      await abrirServicioContratado(page, s.patientId);
      await expect(page.getByTestId(`patient-vacancy-code-${s.vacancyId}`)).toHaveText(CODIGO, { timeout: 20_000 });
      await expect(page.getByTestId('servicos-contratados-card')).toHaveCount(0);
    } finally {
      cleanup(s);
    }
  });

  test('alt 2 — paciente sem vaga: o texto de vazio do bloco', async ({ page }) => {
    const s = seed('sem-vaga', LEITURA, { vaga: 'nenhuma' });
    try {
      await loginAs(page, s.user);
      await abrirServicioContratado(page, s.patientId);
      await expect(page.getByTestId('patient-vacancies-card')).toContainText('Sin vacantes generadas', { timeout: 20_000 });
      await expect(page.locator('[data-testid^="patient-vacancy-code-"]')).toHaveCount(0);
    } finally {
      cleanup(s);
    }
  });
});
