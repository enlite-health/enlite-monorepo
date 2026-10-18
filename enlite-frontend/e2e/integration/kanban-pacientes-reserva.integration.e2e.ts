/**
 * kanban-pacientes-reserva.integration.e2e.ts @integration — spec 056 (Horas com dono único), T6.4:
 * o selo da reserva da Equipe de Resposta Rápida, lido pelas DUAS telas que o mostram (subcard do
 * Kanban de pacientes e aba Itinerario), contra o stack REAL (frontend + API + Postgres), sem mock de
 * dado de negócio — só a auth é o mock do stack (`loginAs`). O nome casa o `--grep 'kanban-pacientes'`
 * do job padrão (nenhuma mudança de workflow). Sem preenchimento programático: o dado nasce pelos
 * helpers de semente (`seedLaunchablePatient` + `activateRecruitmentViaApi` + candidaturas por SQL, como
 * `kanban-pacientes-cadeia-completa`) e a tela só é LIDA.
 *
 * Side-effect outbound mapeado: semear paciente/serviço/vaga e candidaturas escreve só em Postgres
 * (mesma cadeia dos specs irmãos); o teste exige, pelos hosts pedidos pela página, que nenhum canal
 * real seja tocado (`CADEIA_FORBIDDEN_HOSTS`).
 *
 * Os 2 testes:
 *   1. RESERVA 7 — vaga viva com 7 candidatos em QUICK_RESPONSE_TEAM, nenhum alocado: o subcard mostra
 *      "Reserva 7/10" com `data-alert="true"` e a aba mostra "7 de 10";
 *   2. SEM VAGA VIVA — serviço sem vaga: "sin vacante" (nunca "0/10"), `data-alert="false"`.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  seedLaunchablePatient, mockAdminUserFor, useLancamentoStaff, LANCAMENTO_VIEWPORT_ES_AR,
} from '../helpers/lancamento-e2e-helper';
import { loginAs } from '../helpers/abac-stack-helper';
import { activateRecruitmentViaApi } from '../helpers/itinerario-e2e-helper';
import { openItineraryTab } from '../helpers/itinerario-aba-e2e-helper';
import { openPatientKanban, readSubcardPair } from '../helpers/kanban-subcard-e2e-helper';
import { insertWJA } from '../helpers/wja-test-helper';
import { CADEIA_FORBIDDEN_HOSTS, seedMarkedWorker, cleanupCadeia } from '../helpers/cadeia-completa-e2e-helper';

const STAFF = mockAdminUserFor('kanban-reserva');

/** Coordenadas PRÓPRIAS deste arquivo (nenhum outro spec usa estas). */
const COORDS = { com: { lat: -48.3101, lng: -66.4402 }, sem: { lat: -48.3601, lng: -66.4902 } } as const;

function vigiarHosts(page: Page): () => string[] {
  const hosts: string[] = [];
  page.on('request', (r) => hosts.push(new URL(r.url()).hostname));
  return () => hosts.filter((h) => h.match(CADEIA_FORBIDDEN_HOSTS) !== null);
}

test.describe('kanban-pacientes reserva: o selo da Equipe de Resposta Rápida @integration', () => {
  test.use({ ...LANCAMENTO_VIEWPORT_ES_AR, deviceScaleFactor: 1 });
  test.setTimeout(150_000);
  useLancamentoStaff(STAFF, 'E2E Kanban Reserva');

  test('serviço com reserva 7 mostra o selo de alerta', async ({ page, request }) => {
    const proibidos = vigiarHosts(page);
    const patient = await seedLaunchablePatient(request, { status: 'ADMISSION', ...COORDS.com });
    const pares: Array<{ workerId: string; vacancyId: string }> = [];
    const workerIds: string[] = [];
    try {
      const vacancyId = await activateRecruitmentViaApi(request, patient.patientId, patient.serviceId);
      for (let i = 1; i <= 7; i += 1) {
        const workerId = seedMarkedWorker(`R${i}`);
        workerIds.push(workerId);
        insertWJA({ workerId, jobPostingId: vacancyId, funnelStage: 'QUICK_RESPONSE_TEAM' });
        pares.push({ workerId, vacancyId });
      }

      await loginAs(page, STAFF);

      // Subcard do Kanban.
      await openPatientKanban(page);
      await readSubcardPair(page, patient.serviceId); // espera o subcard do serviço montar
      const selo = page.getByTestId(`subcard-reserva-${patient.serviceId}`);
      await expect(selo).toHaveText('Reserva 7/10');
      await expect(selo).toHaveAttribute('data-alert', 'true');

      // Aba Itinerario.
      await openItineraryTab(page, patient.patientId);
      await expect(page.getByTestId(`itinerario-reserva-${patient.serviceId}`)).toContainText('7 de 10');

      expect(proibidos(), 'nenhum host de canal real pedido pela página').toEqual([]);
    } finally {
      cleanupCadeia({ patientIds: [patient.patientId], workerVacancyPairs: pares, workerIds, seeds: [patient] });
    }
  });

  test('serviço sem vaga viva mostra sin vacante', async ({ page, request }) => {
    const proibidos = vigiarHosts(page);
    const patient = await seedLaunchablePatient(request, { status: 'ADMISSION', ...COORDS.sem });
    try {
      await loginAs(page, STAFF);

      await openPatientKanban(page);
      await readSubcardPair(page, patient.serviceId);
      const selo = page.getByTestId(`subcard-reserva-${patient.serviceId}`);
      await expect(selo).toHaveText('sin vacante');
      await expect(selo).not.toContainText('0/10');
      await expect(selo).toHaveAttribute('data-alert', 'false');

      await openItineraryTab(page, patient.patientId);
      await expect(page.getByTestId(`itinerario-reserva-${patient.serviceId}`)).toContainText('sin vacante');

      expect(proibidos(), 'nenhum host de canal real pedido pela página').toEqual([]);
    } finally {
      cleanupCadeia({ patientIds: [patient.patientId], workerVacancyPairs: [], workerIds: [], seeds: [patient] });
    }
  });
});
