/**
 * vacante-em-servico-047-colunas.integration.e2e.ts @integration — spec 047, F3: a tabela de Servicios Contratados
 * ganha a coluna "Vacante" (o código, link para a vaga); o ícone "Ver vacante" sai. A coluna "Enlace del sitio" foi
 * TIRADA no ajuste de 08/10 (em PRD `social_short_links.site` é um objeto `{id,url}` e aparecia como JSON cru).
 *
 * E2E DE TELA, sem mock de resposta: API real + Postgres real, engine ABAC LIGADO, staff real em grupo com células por SQL,
 * clique humano (nada de fill/forceFill). A vaga do cenário já nasce com `social_short_links.site` semeado
 * no formato REAL de PRD (`{"id":"link_x","url":"https://exemplo.test/x"}`) e `is_test`: nenhum WhatsApp, Google, Ana Care nem Short.io.
 *
 *  feliz — admin: o cabeçalho é "Vacante" (uma palavra), NÃO há coluna "Enlace del sitio" nem JSON/URL cru no cartão;
 *          vê `EN{caso}#01`, CLICA e cai na vaga certa (URL + texto do cartão do caso); o serviço com vaga em
 *          RASCUNHO cai em `/borrador` (o detalhe redireciona o rascunho); nenhuma linha tem "Ver vacante".
 *  alt 1 — serviço sem vaga: a coluna mostra "—" e "ativar recrutamento" está lá.
 *  alt 2 — perfil sem `vacancy:read`: a tabela NÃO tem a coluna, e a resposta HTTP real de `GET /patients/:id`
 *          (capturada com `waitForResponse`) traz o serviço com `liveVacancy: null` + `liveVacancyRedacted: true`.
 *
 * ⚠️ ABAC LIGADO obrigatório (alt 2 mede ausência por falta de célula). Casa o `--grep "vacante-em-servico-047"` do job
 * `integration-e2e-group-simulation` (`_frontend-integration.yml`). Rodar local = o job do CI (ver o `-aba`).
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import {
  seedPatientQA, cleanupPatientQA, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, safeSql, scalar,
  type MockUser,
} from '../helpers/patient-conversation-helper';

const TAB_BAR = 'patient-profile-tabs';
const CASE_NUMBER = 947100 + (Date.now() % 800);
const CODIGO = `EN${CASE_NUMBER}#01`;
const SITE = 'https://exemplo.test/x';
/** Formato REAL de PRD: `social_short_links.site` é um objeto `{id,url}`, não uma string. */
const LINKS_PRD = JSON.stringify({ site: { id: 'link_x', url: SITE } });

interface Seeded {
  patientId: string; groupId: string; user: MockUser;
  servicePublished: string; serviceDraft: string; serviceNoVacancy: string; vacancyPublished: string; vacancyDraft: string;
}

function vaga(patientId: string, serviceId: string, ordinal: number, isDraft: boolean, links: string, caseNumber: number | null = null): string {
  // `jp.case_number` só é preenchido na vaga PUBLICADA: é o que a página da vaga lê no cartão do caso (a coluna da ficha lê do PACIENTE).
  return scalar(`INSERT INTO job_postings (vacancy_number, case_number, title, description, patient_id, contracted_service_id, case_ordinal,
        required_professions, providers_needed, status, is_draft, is_test, country, social_short_links, created_at, updated_at)
      VALUES (nextval('job_postings_vacancy_number_seq'), ${caseNumber ?? 'NULL'}, 'CASO E2E 047 col ${ordinal}', '', '${patientId}', '${serviceId}', ${ordinal},
        ARRAY['AT']::varchar[], 1, 'SEARCHING', ${isDraft}, true, 'AR', '${links}'::jsonb, NOW(), NOW()) RETURNING id`);
}

