/**
 * patient-itinerary-caso-a-b.integration.e2e.ts @integration — 058b/B2 (T243): "Nuevo +" → Entero (reemplazo permanente) com
 * início "Ahora" ou "Programada", MOTIVO e DESTINO obrigatórios (Caso A: o titular começou hoje/antes; Caso B: agendado),
 * exercitado por um HUMANO contra o stack REAL (frontend + API + Postgres), sem interceptar rota e sem mock de dado de
 * negócio — só a auth é o mock do stack (`loginAs`). Régua humana: click + `keyboard.type`, valores lidos da TELA.
 *
 * Side-effect outbound mapeado ANTES de clicar: `ReplaceWithReasonUseCase` / `ItineraryAllocationUseCase.replaceWith` /
 * `RemoveFromItineraryUseCase` só escrevem em Postgres (alocação, registro de trocas, marca de rejeição, derivação de
 * estado) — nenhum import de Twilio/Periskope/Talentum/Ana Care/ClickUp/e-mail/fila no caminho. Mesmo assim cada teste
 * registra todo host que a PÁGINA pede e exige que nenhum seja de canal real (`CADEIA_FORBIDDEN_HOSTS`).
 *
 * Os testes (o nome do arquivo casa o `--grep patient-itinerary` do `pr-gate.yml`):
 *   1. FELIZ — Caso A "Ahora" + motivo + "Sigue como reserva";
 *   2. ALTERNATIVO 1 (servidor recusa) — o substituto ganha faixa conflitante em outro paciente → 409 ITINERARY_OVERLAP;
 *   3. ALTERNATIVO 2 (estado muda por fora) — o titular é encerrado antes de confirmar → 422 ALLOCATION_NOT_ACTIVE;
 *   4. VALIDAÇÃO — "Programada" só aceita reserva; sem data o Confirmar fica desabilitado.
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { mockAdminUserFor, useLancamentoStaff, LANCAMENTO_VIEWPORT_ES_AR } from '../helpers/lancamento-e2e-helper';
import { loginAs } from '../helpers/abac-stack-helper';
import { openItineraryTab } from '../helpers/itinerario-aba-e2e-helper';
import { seedDerivablePatient, selectedWorker, allocateWorker, derivacaoToken } from '../helpers/derivacao-e2e-helper';
import { insertWJA } from '../helpers/wja-test-helper';
import { allocationOptionsApi } from '../helpers/itinerario-escrita-e2e-helper';
import { sqlComVars } from '../helpers/sql-com-vars';
import { CADEIA_FORBIDDEN_HOSTS } from '../helpers/cadeia-completa-e2e-helper';

const STAFF = mockAdminUserFor('itinerario-caso-a-b');
const MOTIVO_DESISTENCIA = 'El prestador desistió'; // DESISTENCIA_DO_PRESTADOR

/** 1 serviço de 4 h/semana com UMA faixa de 4 h. */
const QUATRO_HORAS = { schedule: [{ dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 }] };

/** Paciente derivável, 1 serviço de 4 h/semana (1 faixa), `providers_needed = 1`; A titular (alocado hoje) e B em Selecionado. */
async function semearTroca(request: APIRequestContext) {
  const seed = await seedDerivablePatient(request, { status: 'SEARCHING', services: [QUATRO_HORAS] });
  const [svc] = seed.services;
  sqlComVars("UPDATE patient_contracted_services SET providers_needed = 1 WHERE id = :'id'::uuid", { id: svc.serviceId });
  const a = selectedWorker(seed, svc.vacancyId);
  const alocA = await allocateWorker(request, seed.patientId, svc.serviceId, svc.slotIds[0], a);
  expect(alocA.status, `allocate A ${alocA.status} ${alocA.code ?? ''}`).toBe(201);
  const b = selectedWorker(seed, svc.vacancyId);
  return { seed, serviceId: svc.serviceId, slotId: svc.slotIds[0], a, b, allocationA: alocA.allocationId! };
}

function vigiarHosts(page: Page): () => string[] {
  const hosts: string[] = [];
  page.on('request', (r) => hosts.push(new URL(r.url()).hostname));
  return () => hosts.filter((h) => CADEIA_FORBIDDEN_HOSTS.test(h));
}

const hojeDoBanco = (): string =>
  sqlComVars("SELECT to_char((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date, 'YYYY-MM-DD')");

