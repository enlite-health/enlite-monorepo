/**
 * GoogleTransitDirections.test.ts — a FRONTEIRA EXTERNA.
 *
 * Este arquivo existe por um motivo só: é daqui que saem duas coordenadas de
 * domicílio para fora do perímetro. O teste central é o do INTERRUPTOR — sem
 * chave configurada, ZERO chamadas. Se alguém quebrar isso, um ambiente sem
 * chave passa a vazar em silêncio.
 */
// `export {}` faz deste arquivo um MÓDULO. Sem nenhum import estático no topo,
// o TypeScript o trata como script global e as consts de topo caem no escopo
// global — colidindo com outro teste que também declara `mockFetch`
// (`tests/unit/__tests__/TalentumDescriptionService.test.ts`). O `tsc` do CI
// reprova com `TS2451: Cannot redeclare block-scoped variable`, e a suíte
// inteira nem chega a rodar: a cobertura deste arquivo despenca para 38% e o
// portão fecha. Não deu aqui porque o jest local transpila sem checar o
// programa inteiro — foi o CI que viu.
export {};

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const mockInfo = jest.fn();
jest.mock('@shared/logging', () => ({ logger: { info: (...a: unknown[]) => mockInfo(...a) } }));

const A = { lat: -34.6094, lng: -58.3923 };
const B = { lat: -34.6037, lng: -58.3816 };

/** Recarrega o módulo para a chave ser lida do ambiente ATUAL. */
async function comChave(key: string | undefined) {
  jest.resetModules();
  if (key === undefined) {
    delete process.env.GOOGLE_DIRECTIONS_API_KEY;
    delete process.env.GOOGLE_MAPS_API_KEY;
  } else {
    process.env.GOOGLE_DIRECTIONS_API_KEY = key;
  }
  const { GoogleTransitDirections } = await import('../GoogleTransitDirections');
  return new GoogleTransitDirections();
}