/** Paciente (com `case_number` próprio) + 3 serviços (vaga publicada / vaga em rascunho / sem vaga) + staff com as células. */
function seed(tag: string, cells: Array<[string, string]>, opts: { comVagas: boolean }): Seeded {
  const run = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const uid = `e2e-v047c-${tag}-${run}`;
  const user: MockUser = { uid, email: `${uid}@e2e.test`, role: 'recruiter', country: 'AR' };
  const patientId = seedPatientQA();
  safeSql(`UPDATE patients SET case_number = ${CASE_NUMBER} WHERE id = '${patientId}'`);
  const { groupId } = seedStaffInGroup({ uid, email: user.email, groupName: `E2E Vacante047c ${tag} ${run}`, country: 'AR' });
  for (const [resource, action] of cells) grantCell(groupId, resource, action);
  const novo = (): string => scalar(`INSERT INTO patient_contracted_services (patient_id, service_code, active, country, created_by, updated_by)
      VALUES ('${patientId}', 'AT', true, 'AR', '${uid}', '${uid}') RETURNING id`);
  const servicePublished = novo();
  const serviceDraft = opts.comVagas ? novo() : '';
  const serviceNoVacancy = opts.comVagas ? '' : novo();
  const vacancyPublished = opts.comVagas ? vaga(patientId, servicePublished, 1, false, LINKS_PRD, CASE_NUMBER) : '';
  const vacancyDraft = opts.comVagas ? vaga(patientId, serviceDraft, 2, true, '{}') : '';
  return { patientId, groupId, user, servicePublished, serviceDraft, serviceNoVacancy, vacancyPublished, vacancyDraft };
}

function cleanup(s: Seeded): void {
  safeSql(`DELETE FROM job_postings WHERE patient_id = '${s.patientId}'`);
  safeSql(`DELETE FROM patient_contracted_services WHERE patient_id = '${s.patientId}'`);
  cleanupStaffAndGroup(s.user.uid, s.groupId);
  cleanupPatientQA(s.patientId);
}

const CELULAS_LEITURA: Array<[string, string]> = [
  ['patient', 'read'], ['patient_identity', 'read'], ['patient_coverage', 'read'], ['patient_address', 'read'], ['patient_services', 'read'],
];

async function abrirServicioContratado(page: Page): Promise<void> {
  await expect(page.getByTestId(TAB_BAR)).toBeVisible({ timeout: 20_000 });
  const aba = page.getByTestId(TAB_BAR).getByRole('button', { name: 'Servicio Contratado', exact: true });
  await expect(aba).toBeVisible();
  await aba.click();
  await expect(page.getByTestId('servicos-contratados-card')).toBeVisible({ timeout: 20_000 });
}

/** Print-chave da tabela (evidência da F3): só grava com `E2E_EVIDENCE_DIR`. */
async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_EVIDENCE_DIR;
  if (!dir) return;
  await page.waitForTimeout(400);
  await page.getByTestId('servicos-contratados-card').screenshot({ path: path.join(dir, `${name}.png`) });
}

const cabecalho = (page: Page, nome: string) => page.getByRole('columnheader', { name: nome, exact: true });

test.use({ viewport: { width: 1600, height: 1100 } });