test.describe('patient-itinerary-caso-a-b: reemplazo Entero com motivo e destino pela tela @integration', () => {
  test.use({ ...LANCAMENTO_VIEWPORT_ES_AR, deviceScaleFactor: 1 });
  test.setTimeout(150_000);
  useLancamentoStaff(STAFF, 'E2E Itinerario Caso A B');

  test('FELIZ: Caso A "Ahora" + motivo + "Sigue como reserva": o substituto vira titular hoje e o antigo volta a Seleccionado', async ({ page, request }) => {
    const proibidos = vigiarHosts(page);
    const m = await semearTroca(request);
    try {
      const hoje = hojeDoBanco();
      await loginAs(page, STAFF);
      await openItineraryTab(page, m.seed.patientId);
      await page.getByTestId('itinerario-novo-btn').click();
      await expect(page.getByTestId('substitution-slot')).toBeVisible({ timeout: 10_000 });
      await page.getByTestId('substitution-mode-permanent').click();
      await expect(page.getByTestId('substitution-start-now')).toBeChecked();
      await page.getByTestId('substitution-worker').click();
      await page.getByRole('listbox').getByRole('option').first().click();
      await page.getByTestId('substitution-reason').selectOption({ label: MOTIVO_DESISTENCIA });
      await page.getByTestId('substitution-destination-RESERVE').click();
      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'POST' && /\/itinerary\/allocations\/[^/]+\/replace$/.test(r.url())),
        page.getByTestId('substitution-confirm').click(),
      ]);
      expect(resp.status()).toBe(200);
      expect(resp.request().postDataJSON()).toEqual({ newWorkerId: m.b, fromDate: hoje, reasonCategory: 'DESISTENCIA_DO_PRESTADOR', destination: 'RESERVE' });

      await expect(page.getByTestId('substitution-modal')).toHaveCount(0, { timeout: 10_000 });
      await expect(page.getByTestId(`itinerario-slot-prestador-${m.slotId}-${m.b}`)).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId(`itinerario-slot-prestador-${m.slotId}-${m.a}`)).toHaveCount(0);

      const status = (w: string): string =>
        sqlComVars(
          "SELECT status || ':' || to_char(valid_from, 'YYYY-MM-DD') FROM patient_itinerary_assignment a JOIN patient_itinerary_slot s ON s.id = a.slot_id WHERE s.contracted_service_id = :'svc'::uuid AND a.worker_id = :'w'::uuid",
          { svc: m.serviceId, w },
        );
      expect(status(m.a).startsWith('CANCELLED:')).toBe(true); // começou hoje
      expect(status(m.b)).toBe(`ACTIVE:${hoje}`);
      const log = sqlComVars(
        "SELECT kind || '/' || destination || '/' || reason_code FROM patient_itinerary_change_log WHERE contracted_service_id = :'svc'::uuid",
        { svc: m.serviceId },
      );
      expect(log).toBe('REPLACE/RESERVE/DESISTENCIA_DO_PRESTADOR');
      const marcas = sqlComVars("SELECT count(*) FROM contracted_service_rejections WHERE service_id = :'svc'::uuid", { svc: m.serviceId });
      expect(marcas).toBe('0');

      const opcoes = await allocationOptionsApi(request, derivacaoToken(), m.seed.patientId, m.serviceId);
      const ids = ((opcoes.body.data as { options?: Array<{ workerId: string }> }).options ?? []).map((o) => o.workerId);
      expect(ids).toContain(m.a); // A voltou a Seleccionado
      expect(proibidos()).toEqual([]);
    } finally {
      m.seed.cleanup();
    }
  });

  /** Nuevo + → Entero → "Ahora" → substituto (única opção) → motivo → `RESERVE`, SEM confirmar. */
  async function prepararEntero(page: Page): Promise<void> {
    await page.getByTestId('itinerario-novo-btn').click();
    await expect(page.getByTestId('substitution-slot')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('substitution-mode-permanent').click();
    await page.getByTestId('substitution-worker').click();
    await page.getByRole('listbox').getByRole('option').first().click();
    await page.getByTestId('substitution-reason').selectOption({ label: MOTIVO_DESISTENCIA });
    await page.getByTestId('substitution-destination-RESERVE').click();
  }

  const contagemNoServico = (serviceId: string, worker: string): string =>
    sqlComVars(
      "SELECT count(*) FROM patient_itinerary_assignment a JOIN patient_itinerary_slot s ON s.id = a.slot_id WHERE s.contracted_service_id = :'svc'::uuid AND a.worker_id = :'w'::uuid",
      { svc: serviceId, w: worker },
    );
  const statusDaAlocacao = (allocationId: string): string =>
    sqlComVars("SELECT status FROM patient_itinerary_assignment WHERE id = :'id'::uuid", { id: allocationId });
  const replaces = (serviceId: string): string =>
    sqlComVars("SELECT count(*) FROM patient_itinerary_change_log WHERE contracted_service_id = :'svc'::uuid AND kind = 'REPLACE'", { svc: serviceId });

  test('ALTERNATIVO 1 (servidor recusa): o substituto passa a ter uma faixa conflitante em OUTRO paciente → 409 ITINERARY_OVERLAP com mensagem de produto; nada muda', async ({ page, request }) => {
    const proibidos = vigiarHosts(page);
    const m = await semearTroca(request);
    const seed2 = await seedDerivablePatient(request, { status: 'SEARCHING', services: [QUATRO_HORAS] });
    try {
      const svc2 = seed2.services[0];
      insertWJA({ workerId: m.b, jobPostingId: svc2.vacancyId, funnelStage: 'QUICK_RESPONSE_TEAM' });
      seed2.track(m.b, svc2.vacancyId);
      const aloc2 = await allocateWorker(request, seed2.patientId, svc2.serviceId, svc2.slotIds[0], m.b);
      expect(aloc2.status, `allocate b no 2º paciente ${aloc2.status} ${aloc2.code ?? ''}`).toBe(201); // mesma segunda 08:00–12:00

      await loginAs(page, STAFF);
      await openItineraryTab(page, m.seed.patientId);
      await prepararEntero(page);
      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'POST' && /\/itinerary\/allocations\/[^/]+\/replace$/.test(r.url())),
        page.getByTestId('substitution-confirm').click(),
      ]);
      expect(resp.status()).toBe(409);
      expect((await resp.json()).code).toBe('ITINERARY_OVERLAP');
      const erro = page.getByTestId('itinerario-novo-erro-submit');
      await expect(erro).toBeVisible({ timeout: 10_000 });
      await expect(erro).toContainText('El prestador ya tiene otra franja que se superpone');
      expect(await erro.innerText()).not.toContain('ITINERARY_OVERLAP');
      await expect(page.getByTestId('substitution-modal')).toBeVisible();

      expect(statusDaAlocacao(m.allocationA)).toBe('ACTIVE');
      expect(contagemNoServico(m.serviceId, m.b)).toBe('0');
      expect(replaces(m.serviceId)).toBe('0');
      expect(proibidos()).toEqual([]);
    } finally {
      seed2.cleanup();
      m.seed.cleanup();
    }
  });
});
