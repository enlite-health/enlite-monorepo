/**
 * servico-dados-recrutamento-capacidade.integration.e2e.ts @integration — spec 058 B, Trava B no formulário do serviço
 * (`providers_needed` não pode ficar abaixo das alocações nem ser limpo depois de informado).
 *
 * Backend real + Postgres real + frontend real. Só o login é mock (stack de CI). Dado sintético.
 * O nome contém `servico-dados-recrutamento`, token que o `grep:` do `pr-gate.yml` já roda no projeto `integration`.
 *
 *  1. feliz: 3 → 4 grava (3 alocações cabem em 4);
 *  2. alt (servidor recusa): 3 → 2 com 3 alocações → 422 PROVIDERS_NEEDED_BELOW_OCCUPANCY com mensagem; o banco segue 3;
 *  3. alt (servidor recusa): limpar o campo já informado → 422 PROVIDERS_NEEDED_CANNOT_CLEAR com mensagem; o banco segue 3;
 *  4. controle: com a vaga VIVA, limpar dá OUTRO 422 (SERVICE_FIELD_REQUIRED_BY_LIVE_VACANCY), não o da Trava B.
 */
import { test, expect, type Page } from '@playwright/test';
import { seedItinerary, cleanupItinerary, type ItinerarySeed } from '../helpers/itinerary-db-helper';
import { sqlComVars } from '../helpers/sql-com-vars';
import { loginComoStaffMock } from '../helpers/login-mock-staff';
import { type MockUser } from '../helpers/abac-stack-helper';

const STAFF: MockUser = { uid: `e2e-servico-capacidade-${Date.now()}`, email: `e2e.servico-capacidade.${Date.now()}@enlite.health`, role: 'admin', country: 'AR' };
const ABA_SERVICO = 'Servicio Contratado';

/** Aloca `workerId` na faixa do seed (mesmo INSERT de `seedTitularAllocation`, `itinerary-db-helper.ts:130-138`, agora parametrizado). */
function alocarPorSql(seed: ItinerarySeed, workerId: string): void {
  const applicationId = sqlComVars(`SELECT id FROM worker_job_applications WHERE worker_id = :'wid' AND job_posting_id = :'jid'`, { wid: workerId, jid: seed.jobId });
  sqlComVars(
    `INSERT INTO patient_itinerary_assignment (slot_id, worker_id, application_id, valid_from, status, created_by, updated_by)
     VALUES (:'slot', :'wid', :'app', (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date, 'ACTIVE', 'e2e-capacidade', 'e2e-capacidade')`,
    { slot: seed.slotId, wid: workerId, app: applicationId },
  );
}

/** Serviço com `providers_needed = 3` e 3 alocações na faixa (limite = ocupação). `vagaViva: false` (padrão) apaga a vaga DEPOIS das alocações:
 *  sem vaga viva, os 422 são da Trava B e não da guarda "vaga viva lê este campo" (`SERVICE_FIELD_REQUIRED_BY_LIVE_VACANCY`).
 *  `vagaViva: true` deixa a vaga viva — é o CONTROLE do teste 4. */
function semearCapacidade(opts: { vagaViva?: boolean } = {}): ItinerarySeed {
  const seed = seedItinerary();
  sqlComVars(`UPDATE patient_contracted_services SET providers_needed = 3 WHERE id = :'sid'`, { sid: seed.serviceId });
  for (const w of [seed.titularWorkerId, seed.permanentWorkerId, seed.freeSubstituteWorkerId]) alocarPorSql(seed, w);
  if (!opts.vagaViva) sqlComVars(`UPDATE job_postings SET deleted_at = now() WHERE id = :'jid'`, { jid: seed.jobId });
  return seed;
}

async function abrirFormularioDoServico(page: Page, seed: ItinerarySeed): Promise<void> {
  await page.goto(`/admin/patients/${seed.patientId}`);
  await page.getByTestId('patient-profile-tabs').getByRole('button', { name: ABA_SERVICO }).click();
  await expect(page.getByTestId(`contracted-service-row-${seed.serviceId}`)).toBeVisible({ timeout: 20_000 });
  await page.getByTestId(`contracted-service-edit-${seed.serviceId}`).click();
  await expect(page.getByTestId(`contracted-service-form-${seed.serviceId}`)).toBeVisible({ timeout: 15_000 });
}

/** Gesto humano no campo numérico: clique, seleciona tudo (`ControlOrMeta+A`, o mesmo de `insurance-058a-helper.ts:151`) e digita; `texto` vazio = só apaga a seleção. */
async function trocarQuantidade(page: Page, texto: string): Promise<void> {
  const campo = page.getByTestId('svc-providersNeeded-1');
  await campo.click();
  await page.keyboard.press('ControlOrMeta+A');
  if (texto) await page.keyboard.type(texto);
  else await page.keyboard.press('Backspace');
}

test.describe('servico-dados-recrutamento-capacidade — Trava B no formulário do serviço (058 B) @integration', () => {
  test.setTimeout(150_000);

  let seed: ItinerarySeed;
  test.beforeEach(() => { seed = semearCapacidade(); });
  test.afterEach(() => cleanupItinerary(seed));

  test('1. feliz — 3 → 4 grava (3 alocações cabem em 4)', async ({ page }) => {
    await loginComoStaffMock(page, STAFF, 'E2E Capacidade');
    await abrirFormularioDoServico(page, seed);
    await expect(page.getByTestId('svc-providersNeeded-1')).toHaveValue('3');
    await trocarQuantidade(page, '4');
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'PATCH' && new RegExp(`/contracted-services/${seed.serviceId}$`).test(r.url())),
      page.getByTestId(`contracted-service-save-${seed.serviceId}`).click(),
    ]);
    expect(resp.status()).toBe(200);
    expect(sqlComVars(`SELECT coalesce(providers_needed::text, '<null>') FROM patient_contracted_services WHERE id = :'sid'`, { sid: seed.serviceId })).toBe('4');
  });
});
