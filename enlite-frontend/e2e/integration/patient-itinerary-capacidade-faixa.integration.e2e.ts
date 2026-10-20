/**
 * patient-itinerary-capacidade-faixa.integration.e2e.ts @integration — 058b/B2 (T250): CAPACIDADE da faixa
 * (`providers_needed`: N prestadores por faixa) pela aba Itinerario, exercitada por um HUMANO contra o stack REAL
 * (frontend + API + Postgres), sem interceptar rota e sem mock de dado de negócio — só a auth é o mock do stack (`loginAs`).
 *
 * Side-effect outbound mapeado ANTES de clicar: `allocate` (`ItineraryAllocationUseCase`) só escreve em Postgres
 * (alocação, montagem, derivação de estado) — nenhum import de Twilio/Periskope/Talentum/Ana Care/ClickUp/e-mail/fila no
 * caminho. Mesmo assim cada teste registra todo host que a PÁGINA pede e exige que nenhum seja de canal real
 * (`CADEIA_FORBIDDEN_HOSTS`).
 *
 * A semente (paciente derivável, prestadores em Selecionado, `providers_needed`) usa os helpers da derivação; o que é
 * PROVADO (Agregar / recusa / faixa cheia) passa só pela tela. O nome do arquivo casa o `--grep patient-itinerary`.
 *
 * Os 3 testes:
 *   1. FELIZ — providers_needed = 2, 2 prestadores na mesma faixa → o card mostra os 2;
 *   2. ALTERNATIVO 1 (servidor recusa) — outro agente aloca o 2º por API com a tela desatualizada → 422 + orientação + recarrega;
 *   3. ALTERNATIVO 2 (UI) — faixa cheia → sem "Agregar", com a orientação (e controle de instrumento).
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { mockAdminUserFor, useLancamentoStaff, LANCAMENTO_VIEWPORT_ES_AR } from '../helpers/lancamento-e2e-helper';
import { loginAs } from '../helpers/abac-stack-helper';
import { openItineraryTab } from '../helpers/itinerario-aba-e2e-helper';
import { seedDerivablePatient, selectedWorker, allocateWorker } from '../helpers/derivacao-e2e-helper';
import { sqlComVars } from '../helpers/sql-com-vars';
import { CADEIA_FORBIDDEN_HOSTS } from '../helpers/cadeia-completa-e2e-helper';

const STAFF = mockAdminUserFor('itinerario-capacidade');

/** 1 serviço de 4 h/semana com UMA faixa de 4 h. */
const QUATRO_HORAS = { schedule: [{ dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 }] };

/** 1 serviço de 4 h com UMA faixa; `providers_needed` explícito (a stage tem 10 de 11 NULL) e `n` prestadores em Selecionado. */
async function semearFaixa(request: APIRequestContext, providersNeeded: number, selecionados: number) {
  const seed = await seedDerivablePatient(request, { status: 'SEARCHING', services: [QUATRO_HORAS] });
  const [svc] = seed.services;
  sqlComVars("UPDATE patient_contracted_services SET providers_needed = :'n'::int WHERE id = :'id'::uuid", { n: String(providersNeeded), id: svc.serviceId });
  const workers = Array.from({ length: selecionados }, () => selectedWorker(seed, svc.vacancyId));
  return { seed, serviceId: svc.serviceId, slotId: svc.slotIds[0], vacancyId: svc.vacancyId, workers };
}

function vigiarHosts(page: Page): () => string[] {
  const hosts: string[] = [];
  page.on('request', (r) => hosts.push(new URL(r.url()).hostname));
  return () => hosts.filter((h) => CADEIA_FORBIDDEN_HOSTS.test(h));
}

/** Alocações ACTIVE do serviço (count; `valid_to` não filtra: ACTIVE é o que a faixa mostra). */
function vigentes(serviceId: string): number {
  return Number(
    sqlComVars(
      "SELECT count(*) FROM patient_itinerary_assignment a JOIN patient_itinerary_slot s ON s.id = a.slot_id WHERE s.contracted_service_id = :'svc'::uuid AND a.status = 'ACTIVE'",
      { svc: serviceId },
    ),
  );
}