test.describe('Vacante dentro de Servicio Contratado — colunas (spec 047, F3) @integration', () => {
  test.setTimeout(150_000);

  test('feliz — admin vê o cabeçalho "Vacante" e nenhuma coluna de link; CLICA no código e cai na vaga certa; rascunho cai em /borrador', async ({ page }) => {
    const s = seed('feliz', [...CELULAS_LEITURA, ['vacancy', 'read']], { comVagas: true });
    try {
      await loginAs(page, s.user);
      await page.goto(`/admin/patients/${s.patientId}`);
      await abrirServicioContratado(page);

      await expect(cabecalho(page, 'Vacante')).toBeVisible();
      await expect(cabecalho(page, 'Código de la vacante')).toHaveCount(0);
      await expect(cabecalho(page, 'Enlace del sitio')).toHaveCount(0);
      const codigo = page.getByTestId(`contracted-service-vacancy-link-${s.servicePublished}`);
      await expect(codigo).toHaveText(CODIGO, { timeout: 20_000 });
      // Sem coluna de link: nem a célula, nem o botão de copiar, nem o objeto {id,url} cru do PRD vazando para a tela.
      await expect(page.getByTestId(`contracted-service-site-link-${s.servicePublished}`)).toHaveCount(0);
      await expect(page.getByTestId(`contracted-service-copy-link-${s.servicePublished}`)).toHaveCount(0);
      await expect(page.getByTestId('servicos-contratados-card')).not.toContainText('link_x');
      await expect(page.getByTestId('servicos-contratados-card')).not.toContainText(SITE);
      // A5: o ícone antigo não existe em linha nenhuma.
      await expect(page.getByTestId(`contracted-service-view-vacancy-${s.servicePublished}`)).toHaveCount(0);
      await expect(page.getByTestId('servicos-contratados-card')).not.toContainText('Ver vacante');
      await shot(page, 'f3-admin-com-colunas');

      // Clicar no código: cai na vaga CERTA (URL com o id semeado + o cartão do caso com o número do caso).
      await codigo.click();
      await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${s.vacancyPublished}$`), { timeout: 20_000 });
      await expect(page.getByTestId('vacancy-case-card')).toContainText(`CASO EN${CASE_NUMBER}`, { timeout: 20_000 });

      // Rascunho: o MESMO link; o detalhe da vaga redireciona o rascunho para a tela própria.
      await page.goto(`/admin/patients/${s.patientId}`);
      await abrirServicioContratado(page);
      await page.getByTestId(`contracted-service-vacancy-link-${s.serviceDraft}`).click();
      await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${s.vacancyDraft}/borrador$`), { timeout: 20_000 });
      await expect(page.getByTestId('draft-vacancy-callout')).toBeVisible({ timeout: 20_000 });
    } finally {
      cleanup(s);
    }
  });

  test('alt 1 — serviço SEM vaga: a coluna mostra "—" e "ativar recrutamento" está lá', async ({ page }) => {
    const s = seed('sem-vaga', [...CELULAS_LEITURA, ['vacancy', 'read'], ['vacancy', 'update'], ['patient_services', 'update']], { comVagas: false });
    try {
      await loginAs(page, s.user);
      await page.goto(`/admin/patients/${s.patientId}`);
      await abrirServicioContratado(page);

      await expect(cabecalho(page, 'Vacante')).toBeVisible();
      await expect(page.getByTestId(`contracted-service-vacancy-code-${s.serviceNoVacancy}`)).toHaveText('—', { timeout: 20_000 });
      await expect(page.getByTestId(`contracted-service-vacancy-link-${s.serviceNoVacancy}`)).toHaveCount(0);
      await expect(page.getByTestId(`contracted-service-activate-recruitment-${s.serviceNoVacancy}`)).toBeVisible();
    } finally {
      cleanup(s);
    }
  });

  test('alt 2 — perfil SEM vacancy:read: a tabela não tem a coluna e a resposta HTTP real vem com a vaga redigida', async ({ page }) => {
    const s = seed('sem-celula', CELULAS_LEITURA, { comVagas: true });
    try {
      await loginAs(page, s.user);
      const ficha = page.waitForResponse((r) => r.request().method() === 'GET' && r.url().endsWith(`/api/admin/patients/${s.patientId}`));
      await page.goto(`/admin/patients/${s.patientId}`);
      const resposta = await ficha;
      expect(resposta.status()).toBe(200);
      const corpo = await resposta.json();
      const servicos = corpo.data.contractedServices as Array<{ id: string; liveVacancy: unknown; liveVacancyRedacted: boolean }>;
      const comVaga = servicos.find((x) => x.id === s.servicePublished)!;
      // O serviço TEM vaga no banco (semeada) — a redação é do ator, não "sem vaga".
      expect(scalar(`SELECT count(*) FROM job_postings WHERE contracted_service_id = '${s.servicePublished}'`)).toBe('1');
      expect(comVaga.liveVacancy).toBeNull();
      expect(comVaga.liveVacancyRedacted).toBe(true);
      expect(JSON.stringify(corpo)).not.toContain(SITE);
      expect(JSON.stringify(corpo)).not.toContain(s.vacancyPublished);

      await abrirServicioContratado(page);
      await expect(page.getByTestId(`contracted-service-row-${s.servicePublished}`)).toBeVisible({ timeout: 20_000 });
      await expect(cabecalho(page, 'Vacante')).toHaveCount(0);
      await expect(cabecalho(page, 'Enlace del sitio')).toHaveCount(0);
      await expect(page.getByTestId(`contracted-service-vacancy-code-${s.servicePublished}`)).toHaveCount(0);
      await expect(page.getByTestId(`contracted-service-site-link-${s.servicePublished}`)).toHaveCount(0);
      await expect(page.getByTestId(`contracted-service-activate-recruitment-${s.servicePublished}`)).toHaveCount(0);
      await shot(page, 'f3-sem-celula-sem-colunas');
    } finally {
      cleanup(s);
    }
  });
});