describe('GoogleTransitDirections', () => {
  const env = { ...process.env };
  beforeEach(() => { jest.clearAllMocks(); });
  afterEach(() => { process.env = { ...env }; });

  it('🔒 INTERRUPTOR: sem chave, NENHUMA chamada externa e nenhuma coordenada sai', async () => {
    const svc = await comChave(undefined);
    expect(svc.enabled).toBe(false);
    const r = await svc.transit(A, B);
    expect(r).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
    // e o motivo fica no log, para não parecer "não achou rota"
    expect(mockInfo).toHaveBeenCalledWith({ msg: 'directions.skipped', reason: 'no_api_key' });
  });

  it('chama a ROUTES API (não a legada) com TRANSIT, alternativas e FieldMask', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ routes: [{ legs: [] }] }) });
    const svc = await comChave('k-servidor');
    expect(svc.enabled).toBe(true);

    const r = await svc.transit(A, B);
    expect(r).toEqual([{ legs: [] }]);

    const [url, init] = mockFetch.mock.calls[0];
    // A Directions clássica está APOSENTADA — chamá-la devolve REQUEST_DENIED.
    expect(url).toBe('https://routes.googleapis.com/directions/v2:computeRoutes');
    expect(url).not.toContain('maps/api/directions');
    expect(init.method).toBe('POST');
    expect(init.headers['X-Goog-Api-Key']).toBe('k-servidor');
    // FieldMask é OBRIGATÓRIO na Routes API: sem ele a chamada é recusada.
    expect(init.headers['X-Goog-FieldMask']).toContain('routes.legs.steps.transitDetails');
    expect(JSON.parse(init.body)).toEqual({
      origin: { location: { latLng: { latitude: A.lat, longitude: A.lng } } },
      destination: { location: { latLng: { latitude: B.lat, longitude: B.lng } } },
      travelMode: 'TRANSIT',
      computeAlternativeRoutes: true,
      languageCode: 'es',
    });
  });

  it('🔒 C1 do parecer: pede o traçado no caminho MAIS ESTREITO, e nada além dele', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ routes: [{ legs: [] }] }) });
    await (await comChave('k')).transit(A, B);
    const mask = mockFetch.mock.calls[0][1].headers['X-Goog-FieldMask'];

    // Só a geometria do PASSO. `routes.polyline` e `routes.legs.polyline`
    // trariam o traçado agregado de novo, sem serem desenhados por ninguém.
    expect(mask).toContain('routes.legs.steps.polyline.encodedPolyline');
    expect(mask).not.toMatch(/(^|,)routes\.polyline/);
    expect(mask).not.toMatch(/(^|,)routes\.legs\.polyline/);

    // E o CORPO não muda: é ele que carrega as coordenadas para fora. Pedir o
    // traçado é um header — não é mais dado saindo, é mais dado voltando.
    // `polylineQuality` ausente = default OVERVIEW, com menos pontos.
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('polylineQuality');
    expect(Object.keys(body).sort()).toEqual(
      ['computeAlternativeRoutes', 'destination', 'languageCode', 'origin', 'travelMode'],
    );
  });

  it('🔒 C2 do parecer: a POLILINHA nunca entra no log — id + geometria dispensa trilateração', async () => {
    // Uma linha de trilha com o par de ids E o traçado entrega o domicílio
    // direto, sem precisar cruzar N observações. Por isso o log é conferido
    // contra a string real, e não contra a ausência de uma chave.
    const TRACADO = 'r|rnEnjmxJ?kBnAA';
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ routes: [{ legs: [{ steps: [{ travelMode: 'WALK', polyline: { encodedPolyline: TRACADO } }] }] }] }),
    });
    const r = await (await comChave('k')).transit(A, B);

    // volta para quem desenha…
    expect(JSON.stringify(r)).toContain(TRACADO);
    // …e não aparece em NENHUMA chamada de log, em nenhum caminho.
    const logado = JSON.stringify(mockInfo.mock.calls);
    expect(logado).not.toContain(TRACADO);
    expect(logado).not.toContain('encodedPolyline');
  });

  it('200 sem rotas é resposta legítima ("não há trajeto"), não erro', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    expect(await (await comChave('k')).transit(A, B)).toEqual([]);
    expect(mockInfo).toHaveBeenCalledWith({ msg: 'directions.no_route' });

    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ routes: [] }) });
    expect(await (await comChave('k')).transit(A, B)).toEqual([]);
  });

  it('🔒 recusa do Google registra só o STATUS — o corpo do erro ecoa as coordenadas', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 403, text: async () => 'latitude:-34.6094 longitude:-58.3923' });
    const r = await (await comChave('k')).transit(A, B);
    expect(r).toEqual([]);
    const logado = JSON.stringify(mockInfo.mock.calls);
    expect(logado).toContain('directions.denied');
    expect(logado).toContain('403');
    expect(logado).not.toContain('-34.60');
    expect(logado).not.toContain('-58.39');
  });

  it('🔒 falha de rede também não vaza a mensagem, que carrega a URL', async () => {
    mockFetch.mockRejectedValue(new Error('connect ETIMEDOUT routes.googleapis.com origin=-34.6094'));
    expect(await (await comChave('k')).transit(A, B)).toEqual([]);
    const logado = JSON.stringify(mockInfo.mock.calls);
    expect(logado).toContain('directions.failed');
    expect(logado).not.toContain('-34.60');
  });

  it('TIMEOUT: chamada pendurada é abortada em 8s — não segura a request do painel', async () => {
    jest.useFakeTimers();
    let sinal: AbortSignal | undefined;
    mockFetch.mockImplementation((_u: string, init: { signal: AbortSignal }) => {
      sinal = init.signal;
      return new Promise((_r, rej) => { init.signal.addEventListener('abort', () => rej(new Error('aborted'))); });
    });

    const svc = await comChave('k');
    const p = svc.transit(A, B);
    expect(sinal?.aborted).toBe(false);
    jest.advanceTimersByTime(8000);
    await expect(p).resolves.toEqual([]);
    expect(sinal?.aborted).toBe(true);
    jest.useRealTimers();
  });

  it('rejeição que não é Error também é contida', async () => {
    mockFetch.mockRejectedValue('boom');
    expect(await (await comChave('k')).transit(A, B)).toEqual([]);
    expect(JSON.stringify(mockInfo.mock.calls)).toContain('"kind":"unknown"');
  });

  it('cai para GOOGLE_MAPS_API_KEY enquanto não houver chave dedicada', async () => {
    jest.resetModules();
    delete process.env.GOOGLE_DIRECTIONS_API_KEY;
    process.env.GOOGLE_MAPS_API_KEY = 'k-antiga';
    const { GoogleTransitDirections } = await import('../GoogleTransitDirections');
    expect(new GoogleTransitDirections().enabled).toBe(true);
  });
});
