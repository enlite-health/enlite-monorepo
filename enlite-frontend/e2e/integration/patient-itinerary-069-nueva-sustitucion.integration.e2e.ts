/**
 * patient-itinerary-069-nueva-sustitucion.integration.e2e.ts @integration — spec 069, F7 (US3-US5): o fluxo "Nueva sustitución" de 4 passos nas 3
 * durações (Un solo día · Varios días · No vuelve más). Stack REAL, sem mock de dado de negócio (só a auth, `loginAs`). Régua humana (memória
 * `e2e-humano-nao-e-fill`): `click` no rádio, datas digitadas por teclado, `selectOption` real, asserção pelo que FICOU na tela; zero
 * `fill`/`evaluate`/`dispatchEvent`. A API só monta o cenário; o pedido sai pela tela e é conferido na lista E no banco.
 *
 * Side-effect outbound mapeado ANTES de clicar: criar o pedido só escreve em Postgres (pedido, ausências, registro de trocas, derivação do estado);
 * nenhum import de Twilio/Periskope/Talentum/Ana Care/ClickUp/e-mail/fila no caminho. Mesmo assim cada teste registra todo host que a PÁGINA pede
 * e exige que nenhum seja de canal real (`CADEIA_FORBIDDEN_HOSTS`).
 *
 *   1. FELIZ — Varios días com substituto (5 turnos) → pedido na lista "Sustituciones"; depois "Cambiar" num turno → Un solo día (fluxo pré-preenchido);
 *   2. ALTERNATIVO 1 — o substituto já atende outro paciente nas quartas: o conflito aparece e BLOQUEIA "Siguiente" até trocar a pessoa / "Nadie todavía";
 *   3. ALTERNATIVO 2 — No vuelve más SEM substituto → resumo com "Sin cubrir" e o estado novo → confirmar → as faixas ficam "Nadie asignado".
 */
import { test, expect, type Page } from '@playwright/test';
import { mockAdminUserFor, useLancamentoStaff, LANCAMENTO_VIEWPORT_ES_AR } from '../helpers/lancamento-e2e-helper';
import { loginAs } from '../helpers/abac-stack-helper';
import { openItineraryTab, openSubstitutions, openUpcomingDays } from '../helpers/itinerario-aba-e2e-helper';
import { seedDerivablePatient, selectedWorker, allocateWorker } from '../helpers/derivacao-e2e-helper';
import { insertWJA } from '../helpers/wja-test-helper';
import { CADEIA_FORBIDDEN_HOSTS } from '../helpers/cadeia-completa-e2e-helper';
import { sqlComVars } from '../helpers/sql-com-vars';
import { cleanupSubstituicao } from '../helpers/substituicao-e2e-helper';
import {
  abrirNuevaSustitucion, confirmarPedido, diaDoBanco, irParaSemanaPeloCalendario, paso1QuienNoViene, paso2PorCuantoTiempo, paso3Nadie, paso3UnaPersona,
  paso4Motivo, proximaDataNoDia, segundaDaSemana, siguiente, somaDias,
} from '../helpers/itinerario-069-flow-helper';
import { nomeDe, semearTitularSegQuaSex } from '../helpers/itinerario-069-seed-helper';

const STAFF = mockAdminUserFor('itinerario-069-nueva');

function vigiarHosts(page: Page): () => string[] {
  const hosts: string[] = [];
  page.on('request', (r) => hosts.push(new URL(r.url()).hostname));
  return () => hosts.filter((h) => CADEIA_FORBIDDEN_HOSTS.test(h));
}

/** Ausências abertas do pedido: `data|substituto` ordenadas. */
const ausenciasDoPedido = (requestId: string): string[] =>
  sqlComVars(
    "SELECT on_date::text || '|' || coalesce(substitute_worker_id::text, '') FROM patient_itinerary_absence WHERE request_id = :'r'::uuid AND cancelled_at IS NULL ORDER BY on_date, id",
    { r: requestId },
  )
    .split('\n')
    .filter(Boolean);

test.use({ video: 'on' }); // evidência: o vídeo da execução vai anexado ao relatório (top-level: `video` força worker novo)

