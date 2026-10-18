/**
 * patient-itinerary-horas-dono-unico.integration.e2e.ts @integration — spec 056 (Horas com dono único),
 * T3.7: o par "cobertas/horário" do serviço, lido pelas DUAS telas que o mostram (subcard do Kanban e
 * aba Itinerario), contra o stack REAL (frontend + API + Postgres), sem mock de dado de negócio — só a
 * auth é o mock do stack (`loginAs`). O denominador é a SOMA DAS FAIXAS do serviço (`scheduleHours`),
 * nunca uma coluna digitada. Sem preenchimento programático: o dado nasce pelos helpers de API/SQL já migrados e a
 * alocação pela API; a tela só é LIDA (valores vindos do DOM).
 *
 * Side-effect outbound mapeado: semear paciente/serviço/vaga e alocar escrevem só em Postgres (mesma
 * cadeia de `patient-itinerary-montar`); nenhum canal real — o teste exige isso pelos hosts pedidos.
 *
 * Os 2 testes (o nome do arquivo casa o `--grep patient-itinerary`):
 *   1. FELIZ — serviço com faixas de 40 h (4 × 10 h) e 20 h cobertas: subcard e aba mostram 20/40;
 *   2. ALTERNATIVO (a) — turno sábado 20:00 → domingo 08:00 conta 12 h: o card de sábado mostra "12 h" e o
 *      par sobe 12 ao alocar.
 * (O alternativo (b), reserva, é da T6.4.)
 */
import { test, expect, type Page } from '@playwright/test';
import { mockAdminUserFor, useLancamentoStaff, LANCAMENTO_VIEWPORT_ES_AR } from '../helpers/lancamento-e2e-helper';
import { loginAs } from '../helpers/abac-stack-helper';
import { readItineraryApi } from '../helpers/itinerario-e2e-helper';
import { openItineraryTab } from '../helpers/itinerario-aba-e2e-helper';
import { openPatientKanban, readSubcardPair } from '../helpers/kanban-subcard-e2e-helper';
import {
  seedDerivablePatient, selectedWorker, allocateWorker, coveredHours, type DerivableSeed,
} from '../helpers/derivacao-e2e-helper';
import { CADEIA_FORBIDDEN_HOSTS } from '../helpers/cadeia-completa-e2e-helper';

const STAFF = mockAdminUserFor('itinerario-horas-dono-unico');

const SABADO = 6; // 0 = domingo

/** 4 faixas de 10 h (seg a qui, 08:00) = 40 h/semana; faixas do MESMO serviço não se sobrepõem. */
const QUARENTA_HORAS = {
  schedule: [1, 2, 3, 4].map((dayOfWeek) => ({ dayOfWeek, startTime: '08:00', durationMinutes: 600 })),
};
/** Turno da noite: sábado 20:00 por 12 h (termina domingo 08:00). */
const TURNO_DA_NOITE = { schedule: [{ dayOfWeek: SABADO, startTime: '20:00', durationMinutes: 720 }] };

function vigiarHosts(page: Page): () => string[] {
  const hosts: string[] = [];
  page.on('request', (r) => hosts.push(new URL(r.url()).hostname));
  return () => hosts.filter((h) => h.match(CADEIA_FORBIDDEN_HOSTS) !== null);
}

/** Aloca um prestador Selecionado em cada slot dado, pela API (o 201 é conferido). */
async function alocar(request: Parameters<typeof allocateWorker>[0], seed: DerivableSeed, slotIds: string[]): Promise<void> {
  const [svc] = seed.services;
  const workerId = selectedWorker(seed, svc.vacancyId);
  for (const slotId of slotIds) {
    const r = await allocateWorker(request, seed.patientId, svc.serviceId, slotId, workerId);
    expect(r.status, `alocar no slot ${slotId}: ${r.code ?? ''}`).toBe(201);
  }
}

test.describe('patient-itinerary-horas-dono-unico: o par cobertas/horário vem das faixas @integration', () => {
  test.use({ ...LANCAMENTO_VIEWPORT_ES_AR, deviceScaleFactor: 1 });
  test.setTimeout(150_000);
  useLancamentoStaff(STAFF, 'E2E Itinerario Horas Dono Unico');

  test('serviço com faixas de 40 h e 20 h cobertas: subcard e aba mostram 20/40', async ({ page, request }) => {
    const proibidos = vigiarHosts(page);
    const seed = await seedDerivablePatient(request, { status: 'SEARCHING', services: [QUARENTA_HORAS] });
    try {
      const [svc] = seed.services;
      expect(svc.slotIds).toHaveLength(4);
      await alocar(request, seed, svc.slotIds.slice(0, 2)); // 2 × 10 h = 20 h cobertas

      // A API é a fonte: denominador = soma das faixas, numerador = alocadas.
      const itin = await readItineraryApi(request, seed.patientId);
      expect(itin.status).toBe(200);
      const apiSvc = itin.body.data?.services.find((s) => s.contractedServiceId === svc.serviceId);
      expect(apiSvc?.scheduleHours).toBe(40);
      expect(apiSvc?.cobertas).toBe(20);
      expect(await coveredHours(request, seed.patientId)).toBe(20);

      await loginAs(page, STAFF);

      // Aba Itinerario.
      await openItineraryTab(page, seed.patientId);
      await expect(page.getByTestId(`itinerario-servico-par-${svc.serviceId}`)).toContainText('20/40');

      // Subcard do Kanban.
      await openPatientKanban(page);
      expect(await readSubcardPair(page, svc.serviceId)).toBe('20/40');

      expect(proibidos(), 'nenhum host de canal real pedido pela página').toEqual([]);
    } finally {
      seed.cleanup();
    }
  });

  test('turno 20:00 → 08:00 conta 12 h: o card de sábado mostra "12 h" e o par sobe 12', async ({ page, request }) => {
    const proibidos = vigiarHosts(page);
    const seed = await seedDerivablePatient(request, { status: 'SEARCHING', services: [TURNO_DA_NOITE] });
    try {
      const [svc] = seed.services;
      const slotId = svc.slotIds[0];
      const antes = await readItineraryApi(request, seed.patientId);
      const apiAntes = antes.body.data?.services.find((s) => s.contractedServiceId === svc.serviceId);
      expect(apiAntes?.scheduleHours).toBe(12); // 20:00 + 12 h, uma faixa só
      expect(apiAntes?.cobertas).toBe(0);

      await loginAs(page, STAFF);
      await openItineraryTab(page, seed.patientId);
      const cardSabado = page.getByTestId(`itinerario-dia-${svc.serviceId}-${SABADO}`);
      await expect(cardSabado).toBeVisible();
      await expect(cardSabado.getByTestId(`itinerario-slot-duracao-${slotId}`)).toHaveText('12 h');
      await expect(cardSabado.getByTestId(`itinerario-slot-horario-${slotId}`)).toContainText('20:00');
      await expect(cardSabado.getByTestId(`itinerario-slot-horario-${slotId}`)).toContainText('08:00');
      await expect(page.getByTestId(`itinerario-servico-par-${svc.serviceId}`)).toContainText('0/12');

      await alocar(request, seed, [slotId]);

      await openItineraryTab(page, seed.patientId); // releitura pela tela
      await expect(page.getByTestId(`itinerario-servico-par-${svc.serviceId}`)).toContainText('12/12');
      await openPatientKanban(page);
      expect(await readSubcardPair(page, svc.serviceId)).toBe('12/12');

      expect(proibidos(), 'nenhum host de canal real pedido pela página').toEqual([]);
    } finally {
      seed.cleanup();
    }
  });
});
