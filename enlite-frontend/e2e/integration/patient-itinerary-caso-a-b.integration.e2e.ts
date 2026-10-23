/**
 * patient-itinerary-caso-a-b.integration.e2e.ts @integration — 058b/B2 (T243), ADAPTADO à spec 069 (F7): a saída definitiva ("reemplazo Entero") com
 * início hoje (Caso A) ou data futura (Caso B), MOTIVO e DESTINO, agora pelo fluxo "Nueva sustitución" → "No vuelve más" da tela do serviço
 * (4 passos), exercitado por um HUMANO contra o stack REAL (frontend + API + Postgres), sem interceptar rota e sem mock de dado de negócio — só
 * a auth é o mock do stack (`loginAs`). Régua humana: click + teclado, valores lidos da TELA. O QUE cada teste prova é o de antes; só o caminho mudou.
 *
 * Side-effect outbound mapeado ANTES de clicar: o pedido (`POST …/substitution-requests`) só escreve em Postgres (alocação, registro de trocas, marca
 * de rejeição, derivação de estado) — nenhum import de Twilio/Periskope/Talentum/Ana Care/ClickUp/e-mail/fila no caminho. Mesmo assim cada teste
 * registra todo host que a PÁGINA pede e exige que nenhum seja de canal real (`CADEIA_FORBIDDEN_HOSTS`).
 *
 * Os testes (o nome do arquivo casa o `--grep patient-itinerary` do `pr-gate.yml`):
 *   1. FELIZ — Caso A "hoje" + motivo + "Sigue como reserva";
 *   2. ALTERNATIVO 1 (servidor recusa) — o substituto ganha faixa conflitante em outro paciente DEPOIS do passo 3 → 409 ITINERARY_OVERLAP dito no passo 4;
 *   3. ALTERNATIVO 2 (estado muda por fora) — o titular é encerrado antes de confirmar → o servidor recusa e a tela diz;
 *   4. VALIDAÇÃO — data passada bloqueada, destino só quando D = hoje e obrigatório; nenhuma requisição de pedido sai sem confirmar.
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { mockAdminUserFor, useLancamentoStaff, LANCAMENTO_VIEWPORT_ES_AR } from '../helpers/lancamento-e2e-helper';
import { loginAs } from '../helpers/abac-stack-helper';
import { openItineraryTab, openFixedSchedule, openUpcomingDays, digitarDataNoCampo } from '../helpers/itinerario-aba-e2e-helper';
import { seedDerivablePatient, selectedWorker, allocateWorker, derivacaoToken } from '../helpers/derivacao-e2e-helper';
import { insertWJA } from '../helpers/wja-test-helper';
import { allocationOptionsApi, endAllocationApi } from '../helpers/itinerario-escrita-e2e-helper';
import { sqlComVars } from '../helpers/sql-com-vars';
import { CADEIA_FORBIDDEN_HOSTS } from '../helpers/cadeia-completa-e2e-helper';
import {
  abrirNuevaSustitucion, confirmarPedido, diaDoBanco, hojeDoBanco, paso1QuienNoViene, paso2PorCuantoTiempo, paso3UnaPersona, paso4Motivo, siguiente,
} from '../helpers/itinerario-069-flow-helper';

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

/** Fluxo até o passo 4 ("No vuelve más" a partir de `desde`, `b` cobre): devolve com o motivo ainda por escolher. */
async function ateOPasso4(page: Page, m: { seed: { patientId: string }; serviceId: string; a: string; b: string }, desde: string): Promise<void> {
  await openItineraryTab(page, m.seed.patientId);
  await openUpcomingDays(page, m.serviceId);
  await abrirNuevaSustitucion(page);
  await paso1QuienNoViene(page, m.a);
  await paso2PorCuantoTiempo(page, 'PERMANENT', desde);
  await siguiente(page);
  await paso3UnaPersona(page, m.b);
  await expect(page.locator('[data-testid^="substitucion-estado-"]')).toHaveText('Libre', { timeout: 15_000 });
  await siguiente(page);
  await expect(page.getByTestId('substitucion-paso')).toContainText('4');
}

const MOTIVO = 'DESISTENCIA_DO_PRESTADOR'; // "El prestador desistió"

const contagemNoServico = (serviceId: string, worker: string): string =>
  sqlComVars(
    "SELECT count(*) FROM patient_itinerary_assignment a JOIN patient_itinerary_slot s ON s.id = a.slot_id WHERE s.contracted_service_id = :'svc'::uuid AND a.worker_id = :'w'::uuid",
    { svc: serviceId, w: worker },
  );
const statusDaAlocacao = (allocationId: string): string =>
  sqlComVars("SELECT status FROM patient_itinerary_assignment WHERE id = :'id'::uuid", { id: allocationId });
