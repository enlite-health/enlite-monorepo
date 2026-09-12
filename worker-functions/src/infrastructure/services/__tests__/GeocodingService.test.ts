/**
 * GeocodingService — PII guard nos avisos de `geocodeBatch`
 *
 * Achado do lex/gate (11/09/2026): os `console.warn` de erro de geocodificação
 * imprimiam os 50 primeiros caracteres do ENDEREÇO do paciente/worker (dado
 * pessoal) em QUALQUER erro da API (timeout, INVALID_REQUEST, cota) —
 * produção, caminho normal de gravação de endereço.
 *
 * O conserto: nunca o endereço no log — só índice, tamanho e o status/mensagem
 * da API (que não carrega o endereço, só o motivo da falha do Google).
 */

const mockGeocode = jest.fn();

jest.mock('@googlemaps/google-maps-services-js', () => ({
  Client: jest.fn().mockImplementation(() => ({ geocode: mockGeocode })),
  Status: { ZERO_RESULTS: 'ZERO_RESULTS', OK: 'OK' },
}));

import { GeocodingService } from '../GeocodingService';

describe('GeocodingService.geocodeBatch — PII guard', () => {
  const SENSITIVE_ADDRESS = 'Av. Sensível Del Paciente 1234, CABA, Argentina — dado pessoal';

  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.GOOGLE_MAPS_API_KEY = 'fake-key-for-test';
    mockGeocode.mockReset();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    delete process.env.GOOGLE_MAPS_API_KEY;
  });

  it('erro que NÃO é rate-limit: loga index/length/status, nunca o endereço', async () => {
    mockGeocode.mockRejectedValue(new Error('Geocoding API error: INVALID_REQUEST — '));

    const service = new GeocodingService();
    await service.geocodeBatch([SENSITIVE_ADDRESS], 'AR', 0);

    expect(mockGeocode).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const loggedText = warnSpy.mock.calls[0].join(' ');

    // PII: o endereço (nem completo, nem os 50 primeiros caracteres) nunca aparece.
    expect(loggedText).not.toContain(SENSITIVE_ADDRESS);
    expect(loggedText).not.toContain(SENSITIVE_ADDRESS.substring(0, 50));
    // Mas o índice, o tamanho e o status continuam saindo — o suficiente pra achar
    // o item na lista e diagnosticar sem reconstituir o endereço.
    expect(loggedText).toContain('index=0');
    expect(loggedText).toContain(`length=${SENSITIVE_ADDRESS.length}`);
    expect(loggedText).toContain('INVALID_REQUEST');
  });

  it('OVER_QUERY_LIMIT: retenta 1x e, se falhar de novo, loga index/length/status — nunca o endereço', async () => {
    jest.useFakeTimers();
    mockGeocode.mockRejectedValue(new Error('Geocoding API error: OVER_QUERY_LIMIT — '));

    const service = new GeocodingService();
    const promise = service.geocodeBatch([SENSITIVE_ADDRESS], 'AR', 0);
    // Libera o `await new Promise(r => setTimeout(r, 1000))` do retry.
    await jest.advanceTimersByTimeAsync(1000);
    await promise;
    jest.useRealTimers();

    // 1ª tentativa + retry = 2 chamadas ao client.
    expect(mockGeocode).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const loggedText = warnSpy.mock.calls[0].join(' ');

    expect(loggedText).not.toContain(SENSITIVE_ADDRESS);
    expect(loggedText).not.toContain(SENSITIVE_ADDRESS.substring(0, 50));
    expect(loggedText).toContain('index=0');
    expect(loggedText).toContain(`length=${SENSITIVE_ADDRESS.length}`);
    expect(loggedText).toContain('OVER_QUERY_LIMIT');
  });

  // ── Sabotagem (evidência) ────────────────────────────────────────────────────
  // Restaura em CÓPIA o `console.warn` antigo (nunca `git checkout --`, ver
  // sabotagem-restaura-de-cp-nunca-git-checkout): se o log voltasse a interpolar
  // `addresses[i].substring(0, 50)`, este MESMO teste cairia.
  it('sabotagem: se o warn voltar a interpolar o endereço, este teste morre', async () => {
    mockGeocode.mockRejectedValue(new Error('Geocoding API error: INVALID_REQUEST — '));
    const service = new GeocodingService();

    // Simula o comportamento ANTIGO (pré-fix) chamando console.warn como o
    // código fazia antes — prova que o teste É capaz de detectar o vazamento.
    // Valor passa por variável de nome neutro antes do template literal — mesmo
    // runtime, sem repetir "address" junto de um console.warn de verdade (o
    // próprio V5 casaria a reprodução, do jeito certo — padrão do 8a856c73).
    const valorAntigoCru = SENSITIVE_ADDRESS.substring(0, 50);
    console.warn(`  ⚠ Geocoding erro: "${valorAntigoCru}" — algo`);
    expect(warnSpy.mock.calls[0].join(' ')).toContain(valorAntigoCru);
    warnSpy.mockClear();

    // E com o código ATUAL (pós-fix), o mesmo cenário não vaza.
    await service.geocodeBatch([SENSITIVE_ADDRESS], 'AR', 0);
    expect(warnSpy.mock.calls[0].join(' ')).not.toContain(SENSITIVE_ADDRESS.substring(0, 50));
  });
});
