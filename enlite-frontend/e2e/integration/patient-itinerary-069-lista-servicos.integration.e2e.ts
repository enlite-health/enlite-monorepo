/**
 * patient-itinerary-069-lista-servicos.integration.e2e.ts @integration — spec 069, F7 (US1): a aba Itinerario abre numa LISTA de serviços (B1).
 * Stack REAL (frontend + API + Postgres), sem mock de dado de negócio — só a auth é o mock do stack (`loginAs`). Régua humana (memória
 * `e2e-humano-nao-e-fill`): cliques reais, texto lido da TELA; a API só monta o cenário e é o oráculo das contagens.
 *
 * Side-effect outbound mapeado ANTES de clicar: a aba só LÊ (`GET …/itinerary`, `…/occurrences`, `…/substitution-requests`) e navega; o cenário usa
 * API do próprio stack (Postgres). Mesmo assim cada teste registra todo host que a PÁGINA pede e exige que nenhum seja de canal real.
 *
 *   1. FELIZ — 2 serviços → 2 cartões, cada um com o estado ESTRUTURAL ("Completo" / "Faltan cubrir X h de Y") e o aviso TEMPORÁRIO em faixa separada;
 *   2. ALTERNATIVO 1 — 1 serviço → abre a tela do serviço direto, sem lista e sem "Volver a los servicios";
 *   3. ALTERNATIVO 2 — atalho da vacante com `serviceId` de OUTRO paciente → a lista, sem erro (controle: o `serviceId` certo abre o B2 e "Volver" leva à lista).
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { mockAdminUserFor, useLancamentoStaff, LANCAMENTO_VIEWPORT_ES_AR } from '../helpers/lancamento-e2e-helper';
import { loginAs } from '../helpers/abac-stack-helper';
import { openItineraryTab } from '../helpers/itinerario-aba-e2e-helper';
import { seedDerivablePatient, selectedWorker, allocateWorker, derivacaoToken } from '../helpers/derivacao-e2e-helper';
import { assembleApi } from '../helpers/itinerario-escrita-e2e-helper';
import { CADEIA_FORBIDDEN_HOSTS } from '../helpers/cadeia-completa-e2e-helper';
import { criarPedidoViaApi, diaDoBanco, proximaDataNoDia, turnosDaPessoa } from '../helpers/itinerario-069-flow-helper';
import { servicoDaRota } from '../helpers/itinerario-069-seed-helper';

const STAFF = mockAdminUserFor('itinerario-069-lista');
const SEGUNDA_4H = { schedule: [{ dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 }] };
const QUARTA_4H = { schedule: [{ dayOfWeek: 3, startTime: '08:00', durationMinutes: 240 }] };

function vigiarHosts(page: Page): () => string[] {
  const hosts: string[] = [];
  page.on('request', (r) => hosts.push(new URL(r.url()).hostname));
  return () => hosts.filter((h) => CADEIA_FORBIDDEN_HOSTS.test(h));
}

/** Paciente com 2 serviços: S1 (segunda 4 h) com titular alocado e UMA falta sem substituto na próxima segunda; S2 (quarta 4 h) sem ninguém. */
async function semearDoisServicos(request: APIRequestContext) {
  const seed = await seedDerivablePatient(request, { status: 'SEARCHING', services: [SEGUNDA_4H, QUARTA_4H] });
  try {
    const [s1, s2] = seed.services;
    const titular = selectedWorker(seed, s1.vacancyId);
    const alocacao = await allocateWorker(request, seed.patientId, s1.serviceId, s1.slotIds[0], titular);
    expect(alocacao.status, `alocar ${alocacao.status} ${alocacao.code ?? ''}`).toBe(201);
    // O aviso "N turnos sin cubrir" só existe para itinerário MONTADO (P13: faixa sem prestador de itinerário não montado é falta estrutural).
    const montar = await assembleApi(request, derivacaoToken(), seed.patientId);
    expect(montar.status, `montar ${montar.status}`).toBeLessThan(300);
    const segunda = proximaDataNoDia(1, diaDoBanco(1)); // dentro dos próximos 7 dias, sempre
    const turnos = await turnosDaPessoa(request, seed.patientId, s1.serviceId, titular, segunda, segunda);
    await criarPedidoViaApi(request, seed.patientId, s1.serviceId, {
      type: 'ONE_DAY', outgoingWorkerId: titular, from: segunda,
      shifts: turnos.map((t) => ({ ...t, substituteWorkerId: null })),
    });
    return { seed, s1: s1.serviceId, s2: s2.serviceId };
  } catch (err) {
    seed.cleanup();
    throw err;
  }
}

