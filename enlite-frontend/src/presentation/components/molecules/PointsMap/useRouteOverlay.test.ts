/**
 * useRouteOverlay — o ciclo de vida do traçado sobre o mapa.
 *
 * É a condição C5 do parecer do `lex` (06/09): a linha tem de sumir ao fechar o
 * balão, ao trocar de par e ao trocar de opção no acordeão. Overlay do Google é
 * imperativo — ninguém o remove por desmontar componente —, então "esqueci de
 * apagar" não aparece como erro: aparece como mapa que vai acumulando rota até
 * a recrutadora recarregar a página, com o traçado de pares que ela já fechou
 * ainda desenhado na tela.
 */
import { renderHook } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useRouteOverlay, type RouteOverlayLeg } from './useRouteOverlay';

interface FakeLine { opts: Record<string, unknown>; setMap: ReturnType<typeof vi.fn> }
let criadas: FakeLine[] = [];
const decodePath = vi.fn((s: string) => [{ lat: 1, lng: 2, encoded: s }]);

/** Quantas linhas ainda estão no mapa (a última chamada de `setMap` não foi `null`). */
const vivas = (): FakeLine[] =>
  criadas.filter((l) => {
    const calls = l.setMap.mock.calls;
    return calls.length === 0 || calls[calls.length - 1][0] !== null;
  });

const fitBounds = vi.fn();
const mapaFalso = { fitBounds } as unknown as google.maps.Map;
const walk = (...paths: string[]): RouteOverlayLeg => ({ kind: 'walk', paths });
const transit = (...paths: string[]): RouteOverlayLeg => ({ kind: 'transit', paths, color: '#1b6633' });
const semCor = (...paths: string[]): RouteOverlayLeg => ({ kind: 'transit', paths, color: '' });

/**
 * Perna de transporte vira DUAS linhas: contorno branco embaixo, cor oficial em
 * cima — é o que o Maps faz, e é o contorno que sustenta a leitura cruzando
 * avenida ou parque. Caminhada vira uma só (a fileira de pontos).
 */
const POR_TRANSPORTE = 2;

beforeEach(() => {
  criadas = [];
  decodePath.mockClear();
  fitBounds.mockClear();
  (globalThis as unknown as { google: unknown }).google = {
    maps: {
      geometry: { encoding: { decodePath } },
      SymbolPath: { CIRCLE: 'circle' },
      Polyline: class {
        constructor(opts: Record<string, unknown>) {
          const self = {
            opts,
            setMap: vi.fn(),
            getPath: () => ({ forEach: (f: (p: unknown) => void) => (opts.path as unknown[]).forEach(f) }),
          };
          criadas.push(self as unknown as FakeLine);
          return self as unknown as google.maps.Polyline;
        }
      },
      LatLngBounds: class {
        pontos: unknown[] = [];
        extend(p: unknown): void { this.pontos.push(p); }
        isEmpty(): boolean { return this.pontos.length === 0; }
      },
    },
  };
});

