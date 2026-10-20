/**
 * patient-itinerary-tirar-agendado.integration.e2e.ts @integration — 058b/B2 (T245): "Quitar del itinerario" de quem tem atendimento
 * agendado (é SUBSTITUTO em datas futuras): o 1º `POST …/end` volta 409 com as datas, a tela mostra o aviso, e só a confirmação
 * reenvia com `cancelScheduled: true`. Exercitado por um HUMANO contra o stack REAL (frontend + API + Postgres), sem interceptar rota
 * e sem mock de dado de negócio — só a auth é o mock do stack (`loginAs`). Valores lidos da TELA.
 *
 * Side-effect outbound mapeado ANTES de clicar: `RemoveFromItineraryUseCase` só escreve em Postgres (alocação, ausência, registro de
 * trocas, marca de rejeição, derivação de estado) — nenhum import de Twilio/Periskope/Talentum/Ana Care/ClickUp/e-mail/fila no caminho.
 * Mesmo assim cada teste registra todo host que a PÁGINA pede e exige que nenhum seja de canal real (`CADEIA_FORBIDDEN_HOSTS`).
 *
 * Os testes (o nome do arquivo casa o `--grep patient-itinerary` do `pr-gate.yml`):
 *   1. FELIZ — aviso com as datas → confirmar → 2 dias descobertos, A segue titular;
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { mockAdminUserFor, useLancamentoStaff, LANCAMENTO_VIEWPORT_ES_AR } from '../helpers/lancamento-e2e-helper';
import { loginAs } from '../helpers/abac-stack-helper';
import { openItineraryTab } from '../helpers/itinerario-aba-e2e-helper';
import { seedDerivablePatient, selectedWorker, allocateWorker } from '../helpers/derivacao-e2e-helper';
import { sqlComVars } from '../helpers/sql-com-vars';
import { CADEIA_FORBIDDEN_HOSTS } from '../helpers/cadeia-completa-e2e-helper';

const STAFF = mockAdminUserFor('itinerario-tirar-agendado');
const MOTIVO_DESISTENCIA = 'El prestador desistió'; // DESISTENCIA_DO_PRESTADOR

/** Segunda e quarta, 4 h cada. */
const DUAS_FAIXAS = {
  schedule: [
    { dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 },
    { dayOfWeek: 3, startTime: '08:00', durationMinutes: 240 },
  ],
};

const HOJE_SQL = "(now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date";

/** `YYYY-MM-DD` → `DD/MM` (só split, como o produto). */
const ddmm = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/** C titular na segunda; A titular na quarta; C é SUBSTITUTO nas 2 próximas quartas de A (ausências por SQL — o gate do substituto não é o que se prova aqui). */
async function semearSubstituto(request: APIRequestContext) {
  const seed = await seedDerivablePatient(request, { status: 'SEARCHING', services: [DUAS_FAIXAS] });
  try {
    const [svc] = seed.services; // slotIds ordenados por dia: [segunda, quarta]
    sqlComVars("UPDATE patient_contracted_services SET providers_needed = 1 WHERE id = :'id'::uuid", { id: svc.serviceId });
    const c = selectedWorker(seed, svc.vacancyId);
    const a = selectedWorker(seed, svc.vacancyId);
    const alocC = await allocateWorker(request, seed.patientId, svc.serviceId, svc.slotIds[0], c);
    const alocA = await allocateWorker(request, seed.patientId, svc.serviceId, svc.slotIds[1], a);
    expect([alocC.status, alocA.status]).toEqual([201, 201]);
    // 2 próximas quartas (SQL no fuso do país, nunca `new Date()` do runner) + ausência de A com substituto C
    const d1 = sqlComVars(
      `SELECT to_char(x.d, 'YYYY-MM-DD') FROM (SELECT (${HOJE_SQL} + 1) + ((3 - extract(dow FROM (${HOJE_SQL} + 1))::int + 7) % 7) AS d) x`,
    );
    const d2 = sqlComVars("SELECT to_char(:'d'::date + 7, 'YYYY-MM-DD')", { d: d1 });
    for (const d of [d1, d2]) {
      sqlComVars(
        "INSERT INTO patient_itinerary_absence (assignment_id, on_date, substitute_worker_id, substitute_application_id, created_by, updated_by) " +
          "SELECT :'a'::uuid, :'d'::date, :'c'::uuid, id, 'e2e', 'e2e' FROM worker_job_applications WHERE worker_id = :'c'::uuid AND job_posting_id = :'v'::uuid",
        { a: alocA.allocationId!, d, c, v: svc.vacancyId },
      );
    }
    return { seed, serviceId: svc.serviceId, slotSegunda: svc.slotIds[0], slotQuarta: svc.slotIds[1], a, c, alocC: alocC.allocationId!, alocA: alocA.allocationId!, datas: [d1, d2] };
  } catch (err) {
    seed.cleanup();
    throw err;
  }
}

