/**
 * patient-itinerary-montar.integration.e2e.ts @integration — Fase 3 da change
 * itinerario-trocas-motivos-e-figma: o botão "Itinerario listo" da aba Itinerario, exercitado por um
 * HUMANO contra o stack REAL (frontend + API + Postgres), sem mock de dado de negócio — só a auth é o
 * mock do stack (`loginAs`). Régua humana (memória `e2e-humano-nao-e-fill`): click + `keyboard.type`,
 * valores lidos da TELA; nenhum preenchimento programático de campo. O estado do paciente é lido da
 * coluna do Kanban E da API/banco na MESMA execução.
 *
 * Side-effect outbound mapeado ANTES de clicar: `AssembleItineraryUseCase` → `PatientStatusDerivation`
 * → `PatientStatusWriter` só escrevem em Postgres (nenhum import de Twilio/Periskope/Talentum/e-mail);
 * a alocação pela tela é a mesma de `kanban-pacientes-itinerario-aba`. Mesmo assim o teste registra todo
 * host que a PÁGINA pede e exige que nenhum seja de canal real (`CADEIA_FORBIDDEN_HOSTS`).
 *
 * Os 3 testes (o nome do arquivo casa o `--grep patient-itinerary` do job padrão do `pr-gate.yml`):
 *   1. FELIZ — paciente em Búsqueda com faixa e vaga viva; alocar pela tela NÃO move o estado (D429: sem
 *      montagem a derivação não roda); clicar "Itinerario listo" → ACTIVE (cobertura total) e o botão
 *      vira o texto "Itinerario listo desde dd/mm";
 *   2. ALTERNATIVO 1 — serviço com vaga viva e SEM faixa ativa → a mensagem de `SERVICE_WITHOUT_SLOT`
 *      (sem id cru) e nenhuma linha nova em `patient_itinerary_assembly`;
 *   3. ALTERNATIVO 2 — já montado (montado pela API no setup) → sem botão, com o texto e a data.
 */
import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';
import {
  mockAdminUserFor, useLancamentoStaff, LANCAMENTO_VIEWPORT_ES_AR, readPatientKanbanColumn,
} from '../helpers/lancamento-e2e-helper';
import { loginAs, tokenFor } from '../helpers/abac-stack-helper';
import { ITINERARIO_STAFF, readItineraryApi } from '../helpers/itinerario-e2e-helper';
import { allocationOptionsApi, assembleApi, endSlotApi } from '../helpers/itinerario-escrita-e2e-helper';
import { openItineraryTab } from '../helpers/itinerario-aba-e2e-helper';
import {
  seedDerivablePatient, selectedWorker, readStatusBoth, coveredHours, type DerivableSeed,
} from '../helpers/derivacao-e2e-helper';
import { CADEIA_FORBIDDEN_HOSTS } from '../helpers/cadeia-completa-e2e-helper';

const STAFF = mockAdminUserFor('itinerario-montar');

/** 1 serviço de 4 h/semana com UMA faixa de 4 h: 1 prestador cobre 100% (cobertura total → ACTIVE). */
const QUATRO_HORAS = { weeklyHours: 4, schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }] };
const UUID_CRU = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

interface OptionDto { workerId: string; displayName: string | null }
interface OptionsData { options: OptionDto[] }

/** `count(*)` de montagens do paciente — psql com `-v VERBOSITY=terse` (o DETAIL de erro ecoa linha). */
function contarMontagens(patientId: string): number {
  const out = execSync(
    `docker exec ${process.env.E2E_PG_CONTAINER || 'enlite-postgres'} psql -U enlite_admin -d enlite_e2e -v VERBOSITY=terse -tAc "select count(*) from patient_itinerary_assembly where patient_id='${patientId}'"`,
    { encoding: 'utf-8' },
  );
  return Number(out.trim());
}

/** dd/mm de uma string ISO, em Buenos Aires — a mesma leitura que a tela faz, sem o fuso do runner. */
function ddMmBuenosAires(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date(iso));
}