test.describe('patient-itinerary-069-nueva-sustitucion: o fluxo de 4 passos @integration', () => {
  test.use({ ...LANCAMENTO_VIEWPORT_ES_AR, deviceScaleFactor: 1 });
  test.describe.configure({ mode: 'serial' }); // um `beforeAll` de staff por arquivo: os 3 testes ficam no mesmo worker (o CI roda com 1)
  test.setTimeout(180_000);
  useLancamentoStaff(STAFF, 'E2E Itinerario 069 Nueva');

  test('FELIZ: Varios días com substituto (5 turnos) vira UM pedido na lista; "Cambiar" num turno abre o fluxo pré-preenchido (Un solo día)', async ({ page, request }, testInfo) => {
    const proibidos = vigiarHosts(page);
    const m = await semearTitularSegQuaSex(request);
    try {
      const nomeTitular = await nomeDe(request, m.patientId, m.serviceId, m.titular);
      const nomeSub = await nomeDe(request, m.patientId, m.serviceId, m.sub);
      const desde = proximaDataNoDia(1, diaDoBanco(1)); // uma segunda
      const hasta = somaDias(desde, 9); // seg, qua, sex, seg, qua = 5 turnos

      await loginAs(page, STAFF);
      await openItineraryTab(page, m.patientId);
      await openUpcomingDays(page, m.serviceId);
      await abrirNuevaSustitucion(page);

      await paso1QuienNoViene(page, m.titular);
      await expect(page.getByTestId('substitucion-paso')).toContainText('2');
      const cuenta = await paso2PorCuantoTiempo(page, 'DAYS', desde, hasta);
      expect(cuenta).toContain('5 turnos');
      await expect(page.getByTestId('substitucion-turnos').locator(':scope > span')).toHaveCount(5);
      await siguiente(page);

      await paso3UnaPersona(page, m.sub);
      const estados = page.locator('[data-testid^="substitucion-estado-"]');
      await expect(estados).toHaveCount(5);
      for (const estado of await estados.all()) await expect(estado).toHaveText('Libre', { timeout: 15_000 });
      await siguiente(page);

      await expect(page.getByTestId('substitucion-paso')).toContainText('4');
      await expect(page.getByTestId('substitucion-confirmar')).toBeDisabled(); // sem motivo
      await paso4Motivo(page, 'OTHER');
      await expect(page.getByTestId('substitucion-resumen-periodo')).toContainText('5 turnos');
      await expect(page.getByTestId('substitucion-resumen-bloque')).toContainText(nomeTitular);
      await expect(page.getByTestId('substitucion-resumen-bloque')).toContainText(nomeSub);
      await expect(page.getByTestId('substitucion-flujo')).toHaveScreenshot('nueva-sustitucion-paso4.png', {
        maxDiffPixelRatio: 0.05,
        mask: [page.getByTestId('substitucion-resumen')], // período, nomes: mudam a cada execução
      });
      await testInfo.attach('nueva-sustitucion-paso4', { body: await page.screenshot({ animations: 'disabled', caret: 'hide' }), contentType: 'image/png' });

      const resp = await confirmarPedido(page);
      expect(resp.status()).toBe(201);
      const requestId = ((await resp.json()) as { data: { requestId: string } }).data.requestId;
      await expect(page.getByTestId('substitucion-flujo')).toHaveCount(0, { timeout: 15_000 });

      // O pedido aparece na lista "Sustituciones" (UMA linha, 5 turnos, sale → entra) e as 5 ausências estão no banco, todas com o substituto.
      await openSubstitutions(page, m.serviceId);
      const linha = page.getByTestId(`sustitucion-${requestId}`);
      await expect(linha).toContainText('Varios días · 5 turnos');
      await expect(page.getByTestId(`sustitucion-bloque-${requestId}-sale`)).toContainText(nomeTitular);
      await expect(page.getByTestId(`sustitucion-bloque-${requestId}-entra`)).toContainText(nomeSub);
      const ausencias = ausenciasDoPedido(requestId);
      expect(ausencias).toHaveLength(5);
      expect(ausencias.every((a) => a.endsWith(`|${m.sub}`))).toBe(true);

      // Um solo día pelo "Cambiar" da tabela: a sexta da 2ª semana (fora do período) ainda é do titular → o fluxo abre direto no passo 3.
      const sexta = somaDias(desde, 11);
      await openUpcomingDays(page, m.serviceId);
      await irParaSemanaPeloCalendario(page, sexta);
      await page.getByTestId(`itinerario-proximo-cambiar-${m.slotIds[2]}-${sexta}`).click();
      await expect(page.getByTestId('substitucion-flujo')).toBeVisible();
      await expect(page.getByTestId('substitucion-paso')).toContainText('3');
      await paso3UnaPersona(page, m.sub2);
      await expect(page.locator('[data-testid^="substitucion-estado-"]')).toHaveText('Libre', { timeout: 15_000 });
      await siguiente(page);
      await paso4Motivo(page, 'OTHER');
      await expect(page.getByTestId('substitucion-resumen-periodo')).toContainText('1 turno');
      const resp2 = await confirmarPedido(page);
      expect(resp2.status()).toBe(201);
      const requestId2 = ((await resp2.json()) as { data: { requestId: string } }).data.requestId;
      expect(ausenciasDoPedido(requestId2)).toEqual([`${sexta}|${m.sub2}`]);
      await expect(page.getByTestId(`itinerario-proximo-${m.slotIds[2]}-${sexta}`)).toContainText('Sustitución', { timeout: 15_000 });

      expect(proibidos(), 'nenhum host de canal real pedido pela página').toEqual([]);
    } finally {
      m.seed.cleanup();
    }
  });

  test('ALTERNATIVO 1: o substituto atende outro paciente nas quartas → o conflito aparece e "Siguiente" fica bloqueado até trocar a pessoa ou escolher "Nadie todavía"', async ({ page, request }) => {
    const proibidos = vigiarHosts(page);
    const m = await semearTitularSegQuaSex(request);
    const outro = await seedDerivablePatient(request, { status: 'SEARCHING', services: [{ schedule: [{ dayOfWeek: 3, startTime: '08:00', durationMinutes: 240 }] }] });
    try {
      // Cenário: `sub` já atende o OUTRO paciente toda quarta 08:00-12:00 (a mesma faixa das quartas do titular).
      const svc2 = outro.services[0];
      insertWJA({ workerId: m.sub, jobPostingId: svc2.vacancyId, funnelStage: 'QUICK_RESPONSE_TEAM' });
      outro.track(m.sub, svc2.vacancyId);
      const aloc = await allocateWorker(request, outro.patientId, svc2.serviceId, svc2.slotIds[0], m.sub);
      expect(aloc.status, `alocar sub no outro paciente ${aloc.status} ${aloc.code ?? ''}`).toBe(201);

      const desde = proximaDataNoDia(1, diaDoBanco(1));
      const hasta = somaDias(desde, 9); // 5 turnos, 2 deles quartas
      await loginAs(page, STAFF);
      await openItineraryTab(page, m.patientId);
      await openUpcomingDays(page, m.serviceId);
      await abrirNuevaSustitucion(page);
      await paso1QuienNoViene(page, m.titular);
      await paso2PorCuantoTiempo(page, 'DAYS', desde, hasta);
      await siguiente(page);

      await paso3UnaPersona(page, m.sub);
      const conflitos = page.locator('[data-testid^="substitucion-estado-"]').filter({ hasText: 'Conflicto' });
      await expect(conflitos).toHaveCount(2, { timeout: 15_000 }); // as duas quartas
      await expect(page.locator('[data-testid^="substitucion-estado-"]').filter({ hasText: 'Libre' })).toHaveCount(3);
      await expect(page.locator('[data-testid^="substitucion-conflicto-"]').first()).toContainText('ya atiende a otro paciente');
      await expect(page.getByTestId('substitucion-siguiente')).toBeDisabled();
      await expect(page.getByTestId('substitucion-bloqueo')).toHaveText('Resolvé cada día para continuar.');

      // Resolver: na 1ª quarta troca a pessoa (sub2); na 2ª, "Nadie todavía". Só então o "Siguiente" libera.
      const seletores = page.locator('[data-testid^="substitucion-elegir-"]');
      await expect(seletores).toHaveCount(2);
      const [primeiro, segundo] = await seletores.all();
      const idPrimeiro = (await primeiro.getAttribute('data-testid')) as string;
      const idSegundo = (await segundo.getAttribute('data-testid')) as string;
      await primeiro.selectOption(m.sub2);
      await expect(page.getByTestId(idPrimeiro)).toHaveCount(0, { timeout: 15_000 }); // sub2 está livre → o seletor some
      await expect(page.getByTestId('substitucion-siguiente')).toBeDisabled(); // falta a outra quarta
      await page.getByTestId(idSegundo).selectOption({ label: 'Nadie todavía' });
      await expect(page.getByTestId('substitucion-siguiente')).toBeEnabled({ timeout: 15_000 });
      await siguiente(page);

      await paso4Motivo(page, 'OTHER');
      await expect(page.getByTestId('substitucion-resumen-bloque')).toContainText('salvo');
      const resp = await confirmarPedido(page);
      expect(resp.status()).toBe(201);
      const requestId = ((await resp.json()) as { data: { requestId: string } }).data.requestId;
      const ausencias = ausenciasDoPedido(requestId);
      expect(ausencias).toHaveLength(5);
      expect(ausencias.filter((a) => a.endsWith('|')).length).toBe(1); // a quarta "Nadie todavía"
      expect(ausencias.filter((a) => a.endsWith(`|${m.sub2}`)).length).toBe(1);
      expect(ausencias.filter((a) => a.endsWith(`|${m.sub}`)).length).toBe(3);
      expect(proibidos()).toEqual([]);
    } finally {
      // Ordem das FKs: a alocação do substituto no 2º paciente e as ausências do pedido apontam para a candidatura dele; saem ANTES de qualquer
      // `cleanup()` (que apaga as candidaturas e o worker, rastreado pelos dois pacientes).
      cleanupSubstituicao(outro.patientId);
      m.seed.cleanup();
      outro.cleanup();
    }
  });

  test('ALTERNATIVO 2: "No vuelve más" SEM substituto → resumo com "Sin cubrir" e o estado novo → confirmar → as faixas ficam "Nadie asignado"', async ({ page, request }) => {
    const proibidos = vigiarHosts(page);
    const m = await semearTitularSegQuaSex(request);
    try {
      const desde = diaDoBanco(3);
      await loginAs(page, STAFF);
      await openItineraryTab(page, m.patientId);
      await openUpcomingDays(page, m.serviceId);
      await abrirNuevaSustitucion(page);
      await paso1QuienNoViene(page, m.titular);
      const cuenta = await paso2PorCuantoTiempo(page, 'PERMANENT', desde);
      expect(cuenta).toContain('3 franjas');
      await siguiente(page);

      await expect(page.getByTestId('substitucion-cobertura-perDay')).toHaveCount(0); // "uma pessoa por dia" não existe na saída definitiva
      await paso3Nadie(page);
      await siguiente(page);

      await paso4Motivo(page, 'OTHER');
      const dd = desde.slice(8, 10);
      const mm = desde.slice(5, 7);
      await expect(page.getByTestId('substitucion-resumen-sin-cubrir')).toHaveText(`A partir del ${dd}/${mm} los turnos quedan Sin cubrir`);
      await expect(page.getByTestId('substitucion-resumen-bloque')).toContainText('Nadie todavía');
      await expect(page.getByTestId('substitucion-resumen-estado')).toContainText('El estado del paciente pasa de');
      const resp = await confirmarPedido(page);
      expect(resp.status()).toBe(201);
      await expect(page.getByTestId('substitucion-flujo')).toHaveCount(0, { timeout: 15_000 });

      // Banco: o titular encerra em D-1 nas 3 faixas e ninguém entra.
      const fins = sqlComVars(
        "SELECT count(*) FROM patient_itinerary_assignment a JOIN patient_itinerary_slot s ON s.id = a.slot_id WHERE s.contracted_service_id = :'s'::uuid AND a.worker_id = :'w'::uuid AND a.valid_to = (:'d'::date - 1)",
        { s: m.serviceId, w: m.titular, d: desde },
      );
      expect(fins).toBe('3');
      // Na tela: duas semanas depois de D todas as faixas estão "Nadie asignado".
      const alvo = somaDias(segundaDaSemana(desde), 14);
      await openUpcomingDays(page, m.serviceId);
      await irParaSemanaPeloCalendario(page, alvo);
      for (const [i, slotId] of m.slotIds.entries()) {
        await expect(page.getByTestId(`itinerario-proximo-sem-cobertura-${slotId}-${somaDias(alvo, [0, 2, 4][i])}`)).toContainText('Nadie asignado', { timeout: 15_000 });
      }
      expect(proibidos()).toEqual([]);
    } finally {
      m.seed.cleanup();
    }
  });
});