function vigiarHosts(page: Page): () => string[] {
  const hosts: string[] = [];
  page.on('request', (r) => hosts.push(new URL(r.url()).hostname));
  return () => hosts.filter((h) => CADEIA_FORBIDDEN_HOSTS.test(h));
}

const ehEnd = (url: string): boolean => /\/itinerary\/allocations\/[^/]+\/end$/.test(url);

test.describe('patient-itinerary-tirar-agendado: "Quitar del itinerario" com atendimento agendado pela tela @integration', () => {
  test.use({ ...LANCAMENTO_VIEWPORT_ES_AR, deviceScaleFactor: 1 });
  test.setTimeout(150_000);
  useLancamentoStaff(STAFF, 'E2E Itinerario Tirar Agendado');

  test('FELIZ: C é substituto em 2 datas → "Sale del encuadre" mostra o aviso com as datas → confirmar → os 2 dias ficam descobertos e A segue titular', async ({ page, request }) => {
    const proibidos = vigiarHosts(page);
    const m = await semearSubstituto(request);
    try {
      await loginAs(page, STAFF);
      await openItineraryTab(page, m.seed.patientId);
      await page.getByTestId(`itinerario-slot-editar-${m.slotSegunda}`).click();
      await expect(page.getByTestId('itinerario-editar-modal')).toBeVisible();
      await page.getByTestId(`itinerario-quitar-${m.c}`).click();
      await expect(page.getByTestId('itinerario-quitar-painel')).toBeVisible();
      await page.getByTestId('itinerario-quitar-motivo').selectOption({ label: MOTIVO_DESISTENCIA });
      await page.getByTestId('itinerario-quitar-destino-LEAVE_SERVICE').click();

      // 1ª tentativa: 409 com as datas; o aviso as lista em dd/mm.
      const [r1] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'POST' && ehEnd(r.url())),
        page.getByTestId('itinerario-quitar-confirmar').click(),
      ]);
      expect(r1.status()).toBe(409);
      await expect(page.getByTestId('aviso-agendados')).toBeVisible();
      for (const d of m.datas) await expect(page.getByTestId('aviso-agendados-datas')).toContainText(ddmm(d));

      // Confirmar o aviso: o 2º POST leva cancelScheduled.
      const [r2] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'POST' && ehEnd(r.url())),
        page.getByTestId('aviso-agendados-confirmar').click(),
      ]);
      expect(r2.status()).toBe(200);
      expect(r2.request().postDataJSON()).toEqual({ reasonCategory: 'DESISTENCIA_DO_PRESTADOR', destination: 'LEAVE_SERVICE', cancelScheduled: true });
      await expect(page.getByTestId('itinerario-quitar-painel')).toHaveCount(0, { timeout: 10_000 });

      // Na tela: os 2 dias de A ficam sem cobertura; A segue titular da quarta.
      for (const d of m.datas) {
        await expect(page.getByTestId(`itinerario-evento-status-${m.alocA}-${d}`)).toContainText('Sin cobertura', { timeout: 15_000 });
      }
      await expect(page.getByTestId(`itinerario-slot-prestador-${m.slotQuarta}-${m.a}`)).toBeVisible();

      // Banco: 2 SUBSTITUTE_CANCELLED + 1 REMOVE; as 2 ausências sem substituto e não canceladas.
      const n = (kind: string): number =>
        Number(sqlComVars("SELECT count(*) FROM patient_itinerary_change_log WHERE contracted_service_id = :'s'::uuid AND kind = :'k'", { s: m.serviceId, k: kind }));
      expect(n('SUBSTITUTE_CANCELLED')).toBe(2);
      expect(n('REMOVE')).toBe(1);
      expect(
        Number(sqlComVars("SELECT count(*) FROM patient_itinerary_absence WHERE assignment_id = :'a'::uuid AND substitute_worker_id IS NULL AND cancelled_at IS NULL", { a: m.alocA })),
      ).toBe(2);

      expect(proibidos(), 'nenhum host de canal real pedido pela página').toEqual([]);
    } finally {
      m.seed.cleanup();
    }
  });
});