async function assembledAtDaApi(request: Parameters<typeof readItineraryApi>[0], patientId: string): Promise<string | null> {
  const itin = await readItineraryApi(request, patientId);
  expect(itin.status).toBe(200);
  return (itin.body.data as unknown as { assembledAt: string | null }).assembledAt;
}

function vigiarHosts(page: Page): () => string[] {
  const hosts: string[] = [];
  page.on('request', (r) => hosts.push(new URL(r.url()).hostname));
  return () => hosts.filter((h) => CADEIA_FORBIDDEN_HOSTS.test(h));
}

test.describe('patient-itinerary-montar: "Itinerario listo" pela tela @integration', () => {
  test.use({ ...LANCAMENTO_VIEWPORT_ES_AR, deviceScaleFactor: 1 });
  test.setTimeout(150_000);
  useLancamentoStaff(STAFF, 'E2E Itinerario Montar');

  test('FELIZ: alocar pela tela não move o estado; "Itinerario listo" → ACTIVE e o botão vira o texto', async ({ page, request }) => {
    const proibidos = vigiarHosts(page);
    const seed: DerivableSeed = await seedDerivablePatient(request, { status: 'SEARCHING', services: [QUATRO_HORAS] });
    try {
      const [svc] = seed.services;
      const slotId = svc.slotIds[0];
      const w = selectedWorker(seed, svc.vacancyId);
      const opts = await allocationOptionsApi(request, tokenFor(ITINERARIO_STAFF), seed.patientId, svc.serviceId);
      expect(opts.status).toBe(200);
      const wLabel = (opts.body.data as OptionsData | undefined)?.options.find((o) => o.workerId === w)?.displayName;
      if (!wLabel) throw new Error('patient-itinerary-montar: prestador sem displayName nas opções');

      await loginAs(page, STAFF);
      const colunaAntes = await readPatientKanbanColumn(page, seed.patientId);
      const antes = await readStatusBoth(request, seed.patientId);
      expect(antes.api).toBe('SEARCHING');
      expect(antes.db).toBe('SEARCHING');
      expect(contarMontagens(seed.patientId)).toBe(0);

      // ── alocar Ana pela TELA (click + keyboard.type) ────────────────────────────────
      await openItineraryTab(page, seed.patientId);
      await expect(page.getByTestId('itinerario-montar')).toBeVisible();
      await page.getByTestId(`itinerario-slot-editar-${slotId}`).click();
      const modal = page.getByTestId('itinerario-editar-modal');
      await expect(modal).toBeVisible();
      await modal.getByTestId('itinerario-editar-prestador').click();
      const search = modal.getByPlaceholder('Buscar...');
      await search.click();
      await page.keyboard.type(wLabel.slice(-10), { delay: 20 });
      await modal.getByRole('option', { name: wLabel }).click();
      const [postResp] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/slots/${slotId}/allocations`)),
        modal.getByTestId('itinerario-editar-guardar').click(),
      ]);
      expect(postResp.status()).toBe(201);
      await expect(page.getByTestId(`itinerario-slot-prestador-${slotId}-${w}`)).toBeVisible();

      // Cobertura total, mas SEM montagem: o estado NÃO muda (API, banco e coluna do Kanban).
      expect(await coveredHours(request, seed.patientId)).toBe(4);
      const meio = await readStatusBoth(request, seed.patientId);
      expect(meio).toEqual(antes);
      expect(await assembledAtDaApi(request, seed.patientId)).toBeNull();
      expect(await readPatientKanbanColumn(page, seed.patientId)).toBe(colunaAntes);

      // ── "Itinerario listo" ──────────────────────────────────────────────────────────
      await openItineraryTab(page, seed.patientId);
      const botao = page.getByTestId('itinerario-montar');
      await expect(botao).toHaveText('Itinerario listo');
      const [assembleResp] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/patients/${seed.patientId}/itinerary/assemble`)),
        botao.click(),
      ]);
      expect(assembleResp.status()).toBe(201);

      const montado = page.getByTestId('itinerario-montado');
      await expect(montado).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('itinerario-montar')).toHaveCount(0);
      const assembledAt = await assembledAtDaApi(request, seed.patientId);
      expect(assembledAt).not.toBeNull();
      await expect(montado).toHaveText(`Itinerario listo desde ${ddMmBuenosAires(assembledAt!)}`);
      expect(contarMontagens(seed.patientId)).toBe(1);

      const depois = await readStatusBoth(request, seed.patientId);
      expect(depois.api).toBe('ACTIVE');
      expect(depois.db).toBe('ACTIVE');
      const colunaDepois = await readPatientKanbanColumn(page, seed.patientId);
      expect(colunaDepois).not.toBe(colunaAntes);
      expect(proibidos(), 'nenhum host de canal real pedido pela página').toEqual([]);
    } finally {
      seed.cleanup();
    }
  });

  test('ALTERNATIVO 1: serviço com vaga viva e sem faixa ativa → mensagem do código, sem id cru, nenhuma montagem nova', async ({ page, request }) => {
    const proibidos = vigiarHosts(page);
    const seed = await seedDerivablePatient(request, { status: 'SEARCHING', services: [QUATRO_HORAS] });
    try {
      const [svc] = seed.services;
      // A vaga viva exige faixa para ativar; encerrar a única faixa deixa "vaga viva SEM faixa ativa".
      const fim = await endSlotApi(request, tokenFor(ITINERARIO_STAFF), seed.patientId, svc.serviceId, svc.slotIds[0]);
      expect(fim.status).toBe(200);
      const statusAntes = await readStatusBoth(request, seed.patientId);
      const montagensAntes = contarMontagens(seed.patientId);
      expect(montagensAntes).toBe(0);

      await loginAs(page, STAFF);
      await openItineraryTab(page, seed.patientId);
      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/patients/${seed.patientId}/itinerary/assemble`)),
        page.getByTestId('itinerario-montar').click(),
      ]);
      expect(resp.status()).toBe(422);
      expect(((await resp.json()) as { code?: string }).code).toBe('SERVICE_WITHOUT_SLOT');

      const erro = page.getByTestId('itinerario-montar-erro');
      await expect(erro).toBeVisible();
      await expect(erro).toContainText('todavía no tiene franjas horarias');
      expect(await erro.innerText()).not.toMatch(UUID_CRU);
      expect(await erro.innerText()).not.toContain(svc.serviceId);
      await expect(page.getByTestId('itinerario-montar')).toBeVisible(); // segue clicável para tentar de novo
      await expect(page.getByTestId('itinerario-montado')).toHaveCount(0);

      expect(contarMontagens(seed.patientId)).toBe(montagensAntes);
      expect(await readStatusBoth(request, seed.patientId)).toEqual(statusAntes);
      expect(proibidos(), 'nenhum host de canal real pedido pela página').toEqual([]);
    } finally {
      seed.cleanup();
    }
  });

  test('ALTERNATIVO 2: já montado → sem botão, com o texto "Itinerario listo desde dd/mm"', async ({ page, request }) => {
    const proibidos = vigiarHosts(page);
    const seed = await seedDerivablePatient(request, { status: 'SEARCHING', services: [QUATRO_HORAS] });
    try {
      const montar = await assembleApi(request, tokenFor(ITINERARIO_STAFF), seed.patientId);
      expect(montar.status).toBe(201);
      expect(contarMontagens(seed.patientId)).toBe(1);
      const assembledAt = await assembledAtDaApi(request, seed.patientId);
      expect(assembledAt).not.toBeNull();

      await loginAs(page, STAFF);
      await openItineraryTab(page, seed.patientId);
      await expect(page.getByTestId('itinerario-montado')).toHaveText(`Itinerario listo desde ${ddMmBuenosAires(assembledAt!)}`);
      await expect(page.getByTestId('itinerario-montar')).toHaveCount(0);
      await expect(page.getByTestId('itinerario-montar-erro')).toHaveCount(0);
      expect(contarMontagens(seed.patientId)).toBe(1);
      expect(proibidos(), 'nenhum host de canal real pedido pela página').toEqual([]);
    } finally {
      seed.cleanup();
    }
  });
});