const replaces = (serviceId: string): string =>
  sqlComVars("SELECT count(*) FROM patient_itinerary_change_log WHERE contracted_service_id = :'svc'::uuid AND kind = 'REPLACE'", { svc: serviceId });
const pedidos = (serviceId: string): string =>
  sqlComVars("SELECT count(*) FROM patient_itinerary_substitution_request WHERE contracted_service_id = :'svc'::uuid", { svc: serviceId });

test.describe('patient-itinerary-caso-a-b: saída definitiva com motivo e destino pelo fluxo "No vuelve más" @integration', () => {
  test.use({ ...LANCAMENTO_VIEWPORT_ES_AR, deviceScaleFactor: 1 });
  test.setTimeout(150_000);
  useLancamentoStaff(STAFF, 'E2E Itinerario Caso A B');

  test('FELIZ: Caso A "hoje" + motivo + "Sigue como reserva": o substituto vira titular hoje e o antigo volta a Seleccionado', async ({ page, request }) => {
    const proibidos = vigiarHosts(page);
    const m = await semearTroca(request);
    try {
      const hoje = hojeDoBanco();
      await loginAs(page, STAFF);
      await ateOPasso4(page, m, hoje);
      await expect(page.getByTestId('substitucion-destino')).toBeVisible(); // D = hoje → a tela pergunta o destino de quem sai
      await expect(page.getByTestId('substitucion-confirmar')).toBeDisabled(); // sem motivo e sem destino
      await paso4Motivo(page, MOTIVO, 'RESERVE');
      const resp = await confirmarPedido(page);
      expect(resp.status()).toBe(201);
      expect(resp.request().postDataJSON()).toEqual({
        type: 'PERMANENT', outgoingWorkerId: m.a, from: hoje, reasonCategory: MOTIVO, substituteWorkerId: m.b, destination: 'RESERVE',
      });

      await expect(page.getByTestId('substitucion-flujo')).toHaveCount(0, { timeout: 10_000 });
      await openFixedSchedule(page, m.serviceId);
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

  test('ALTERNATIVO 1 (servidor recusa): o substituto passa a ter uma faixa conflitante em OUTRO paciente depois do passo 3 → 409 ITINERARY_OVERLAP com mensagem de produto; nada muda', async ({ page, request }) => {
    const proibidos = vigiarHosts(page);
    const m = await semearTroca(request);
    const seed2 = await seedDerivablePatient(request, { status: 'SEARCHING', services: [QUATRO_HORAS] });
    try {
      await loginAs(page, STAFF);
      await ateOPasso4(page, m, hojeDoBanco());
      await paso4Motivo(page, MOTIVO, 'RESERVE'); // tudo preenchido, SEM confirmar

      // Por fora: B passa a atender o 2º paciente na mesma segunda 08:00–12:00 (a pré-visão do passo 3 já tinha dito "Libre").
      const svc2 = seed2.services[0];
      insertWJA({ workerId: m.b, jobPostingId: svc2.vacancyId, funnelStage: 'QUICK_RESPONSE_TEAM' });
      seed2.track(m.b, svc2.vacancyId);
      const aloc2 = await allocateWorker(request, seed2.patientId, svc2.serviceId, svc2.slotIds[0], m.b);
      expect(aloc2.status, `allocate b no 2º paciente ${aloc2.status} ${aloc2.code ?? ''}`).toBe(201);

      const resp = await confirmarPedido(page);
      expect(resp.status()).toBe(409);
      expect((await resp.json()).code).toBe('ITINERARY_OVERLAP');
      const erro = page.getByTestId('substitucion-error');
      await expect(erro).toBeVisible({ timeout: 10_000 });
      await expect(erro).toContainText('El prestador ya tiene otra franja que se superpone');
      expect(await erro.innerText()).not.toContain('ITINERARY_OVERLAP');
      await expect(page.getByTestId('substitucion-flujo')).toBeVisible();

      expect(statusDaAlocacao(m.allocationA)).toBe('ACTIVE');
      expect(contagemNoServico(m.serviceId, m.b)).toBe('0');
      expect(replaces(m.serviceId)).toBe('0');
      expect(pedidos(m.serviceId)).toBe('0'); // o pedido inteiro falha, sem escrita parcial
      expect(proibidos()).toEqual([]);
    } finally {
      seed2.cleanup();
      m.seed.cleanup();
    }
  });

  test('ALTERNATIVO 2 (estado muda por fora): o titular é encerrado por outro caminho antes de confirmar → o servidor recusa, a tela diz e nada é gravado', async ({ page, request }) => {
    const proibidos = vigiarHosts(page);
    const m = await semearTroca(request);
    try {
      await loginAs(page, STAFF);
      await ateOPasso4(page, m, hojeDoBanco());
      await paso4Motivo(page, MOTIVO, 'RESERVE'); // tudo preenchido, SEM confirmar

      // Por fora: o titular é encerrado por outro caminho.
      const fora = await endAllocationApi(request, derivacaoToken(), m.seed.patientId, m.serviceId, m.allocationA, { reasonCategory: 'OTHER', destination: 'RESERVE' });
      expect(fora.status, `end por fora ${fora.status} ${fora.body.code ?? ''}`).toBe(200);

      const resp = await confirmarPedido(page);
      expect(resp.status()).toBeGreaterThanOrEqual(400);
      expect(resp.status()).toBeLessThan(500);
      const codigo = ((await resp.json()) as { code?: string }).code;
      expect(codigo, 'o servidor devolve um código de produto').toBeTruthy();
      const erro = page.getByTestId('substitucion-error');
      await expect(erro).toBeVisible({ timeout: 10_000 });
      expect(await erro.innerText()).not.toContain(codigo as string); // texto de produto, nunca o código cru

      expect(statusDaAlocacao(m.allocationA)).toBe('ENDED');
      expect(contagemNoServico(m.serviceId, m.b)).toBe('0');
      expect(replaces(m.serviceId)).toBe('0'); // só o REMOVE do passo por fora
      expect(pedidos(m.serviceId)).toBe('0');
      expect(proibidos()).toEqual([]);
    } finally {
      m.seed.cleanup();
    }
  });

  test('VALIDAÇÃO: data passada bloqueada, destino só quando D = hoje (e obrigatório); nenhuma requisição de pedido sai sem confirmar', async ({ page, request }) => {
    const proibidos = vigiarHosts(page);
    const m = await semearTroca(request);
    try {
      const posts: string[] = [];
      page.on('request', (r) => {
        if (r.method() === 'POST' && /\/substitution-requests$/.test(r.url())) posts.push(r.url());
      });
      const ontem = diaDoBanco(-1);
      const daqui7 = diaDoBanco(7);

      await loginAs(page, STAFF);
      await openItineraryTab(page, m.seed.patientId);
      await openUpcomingDays(page, m.serviceId);
      await abrirNuevaSustitucion(page);
      await paso1QuienNoViene(page, m.a);

      // "No vuelve más" sem data: "Siguiente" bloqueado. Com data PASSADA: a tela diz e continua bloqueado (antes de enviar).
      await page.getByTestId('substitucion-duracion-PERMANENT').locator('label').click();
      await expect(page.getByTestId('substitucion-siguiente')).toBeDisabled();
      await digitarDataNoCampo(page, 'substitucion-fecha', ontem);
      await expect(page.getByTestId('substitucion-periodo-pasado')).toContainText('La fecha ya pasó');
      await expect(page.getByTestId('substitucion-siguiente')).toBeDisabled();

      // Data FUTURA: libera; no passo 4 NÃO se pergunta o destino (só D = hoje) e o Confirmar espera o motivo.
      await digitarDataNoCampo(page, 'substitucion-fecha', daqui7);
      await expect(page.getByTestId('substitucion-turnos-cuenta')).toBeVisible({ timeout: 15_000 });
      await siguiente(page);
      await paso3UnaPersona(page, m.b);
      await expect(page.locator('[data-testid^="substitucion-estado-"]')).toHaveText('Libre', { timeout: 15_000 });
      await siguiente(page);
      await expect(page.getByTestId('substitucion-destino')).toHaveCount(0);
      await expect(page.getByTestId('substitucion-confirmar')).toBeDisabled();
      await paso4Motivo(page, MOTIVO);
      await expect(page.getByTestId('substitucion-confirmar')).toBeEnabled();

      // Voltar e trocar a data para HOJE: o destino passa a ser perguntado e obrigatório.
      await page.getByTestId('substitucion-atras').click(); // passo 3
      await page.getByTestId('substitucion-atras').click(); // passo 2
      await digitarDataNoCampo(page, 'substitucion-fecha', hojeDoBanco());
      await expect(page.getByTestId('substitucion-turnos-cuenta')).toBeVisible({ timeout: 15_000 });
      await siguiente(page);
      await paso3UnaPersona(page, m.b);
      await expect(page.locator('[data-testid^="substitucion-estado-"]')).toHaveText('Libre', { timeout: 15_000 });
      await siguiente(page);
      await expect(page.getByTestId('substitucion-destino')).toBeVisible();
      await expect(page.getByTestId('substitucion-confirmar')).toBeDisabled(); // motivo vale, falta o destino
      await page.getByTestId('substitucion-destino-RESERVE').click();
      await expect(page.getByTestId('substitucion-confirmar')).toBeEnabled();

      expect(posts).toHaveLength(0); // não confirmou
      expect(statusDaAlocacao(m.allocationA)).toBe('ACTIVE');
      expect(pedidos(m.serviceId)).toBe('0');
      expect(proibidos()).toEqual([]);
    } finally {
      m.seed.cleanup();
    }
  });
});
