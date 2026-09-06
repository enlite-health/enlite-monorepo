/**
 * transitRoute.test.ts — a forma da rota, sem rede.
 *
 * O eixo é a BALDEAÇÃO: em Buenos Aires não existe terminal e trocar de veículo
 * obriga a andar até outra parada e pagar de novo (Marcel, 02/09). Por isso ela
 * é contada, ordenada na frente do tempo, e um trajeto sem transporte nenhum
 * ("vá andando 4 km") é DESCARTADO — no painel de transporte ele responderia
 * outra pergunta.
 */
import { buildTransitRoutes, normalizeVehicle, parseDuration, MAX_ROUTES, type RawRoute } from '../transitRoute';
import REAL from './fixtures/routes-api-caba.json';

// Formato da Routes API — MEDIDO, não suposto (ver o cabeçalho do módulo).
const walk = (sec: number, m: number) => ({ travelMode: 'WALK', staticDuration: `${sec}s`, distanceMeters: m });
const bus = (sec: number, line: string, from: string, to: string, type = 'BUS') => ({
  travelMode: 'TRANSIT',
  staticDuration: `${sec}s`,
  transitDetails: {
    transitLine: { nameShort: line, vehicle: { type } },
    stopDetails: { departureStop: { name: from }, arrivalStop: { name: to } },
  },
});
const route = (totalSec: number, steps: unknown[]): RawRoute =>
  ({ duration: `${totalSec}s`, legs: [{ duration: `${totalSec}s`, steps: steps as never }] });