test.describe('patient-itinerary-capacidade-faixa: N prestadores por faixa pela tela @integration', () => {
  test.use({ ...LANCAMENTO_VIEWPORT_ES_AR, deviceScaleFactor: 1 });
  test.setTimeout(150_000);
  useLancamentoStaff(STAFF, 'E2E Itinerario Capacidade');

  test('FELIZ: providers_needed = 2, 2 prestadores alocados na mesma faixa → o card mostra os 2', async ({ page, request }) => {
    const proibidos = vigiarHosts(page);
    const f = await semearFaixa(request, 2, 2);
    try {
      const [w1, w2] = f.workers;
      for (const w of [w1, w2]) {
        const r = await allocateWorker(request, f.seed.patientId, f.serviceId, f.slotId, w);
        expect(r.status, `allocate ${r.status} ${r.code ?? ''}`).toBe(201);
      }
      await loginAs(page, STAFF);
      await openItineraryTab(page, f.seed.patientId);
      await expect(page.getByTestId(`itinerario-slot-prestador-${f.slotId}-${w1}`)).toBeVisible();
      await expect(page.getByTestId(`itinerario-slot-prestador-${f.slotId}-${w2}`)).toBeVisible();
      expect(vigentes(f.serviceId)).toBe(2);
      expect(proibidos()).toEqual([]);
    } finally {
      f.seed.cleanup();
    }
  });

  test('ALTERNATIVO 1 (servidor recusa): outro agente aloca o 2º por API com a tela ainda mostrando "Agregar" → 422 ITINERARY_SLOT_CAPACITY_EXCEEDED → orientação e recarrega', async ({ page, request }) => {
    const proibidos = vigiarHosts(page);
    const f = await semearFaixa(request, 2, 3);
    try {
      const [a, b, c] = f.workers;
      const alocA = await allocateWorker(request, f.seed.patientId, f.serviceId, f.slotId, a);
      expect(alocA.status, `allocate A ${alocA.status} ${alocA.code ?? ''}`).toBe(201);

      await loginAs(page, STAFF);
      await openItineraryTab(page, f.seed.patientId);
      await page.getByTestId(`itinerario-slot-editar-${f.slotId}`).click();
      await expect(page.getByTestId('itinerario-editar-prestador')).toBeVisible(); // há vaga: 1 de 2
      await page.getByTestId(`itinerario-editar-selecionar-${b}`).click();

      // Por fora: outro agente ocupa a 2ª vaga enquanto a tela ainda mostra "Agregar".
      const alocC = await allocateWorker(request, f.seed.patientId, f.serviceId, f.slotId, c);
      expect(alocC.status, `allocate C ${alocC.status} ${alocC.code ?? ''}`).toBe(201);

      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'POST' && /\/slots\/[^/]+\/allocations$/.test(r.url())),
        page.getByTestId('itinerario-editar-guardar').click(),
      ]);
      expect(resp.status()).toBe(422);
      expect((await resp.json()).code).toBe('ITINERARY_SLOT_CAPACITY_EXCEEDED');

      await expect(page.getByTestId('itinerario-acao-erro')).toContainText('La franja ya tiene todos los prestadores que necesita el servicio');
      await expect(page.getByTestId(`itinerario-slot-prestador-${f.slotId}-${a}`)).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId(`itinerario-slot-prestador-${f.slotId}-${c}`)).toBeVisible();
      await expect(page.getByTestId(`itinerario-slot-prestador-${f.slotId}-${b}`)).toHaveCount(0);

      // Reabrir a faixa: agora está cheia.
      if (await page.getByTestId('itinerario-editar-modal').count()) {
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('itinerario-editar-modal')).toHaveCount(0);
      }
      await page.getByTestId(`itinerario-slot-editar-${f.slotId}`).click();
      await expect(page.getByTestId('itinerario-faixa-cheia')).toBeVisible();

      expect(vigentes(f.serviceId)).toBe(2);
      const deB = Number(
        sqlComVars(
          "SELECT count(*) FROM patient_itinerary_assignment a JOIN patient_itinerary_slot s ON s.id = a.slot_id WHERE s.contracted_service_id = :'svc'::uuid AND a.worker_id = :'w'::uuid",
          { svc: f.serviceId, w: b },
        ),
      );
      expect(deB).toBe(0);
      expect(proibidos()).toEqual([]);
    } finally {
      f.seed.cleanup();
    }
  });
});
