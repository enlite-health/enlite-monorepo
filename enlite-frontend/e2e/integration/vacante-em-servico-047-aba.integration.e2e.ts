/**
 * vacante-em-servico-047-aba.integration.e2e.ts @integration — spec 047, F1: a aba "Vacantes" saiu da ficha
 * do paciente e o bloco "Vacantes Generadas" desceu para a aba "Servicio Contratado", ABAIXO dos serviços.
 *
 * E2E DE TELA, sem mock de resposta: API real + Postgres real, engine ABAC LIGADO, três perfis de verdade
 * (staff em grupo com células concedidas por SQL, login pelo gesto de `loginAs`). Clique humano, nada de fill.
 *
 *  feliz — perfil com `patient_services:read` + `vacancy:read`: NÃO há aba Vacantes; Servicio Contratado mostra os
 *          serviços e, ABAIXO (posição na tela), o bloco com a vaga semeada. A rota de vagas foi pedida.
 *  alt 1 — perfil SEM `vacancy:read`: a aba Servicio Contratado existe com os serviços, o bloco NÃO está no DOM e
 *          `GET /patients/:id/vacancies` NÃO foi pedido (0 requisições observadas na rede).
 *  alt 2 — perfil SÓ com `vacancy:read` (+ `patient:read`): a aba Servicio Contratado existe e mostra SÓ o bloco
 *          da vacante (nenhum card de serviços/cobertura/localizações).
 *
 * ⚠️ Precisa do engine ABAC LIGADO (alt 1 e alt 2 medem AUSÊNCIA por falta de célula; com o engine OFF
 * `cells===null` mostra tudo e ficariam verdes sem medir nada) — por isso o nome entra no `--grep` do job
 * `integration-e2e-group-simulation` do `_frontend-integration.yml` e NÃO no do `pr-gate.yml` (engine OFF).
 *
 * Nenhum canal real: só Postgres. A vaga semeada é `is_test` e já nasce com `social_short_links.site` falso
 * (`https://exemplo.test/x`); nada de WhatsApp, Google, Ana Care ou Short.io.
 *
 * Rodar local = o job do CI: `ABAC_API_URL`, `ABAC_TEST_DB_URL`, `E2E_PG_CONTAINER`, `E2E_BACKEND_URL`, `PW_BASE_URL`.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  seedPatientQA, cleanupPatientQA, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, safeSql, scalar,
  type MockUser,
} from '../helpers/patient-conversation-helper';

const TAB_BAR = 'patient-profile-tabs';
const CASE_NUMBER = 947001;

interface Seeded { patientId: string; groupId: string; user: MockUser; serviceId: string; vacancyId: string }

/** Paciente sintético + 1 serviço + 1 vaga viva ligada ao serviço + staff num grupo AR com as células pedidas. */
function seed(tag: string, cells: Array<[string, string]>): Seeded {
  const run = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const uid = `e2e-v047-${tag}-${run}`;
  const user: MockUser = { uid, email: `${uid}@e2e.test`, role: 'recruiter', country: 'AR' };
  const patientId = seedPatientQA();
  const { groupId } = seedStaffInGroup({ uid, email: user.email, groupName: `E2E Vacante047 ${tag} ${run}`, country: 'AR' });
  for (const [resource, action] of cells) grantCell(groupId, resource, action);
  const serviceId = scalar(`INSERT INTO patient_contracted_services (patient_id, service_code, active, country, created_by, updated_by)
      VALUES ('${patientId}', 'AT', true, 'AR', '${uid}', '${uid}') RETURNING id`);
  const vacancyId = scalar(`INSERT INTO job_postings (
        vacancy_number, case_number, title, description, patient_id, contracted_service_id,
        required_professions, providers_needed, status, is_draft, is_test, country, social_short_links, created_at, updated_at
      ) VALUES (
        nextval('job_postings_vacancy_number_seq'), ${CASE_NUMBER}, 'CASO E2E 047 vaga do servico', '', '${patientId}', '${serviceId}',
        ARRAY['AT']::varchar[], 1, 'SEARCHING', false, true, 'AR', '{"site": "https://exemplo.test/x"}'::jsonb, NOW(), NOW()
      ) RETURNING id`);
  return { patientId, groupId, user, serviceId, vacancyId };
}

function cleanup(s: Seeded): void {
  safeSql(`DELETE FROM job_postings WHERE patient_id = '${s.patientId}'`);
  safeSql(`DELETE FROM patient_contracted_services WHERE patient_id = '${s.patientId}'`);
  cleanupStaffAndGroup(s.user.uid, s.groupId);
  cleanupPatientQA(s.patientId);
}

const VACANCIES_ROUTE = /\/patients\/[^/]+\/vacancies(\?|$)/;

/** Conta, na rede REAL do navegador, os pedidos da lista de vagas do paciente. */
function contarPedidosDeVagas(page: Page): () => number {
  let n = 0;
  page.on('request', (req) => { if (req.method() === 'GET' && VACANCIES_ROUTE.test(req.url())) n += 1; });
  return () => n;
}