describe('transitRoute', () => {
  it('converte um trajeto real: pernas a pé e de ônibus, total e linhas', () => {
    const r = buildTransitRoutes([route(2040, [walk(240, 320), bus(1560, '8', '459 Libertad', 'H. Yrigoyen 340'), walk(240, 240)])]);

    expect(r.outcome).toBe('ok');
    expect(r.routes[0]).toMatchObject({ totalMinutes: 34, transfers: 0, lines: ['8'] });
    expect(r.routes[0].legs).toEqual([
      { kind: 'walk', minutes: 4, meters: 320 },
      { kind: 'transit', minutes: 26, line: '8', mode: 'bus', from: '459 Libertad', to: 'H. Yrigoyen 340' },
      { kind: 'walk', minutes: 4, meters: 240 },
    ]);
  });

  it('BALDEAÇÃO é contada — dois veículos é UMA troca, e ela vem antes do tempo na ordenação', () => {
    const direto = route(3000, [bus(3000, '8', 'a', 'b')]);                       // 50 min, 0 baldeações
    const comTroca = route(1800, [bus(900, '24', 'a', 'x'), walk(120, 180), bus(780, '132', 'x', 'b')]); // 30 min, 1

    const r = buildTransitRoutes([comTroca, direto]);

    expect(r.routes[0]).toMatchObject({ transfers: 0, totalMinutes: 50 });
    expect(r.routes[1]).toMatchObject({ transfers: 1, totalMinutes: 30 });
    // o mais RÁPIDO não vem primeiro se exigir pagar outra passagem
    expect(r.routes[0].lines).toEqual(['8']);
  });

  it('empate de baldeação desempata pelo tempo', () => {
    const r = buildTransitRoutes([route(3600, [bus(3600, 'lento', 'a', 'b')]), route(600, [bus(600, 'rapido', 'a', 'b')])]);
    expect(r.routes.map((x) => x.lines[0])).toEqual(['rapido', 'lento']);
  });

  it('trajeto SÓ a pé é descartado — o Google devolve isso e não é transporte público', () => {
    const r = buildTransitRoutes([route(6000, [walk(6000, 5000)])]);
    expect(r.outcome).toBe('sem_ruta');
    expect(r.routes).toEqual([]);
  });

  it('nenhum trajeto é `sem_ruta`, não um erro nem uma lista vazia disfarçada', () => {
    expect(buildTransitRoutes([])).toEqual({ outcome: 'sem_ruta', routes: [] });
  });

  it(`mostra no máximo ${MAX_ROUTES} alternativas`, () => {
    const muitas = Array.from({ length: 8 }, (_, i) => route(600 + i * 60, [bus(600, `L${i}`, 'a', 'b')]));
    expect(buildTransitRoutes(muitas).routes).toHaveLength(MAX_ROUTES);
  });

  it('resposta capenga do Google não estoura: sem legs, sem steps, sem duração', () => {
    expect(buildTransitRoutes([{}]).outcome).toBe('sem_ruta');
    expect(buildTransitRoutes([{ legs: [] }]).outcome).toBe('sem_ruta');
    const semDuracao = buildTransitRoutes([route(0, [{ travelMode: 'TRANSIT', transitDetails: {} }])]);
    // duração ausente vira 1 min, nunca 0 nem NaN
    expect(semDuracao.routes[0]).toMatchObject({ totalMinutes: 1, lines: ['—'] });
    expect(semDuracao.routes[0].legs[0]).toMatchObject({ minutes: 1, from: '', to: '' });
  });

  it('step SEM `travelMode` e SEM distância cai em caminhada de 1 min e 0 m', () => {
    // O Google omite campos em rota degradada; sem os fallbacks isto viraria
    // `undefined.toUpperCase()` e `NaN` metros na tela.
    const r = buildTransitRoutes([route(900, [{}, bus(900, '8', 'a', 'b')])]);
    expect(r.outcome).toBe('ok');
    expect(r.routes[0].legs[0]).toEqual({ kind: 'walk', minutes: 1, meters: 0 });
  });

  it('usa `name` quando não há `short_name` (linhas de trem costumam só ter nome longo)', () => {
    const r = buildTransitRoutes([route(600, [{
      travelMode: 'TRANSIT', staticDuration: '600s',
      transitDetails: { transitLine: { name: 'Línea Mitre', vehicle: { type: 'HEAVY_RAIL' } } },
    }])]);
    expect(r.routes[0].lines).toEqual(['Línea Mitre']);
    expect(r.routes[0].legs[0]).toMatchObject({ mode: 'train' });
  });

  describe('contra a RESPOSTA REAL da Routes API (fixture medida em 05/09)', () => {
    it('lê a rota de verdade: 9 min, direto, linha 50, com as paradas', () => {
      const r = buildTransitRoutes(REAL.routes as RawRoute[]);

      expect(r.outcome).toBe('ok');
      expect(r.routes[0]).toMatchObject({ totalMinutes: 9, transfers: 0, lines: ['50'] });
      const transito = r.routes[0].legs.find((l) => l.kind === 'transit');
      expect(transito).toMatchObject({
        line: '50', mode: 'bus', minutes: 5,
        from: 'Congreso (6 - 50)', to: 'Avenida Corrientes Y Suipacha (180)',
      });
      // nada de NaN: a duração vem como "561s" e um Number() ingênuo daria NaN
      for (const l of r.routes[0].legs) expect(Number.isFinite(l.minutes)).toBe(true);
    });

    it('DUPLICATAS: das 3 rotas devolvidas, DUAS são idênticas — a tela mostra 2', () => {
      // Medido na fixture: rotas 0 e 1 são a mesma (linha 50, 561s, 5 passos);
      // a 2 é outra (linha 8, 737s). Sem a deduplicação o operador veria a
      // mesma opção duas vezes e acharia que são alternativas diferentes.
      expect((REAL.routes as RawRoute[]).length).toBe(3);
      const r = buildTransitRoutes(REAL.routes as RawRoute[]);
      expect(r.routes).toHaveLength(2);
      expect(r.routes.map((x) => x.lines[0])).toEqual(['50', '8']);
      // e a mais rápida vem primeiro, já que ambas são diretas
      expect(r.routes[0].totalMinutes).toBeLessThan(r.routes[1].totalMinutes);
    });

    it('PERNAS A PÉ CONSECUTIVAS viram uma só — o Google fatia a caminhada', () => {
      const legs = buildTransitRoutes(REAL.routes as RawRoute[]).routes[0].legs;
      // na fixture são 5 passos (2 a pé + transporte + 2 a pé) → viram 3
      expect(legs.map((l) => l.kind)).toEqual(['walk', 'transit', 'walk']);
      // e os metros somam, em vez de sumir
      const aPe = legs.filter((l): l is Extract<typeof l, { kind: 'walk' }> => l.kind === 'walk');
      expect(aPe[0].meters).toBe(83);   // 35 + 48
      expect(aPe[1].meters).toBe(186);  // 126 + 60
    });
  });

  it('sem `duration` na leg, cai na duração da ROTA (que inclui espera)', () => {
    const r = buildTransitRoutes([{ duration: '900s', legs: [{ steps: [bus(600, '8', 'a', 'b')] as never }] }]);
    expect(r.routes[0].totalMinutes).toBe(15);
  });

  it('caminhadas coladas SEM metros somam sem virar NaN', () => {
    const r = buildTransitRoutes([route(600, [
      { travelMode: 'WALK', staticDuration: '60s' },
      { travelMode: 'WALK', staticDuration: '60s', distanceMeters: 50 },
      bus(480, '8', 'a', 'b'),
    ])]);
    expect(r.routes[0].legs[0]).toEqual({ kind: 'walk', minutes: 2, meters: 50 });
  });

  describe('parseDuration', () => {
    it('lê o formato "561s" da Routes API, e nunca devolve NaN', () => {
      expect(parseDuration('561s')).toBe(561);
      expect(parseDuration('0s')).toBe(0);
      expect(parseDuration('600')).toBe(600);
      expect(parseDuration(undefined)).toBe(0);
      expect(parseDuration('')).toBe(0);
      expect(parseDuration('abc')).toBe(0);
    });
  });

  describe('normalizeVehicle', () => {
    it('agrupa o vocabulário do Google nos quatro modos que a tela desenha', () => {
      expect(normalizeVehicle('BUS')).toBe('bus');
      expect(normalizeVehicle('INTERCITY_BUS')).toBe('bus');
      expect(normalizeVehicle('SUBWAY')).toBe('subway');
      expect(normalizeVehicle('METRO_RAIL')).toBe('subway');
      expect(normalizeVehicle('TRAM')).toBe('tram');
      expect(normalizeVehicle('LIGHT_RAIL')).toBe('tram');
      expect(normalizeVehicle('HEAVY_RAIL')).toBe('train');
      expect(normalizeVehicle('COMMUTER_TRAIN')).toBe('train');
      // desconhecido e ausente caem em ônibus, que é o modo dominante da AMBA
      expect(normalizeVehicle('FUNICULAR')).toBe('bus');
      expect(normalizeVehicle(undefined)).toBe('bus');
    });
  });
});