test.use({ video: 'on' }); // evidência: o vídeo da execução vai anexado ao relatório (top-level: `video` força worker novo)

test.describe('patient-itinerary-069-lista-servicos: a aba abre na lista de serviços @integration', () => {
  test.use({ ...LANCAMENTO_VIEWPORT_ES_AR, deviceScaleFactor: 1 });
  test.describe.configure({ mode: 'serial' }); // um `beforeAll` de staff por arquivo: os 3 testes ficam no mesmo worker (o CI roda com 1)
  test.setTimeout(150_000);
  useLancamentoStaff(STAFF, 'E2E Itinerario 069 Lista');

  test('FELIZ: 2 serviços → 2 cartões, estado estrutural de cada um e o aviso temporário em faixa SEPARADA', async ({ page, request }, testInfo) => {
    const proibidos = vigiarHosts(page);
    const m = await semearDoisServicos(request);
    try {
      const s1 = await servicoDaRota(request, m.seed.patientId, m.s1);
      const s2 = await servicoDaRota(request, m.seed.patientId, m.s2);
      expect(s1.uncoveredShifts, 'oráculo da rota: a falta sem substituto da próxima segunda').toBeGreaterThan(0);

      await loginAs(page, STAFF);
      await openItineraryTab(page, m.seed.patientId);

      await expect(page.getByTestId('itinerario-lista-servicos')).toBeVisible();
      await expect(page.locator('[data-testid^="itinerario-cartao-abrir-"]')).toHaveCount(2);
      await expect(page.getByTestId(`itinerario-servico-tela-${m.s1}`)).toHaveCount(0); // lista, não a tela do serviço

      // S1: titular cobre as 4 h → "Completo" (estrutural); a falta temporária NÃO muda isso e vem em OUTRA faixa.
      await expect(page.getByTestId(`itinerario-cartao-estado-${m.s1}`)).toHaveText(`Completo · ${s1.scheduleHours} h`);
      const avisoS1 = page.getByTestId(`itinerario-cartao-sem-cobrir-${m.s1}`);
      await expect(avisoS1).toHaveText(`${s1.uncoveredShifts} ${s1.uncoveredShifts === 1 ? 'turno' : 'turnos'} sin cubrir en los próximos ${s1.horizonDays} días`);
      expect(await page.getByTestId(`itinerario-cartao-estado-${m.s1}`).innerText()).not.toContain('sin cubrir');

      // S2: ninguém → "Faltan cubrir 4 h de 4"; o aviso (se houver) vem do mesmo oráculo.
      await expect(page.getByTestId(`itinerario-cartao-estado-${m.s2}`)).toHaveText(`Faltan cubrir ${s2.scheduleHours - s2.cobertas} h de ${s2.scheduleHours}`);
      await expect(page.getByTestId(`itinerario-cartao-sem-cobrir-${m.s2}`)).toHaveCount(s2.uncoveredShifts > 0 ? 1 : 0);
      await expect(page.getByTestId(`itinerario-cartao-dias-${m.s1}`)).toHaveText('Lun');
      await expect(page.getByTestId(`itinerario-cartao-dias-${m.s2}`)).toHaveText('Mié');

      // "Organizar agenda" abre a tela do serviço escolhido.
      await page.getByTestId(`itinerario-cartao-abrir-${m.s2}`).click();
      await expect(page.getByTestId(`itinerario-servico-tela-${m.s2}`)).toBeVisible();
      await expect(page.getByTestId('itinerario-voltar-servicos')).toBeVisible();

      await page.getByTestId('itinerario-voltar-servicos').click();
      await expect(page.getByTestId('itinerario-lista-servicos')).toBeVisible();
      await expect(page.getByTestId('itinerario-lista-servicos')).toHaveScreenshot('lista-servicos.png', {
        maxDiffPixelRatio: 0.05,
        mask: [page.locator('.break-words'), page.locator('[data-testid^="itinerario-cartao-reserva-"]')], // endereço e nº do caso mudam a cada massa
      });
      await testInfo.attach('lista-servicos', { body: await page.screenshot({ animations: 'disabled', caret: 'hide' }), contentType: 'image/png' });
      expect(proibidos(), 'nenhum host de canal real pedido pela página').toEqual([]);
    } finally {
      m.seed.cleanup();
    }
  });

  test('ALTERNATIVO 1: 1 serviço só → abre a tela do serviço direto, sem lista e sem "Volver a los servicios"', async ({ page, request }) => {
    const proibidos = vigiarHosts(page);
    const seed = await seedDerivablePatient(request, { status: 'SEARCHING', services: [SEGUNDA_4H] });
    try {
      const serviceId = seed.services[0].serviceId;
      await loginAs(page, STAFF);
      await openItineraryTab(page, seed.patientId);

      await expect(page.getByTestId(`itinerario-servico-tela-${serviceId}`)).toBeVisible();
      await expect(page.getByTestId('itinerario-lista-servicos')).toHaveCount(0);
      await expect(page.getByTestId('itinerario-voltar-servicos')).toHaveCount(0);
      await expect(page.getByTestId('itinerario-aba-upcoming')).toHaveAttribute('aria-selected', 'true'); // "Próximos días" é a aba padrão
      expect(proibidos()).toEqual([]);
    } finally {
      seed.cleanup();
    }
  });

  test('ALTERNATIVO 2: atalho da vacante com serviceId de OUTRO paciente → cai na lista, sem erro (controle: o serviceId certo abre o B2)', async ({ page, request }) => {
    const proibidos = vigiarHosts(page);
    const m = await semearDoisServicos(request);
    const alheio = await seedDerivablePatient(request, { status: 'SEARCHING', services: [SEGUNDA_4H] });
    try {
      await loginAs(page, STAFF);
      const erros: string[] = [];
      page.on('pageerror', (e) => erros.push(e.message));

      await page.goto(`/admin/patients/${m.seed.patientId}?tab=itinerary&serviceId=${alheio.services[0].serviceId}`);
      await expect(page.getByTestId('itinerario-lista-servicos')).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('[data-testid^="itinerario-cartao-abrir-"]')).toHaveCount(2);
      await expect(page.getByTestId('itinerario-erro')).toHaveCount(0);
      await expect(page.locator('[data-testid^="itinerario-servico-tela-"]')).toHaveCount(0);

      // Controle positivo: o MESMO atalho com o serviço do paciente abre direto o B2 daquele serviço.
      await page.goto(`/admin/patients/${m.seed.patientId}?tab=itinerary&serviceId=${m.s2}`);
      await expect(page.getByTestId(`itinerario-servico-tela-${m.s2}`)).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('itinerario-lista-servicos')).toHaveCount(0);
      await page.getByTestId('itinerario-voltar-servicos').click();
      await expect(page.getByTestId('itinerario-lista-servicos')).toBeVisible();

      expect(erros, 'nenhum erro de página').toEqual([]);
      expect(proibidos()).toEqual([]);
    } finally {
      alheio.cleanup();
      m.seed.cleanup();
    }
  });
});