async function abrirFicha(page: Page, patientId: string): Promise<void> {
  await page.goto(`/admin/patients/${patientId}`);
  await expect(page.getByTestId(TAB_BAR)).toBeVisible({ timeout: 20_000 });
}

async function abrirServicioContratado(page: Page): Promise<void> {
  const aba = page.getByTestId(TAB_BAR).getByRole('button', { name: 'Servicio Contratado', exact: true });
  await expect(aba).toBeVisible();
  await aba.click();
}

const CELULAS_ADMIN: Array<[string, string]> = [
  ['patient', 'read'], ['patient_identity', 'read'], ['patient_coverage', 'read'], ['patient_address', 'read'],
  ['patient_services', 'read'], ['vacancy', 'read'],
];

test.use({ viewport: { width: 1600, height: 1100 } });

test.describe('Vacante dentro de Servicio Contratado — a aba sai (spec 047, F1) @integration', () => {
  test.setTimeout(120_000);

  test('feliz — não há aba Vacantes; Servicio Contratado mostra os serviços e, ABAIXO, Vacantes Generadas', async ({ page }) => {
    const s = seed('feliz', CELULAS_ADMIN);
    try {
      const pedidos = contarPedidosDeVagas(page);
      await loginAs(page, s.user);
      await abrirFicha(page, s.patientId);

      // A aba Vacante não existe (controle positivo: Servicio Contratado da mesma barra existe).
      const barra = page.getByTestId(TAB_BAR);
      await expect(barra.getByRole('button', { name: 'Servicio Contratado', exact: true })).toBeVisible();
      await expect(barra.getByRole('button', { name: /^Vacantes$/i })).toHaveCount(0);

      await abrirServicioContratado(page);
      const servicos = page.getByTestId('servicos-contratados-card');
      const vagas = page.getByTestId('patient-vacancies-card');
      await expect(servicos).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId(`contracted-service-row-${s.serviceId}`)).toBeVisible();
      await expect(vagas).toBeVisible({ timeout: 20_000 });
      await expect(vagas).toContainText('Vacantes Generadas');
      await expect(vagas).toContainText(String(CASE_NUMBER));

      // ABAIXO: o topo do bloco está depois do fim do card de serviços, na tela.
      const caixaServicos = await servicos.boundingBox();
      const caixaVagas = await vagas.boundingBox();
      expect(caixaServicos && caixaVagas).toBeTruthy();
      expect(caixaVagas!.y).toBeGreaterThanOrEqual(caixaServicos!.y + caixaServicos!.height - 1);
      expect(pedidos(), 'com vacancy:read a lista de vagas foi pedida').toBeGreaterThan(0);
    } finally {
      cleanup(s);
    }
  });

  test('alt 1 — perfil SEM vacancy:read: a aba tem os serviços, o bloco não está no DOM e a rota de vagas não é pedida', async ({ page }) => {
    const s = seed('sem-vacancy', CELULAS_ADMIN.filter(([r]) => r !== 'vacancy'));
    try {
      const pedidos = contarPedidosDeVagas(page);
      await loginAs(page, s.user);
      await abrirFicha(page, s.patientId);
      await abrirServicioContratado(page);

      await expect(page.getByTestId('servicos-contratados-card')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId(`contracted-service-row-${s.serviceId}`)).toBeVisible();
      await expect(page.getByTestId('patient-vacancies-card')).toHaveCount(0);
      await expect(page.getByTestId(TAB_BAR).getByRole('button', { name: /^Vacantes$/i })).toHaveCount(0);
      // Deixa a rede assentar antes de contar: a ficha já carregou e o bloco nunca pediu a lista.
      await page.waitForLoadState('networkidle');
      expect(pedidos(), 'sem vacancy:read, GET /patients/:id/vacancies NÃO é chamado').toBe(0);
    } finally {
      cleanup(s);
    }
  });

  test('alt 2 — perfil SÓ com vacancy:read: a aba Servicio Contratado aparece e mostra só o bloco da vacante', async ({ page }) => {
    const s = seed('so-vacancy', [['patient', 'read'], ['vacancy', 'read']]);
    try {
      await loginAs(page, s.user);
      await abrirFicha(page, s.patientId);
      await abrirServicioContratado(page);

      const vagas = page.getByTestId('patient-vacancies-card');
      await expect(vagas).toBeVisible({ timeout: 20_000 });
      await expect(vagas).toContainText(String(CASE_NUMBER));
      await expect(page.getByTestId('servicos-contratados-card')).toHaveCount(0);
      await expect(page.getByTestId('localizacoes-card')).toHaveCount(0);
      await expect(page.getByTestId('edit-coverage-btn')).toHaveCount(0);
      await expect(page.getByTestId(TAB_BAR).getByRole('button', { name: /^Vacantes$/i })).toHaveCount(0);
    } finally {
      cleanup(s);
    }
  });
});
