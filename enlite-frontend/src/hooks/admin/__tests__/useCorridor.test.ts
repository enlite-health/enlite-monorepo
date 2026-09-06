/**
 * useCorridor.test.ts
 *
 * O eixo aqui é ECONOMIA DE CHAMADA, e não por performance: a rota devolve a
 * relação entre duas pessoas e o backend a limita a 60/min por staff. Um hook
 * que consultasse sem par, ou que reconsultasse o mesmo par a cada reabertura
 * do balão, transformaria navegação normal em varredura.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useCorridor, corridorPairFor, __clearCorridorCache } from '../useCorridor';
import { AdminMapApiService, type CorridorRequest, type CorridorResponse } from '@infrastructure/http/AdminMapApiService';

vi.mock('@infrastructure/http/AdminMapApiService', () => ({
  AdminMapApiService: { getCorridor: vi.fn() },
}));

const OK: CorridorResponse = {
  outcome: 'ok',
  straightLineMeters: 1167,
  routes: [{ totalMinutes: 34, transfers: 0, lines: ['8'], legs: [{ kind: 'transit', minutes: 34, line: '8', mode: 'bus', from: 'a', to: 'b' }] }],
};
const PAR: CorridorRequest = { country: 'AR', workerId: 'w1', patientAddressId: 'a1' };

describe('useCorridor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __clearCorridorCache();
  });

  it('sem par NÃO chama a API e não afirma nada', () => {
    const { result } = renderHook(() => useCorridor(null));
    expect(AdminMapApiService.getCorridor).not.toHaveBeenCalled();
    expect(result.current).toEqual({ data: null, isLoading: false, error: null });
  });

  it('com par, busca uma vez e entrega o corredor', async () => {
    vi.mocked(AdminMapApiService.getCorridor).mockResolvedValue(OK);
    const { result } = renderHook(() => useCorridor(PAR));
    await waitFor(() => expect(result.current.data).toEqual(OK));
    expect(result.current.isLoading).toBe(false);
    expect(AdminMapApiService.getCorridor).toHaveBeenCalledTimes(1);
    expect(AdminMapApiService.getCorridor).toHaveBeenCalledWith(PAR);
  });

  it('reabrir o MESMO par não gasta chamada nova (cache por par)', async () => {
    vi.mocked(AdminMapApiService.getCorridor).mockResolvedValue(OK);
    const primeira = renderHook(() => useCorridor(PAR));
    await waitFor(() => expect(primeira.result.current.data).toEqual(OK));
    primeira.unmount();

    const segunda = renderHook(() => useCorridor(PAR));
    // sem `isLoading` intermediário: o valor já estava em mãos
    expect(segunda.result.current).toEqual({ data: OK, isLoading: false, error: null });
    expect(AdminMapApiService.getCorridor).toHaveBeenCalledTimes(1);
  });

  it('par DIFERENTE é outra chamada — o cache é por par, não global', async () => {
    vi.mocked(AdminMapApiService.getCorridor).mockResolvedValue(OK);
    const { result, rerender } = renderHook(({ p }) => useCorridor(p), { initialProps: { p: PAR } });
    await waitFor(() => expect(result.current.data).toEqual(OK));
    rerender({ p: { ...PAR, workerId: 'w2' } });
    await waitFor(() => expect(AdminMapApiService.getCorridor).toHaveBeenCalledTimes(2));
  });

  it('trocar de par LIMPA o resultado anterior antes de responder — nunca mostra o corredor de outra pessoa', async () => {
    vi.mocked(AdminMapApiService.getCorridor)
      .mockResolvedValueOnce(OK)
      .mockImplementationOnce(() => new Promise(() => {}));
    const { result, rerender } = renderHook(({ p }) => useCorridor(p), { initialProps: { p: PAR } });
    await waitFor(() => expect(result.current.data).toEqual(OK));
    rerender({ p: { ...PAR, workerId: 'w2' } });
    expect(result.current.data).toBeNull();
    expect(result.current.isLoading).toBe(true);
  });

  it('erro vira estado, não exceção — e some ao voltar para um par que deu certo', async () => {
    vi.mocked(AdminMapApiService.getCorridor).mockRejectedValueOnce(new Error('HTTP 500'));
    const { result } = renderHook(() => useCorridor(PAR));
    await waitFor(() => expect(result.current.error).toBe('HTTP 500'));
    expect(result.current.data).toBeNull();
  });

  it('rejeição sem Error também vira mensagem legível', async () => {
    vi.mocked(AdminMapApiService.getCorridor).mockRejectedValueOnce('boom');
    const { result } = renderHook(() => useCorridor(PAR));
    await waitFor(() => expect(result.current.error).toBe('Failed to load corridor'));
  });

  it('REJEIÇÃO que chega depois de o par mudar também é ignorada — nada de erro de outra pessoa na tela', async () => {
    let rejeitaPrimeira: (e: unknown) => void = () => {};
    vi.mocked(AdminMapApiService.getCorridor)
      .mockImplementationOnce(() => new Promise((_r, rej) => { rejeitaPrimeira = rej; }))
      .mockResolvedValueOnce(OK);
    const { result, rerender } = renderHook(({ p }) => useCorridor(p), { initialProps: { p: PAR } });
    rerender({ p: { ...PAR, workerId: 'w2' } });
    await waitFor(() => expect(result.current.data).toEqual(OK));
    rejeitaPrimeira(new Error('tarde demais'));
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual(OK);
  });

  it('resposta que chega DEPOIS de o par mudar é ignorada', async () => {
    let resolvePrimeira: (v: CorridorResponse) => void = () => {};
    vi.mocked(AdminMapApiService.getCorridor)
      .mockImplementationOnce(() => new Promise((r) => { resolvePrimeira = r; }))
      .mockResolvedValueOnce({ ...OK, straightLineMeters: 99 });
    const { result, rerender } = renderHook(({ p }) => useCorridor(p), { initialProps: { p: PAR } });
    rerender({ p: { ...PAR, workerId: 'w2' } });
    await waitFor(() => expect(result.current.data?.straightLineMeters).toBe(99));
    resolvePrimeira(OK);
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.data?.straightLineMeters).toBe(99);
  });
});

describe('corridorPairFor', () => {
  const comCoord = { id: 'sel', lat: -34.6 };

  it('na aba de prestadores, quem VIAJA é o pino e o destino é a âncora (o paciente)', () => {
    expect(corridorPairFor('workers', 'AR', 'addr-1', comCoord))
      .toEqual({ country: 'AR', workerId: 'sel', patientAddressId: 'addr-1' });
  });

  it('na aba de pacientes o par se inverte — a âncora é o prestador', () => {
    expect(corridorPairFor('patients', 'AR', 'worker-1', comCoord))
      .toEqual({ country: 'AR', workerId: 'worker-1', patientAddressId: 'sel' });
  });

  it('sem âncora, sem seleção ou sem coordenada NÃO monta par (o hook não consulta)', () => {
    expect(corridorPairFor('workers', 'AR', null, comCoord)).toBeNull();
    expect(corridorPairFor('workers', 'AR', 'addr-1', null)).toBeNull();
    expect(corridorPairFor('workers', 'AR', 'addr-1', undefined)).toBeNull();
    expect(corridorPairFor('workers', 'AR', 'addr-1', { id: 'sel', lat: null })).toBeNull();
  });

  it('o país entra no par — é ele que o backend usa para recusar par cruzado', () => {
    expect(corridorPairFor('workers', 'BR', 'addr-1', comCoord)?.country).toBe('BR');
  });
});