describe('useRouteOverlay', () => {
  it('desenha um trecho por polilinha — caminhada fundida tem mais de um', () => {
    // O backend entrega `paths` como lista justamente porque polilinha
    // codificada é delta-encoded e não se concatena como texto.
    renderHook(() => useRouteOverlay(mapaFalso, [walk('aa', 'bb'), transit('cc')]));

    expect(vivas()).toHaveLength(2 + POR_TRANSPORTE);
    // decodifica UMA vez por polilinha, mesmo desenhando duas linhas com ela
    expect(decodePath).toHaveBeenCalledTimes(3);
    expect(decodePath.mock.calls.map((c) => c[0])).toEqual(['aa', 'bb', 'cc']);
  });

  it('caminhada é uma fileira de PONTOS, não um tracejado', () => {
    renderHook(() => useRouteOverlay(mapaFalso, [walk('aa')]));

    const [aPe] = criadas;
    // A linha é invisível e o que se vê são círculos repetidos sobre ela. A
    // diferença para um tracejado importa: ponto lê como "trecho a percorrer",
    // traço lê como "veículo".
    expect(aPe.opts.strokeOpacity).toBe(0);
    const icones = aPe.opts.icons as Array<{ icon: { path: string; fillColor: string } }>;
    expect(icones[0].icon.path).toBe('circle');
    expect(icones[0].icon.fillColor).toBe('#5f6368');
    expect(aPe.opts.clickable).toBe(false);
  });

  it('transporte usa a COR OFICIAL da linha, sobre um contorno branco mais largo', () => {
    renderHook(() => useRouteOverlay(mapaFalso, [transit('cc')]));

    const [contorno, traco] = criadas;
    expect(contorno.opts.strokeColor).toBe('#ffffff');
    expect(traco.opts.strokeColor).toBe('#1b6633'); // o 50 de CABA, como o Google devolve
    // o contorno é mais LARGO e fica EMBAIXO — invertido, ele apagaria a linha
    expect(contorno.opts.strokeWeight as number).toBeGreaterThan(traco.opts.strokeWeight as number);
    expect(contorno.opts.zIndex as number).toBeLessThan(traco.opts.zIndex as number);
    expect(traco.opts.icons).toBeUndefined();
    expect(traco.opts.clickable).toBe(false);
  });

  it('sem cor do Google, cai na cor do tema — nunca fica sem cor', () => {
    renderHook(() => useRouteOverlay(mapaFalso, [semCor('cc')]));
    expect(criadas[1].opts.strokeColor).toBe('#180149');
  });

  it('🔒 C5: trocar de opção SUBSTITUI o traçado — não empilha', () => {
    const { rerender } = renderHook(({ legs }) => useRouteOverlay(mapaFalso, legs), {
      initialProps: { legs: [transit('primeira')] as RouteOverlayLeg[] | null },
    });
    expect(vivas()).toHaveLength(POR_TRANSPORTE);

    rerender({ legs: [transit('segunda')] });

    // Quatro vivas seria empilhamento; o que importa é quantas SOBRAM.
    expect(vivas()).toHaveLength(POR_TRANSPORTE);
    expect(vivas()[0].opts.path).toEqual([{ lat: 1, lng: 2, encoded: 'segunda' }]);
  });

  it('🔒 C5: `null` apaga tudo — é o que acontece ao fechar o balão', () => {
    const { rerender } = renderHook(({ legs }) => useRouteOverlay(mapaFalso, legs), {
      initialProps: { legs: [walk('aa'), transit('cc')] as RouteOverlayLeg[] | null },
    });
    expect(vivas()).toHaveLength(1 + POR_TRANSPORTE);

    rerender({ legs: null });
    expect(vivas()).toHaveLength(0);
  });

  it('🔒 C5: desmontar apaga — o overlay não morre junto com o componente', () => {
    const { unmount } = renderHook(() => useRouteOverlay(mapaFalso, [transit('cc')]));
    expect(vivas()).toHaveLength(POR_TRANSPORTE);

    unmount();
    expect(vivas()).toHaveLength(0);
  });

  it('ENQUADRA o mapa na rota, com folga grande no topo para o balão', () => {
    // Sem enquadrar, o desenho existe e não se vê: o mapa nasce em zoom 11
    // (~55 km) e um trajeto de 1,2 km vira 25 pixels — medido em 06/09.
    renderHook(() => useRouteOverlay(mapaFalso, [walk('aa'), transit('cc')]));

    expect(fitBounds).toHaveBeenCalledTimes(1);
    const folga = fitBounds.mock.calls[0][1] as Record<string, number>;
    // O topo tem de ser MUITO maior que os lados: é ali que o balão mora, e o
    // Google decide a posição dele antes de as rotas chegarem.
    expect(folga.top).toBeGreaterThan(folga.bottom * 3);
  });

  it('não enquadra quando não há o que desenhar — o mapa fica onde a operadora deixou', () => {
    renderHook(() => useRouteOverlay(mapaFalso, null));
    expect(fitBounds).not.toHaveBeenCalled();
  });

  it('sem mapa ainda, ou com rota vazia, não desenha nada e não quebra', () => {
    renderHook(() => useRouteOverlay(null, [transit('cc')]));
    expect(criadas).toHaveLength(0);

    renderHook(() => useRouteOverlay(mapaFalso, []));
    expect(criadas).toHaveLength(0);
  });

  it('sem a biblioteca `geometry`, degrada em silêncio em vez de derrubar o mapa', () => {
    // O script do Google carrega UMA vez por página: se outra tela subiu a dela
    // sem `geometry`, o decodificador não existe. O painel de texto continua
    // respondendo a pergunta — quebrar a tela inteira pelo enfeite seria pior.
    (globalThis as unknown as { google: { maps: { geometry?: unknown } } }).google.maps.geometry = undefined;

    expect(() => renderHook(() => useRouteOverlay(mapaFalso, [transit('cc')]))).not.toThrow();
    expect(criadas).toHaveLength(0);
  });
});
