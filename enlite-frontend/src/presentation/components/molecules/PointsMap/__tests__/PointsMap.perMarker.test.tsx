/**
 * Convite em lote travava a aba: cada envio da fila refazia `points` e o efeito de marcadores chamava
 * `setIcon`/`setTitle`/`setPosition` nos ~220 marcadores (`optimized:false`). Aqui o contrato: só o
 * marcador que MUDOU é tocado.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PointsMap, type MapPoint } from '../PointsMap';

const loadGoogleMaps = vi.fn();
vi.mock('@infrastructure/services/loadGoogleMaps', () => ({ loadGoogleMaps: () => loadGoogleMaps() }));

class Emitter { addListener = vi.fn(); }
class FakeMarker extends Emitter {
  setMap = vi.fn(); setPosition = vi.fn(); setIcon = vi.fn(); setTitle = vi.fn(); setZIndex = vi.fn();
  getPosition = vi.fn();
  constructor(public opts: Record<string, unknown>) { super(); all.push(this); }
}
let all: FakeMarker[] = [];
/** Os marcadores de pessoa (o do centro tem zIndex 1000). */
const people = () => all.filter((m) => m.opts.zIndex !== 1000);
const N = 220;

beforeEach(() => {
  all = [];
  loadGoogleMaps.mockResolvedValue(undefined);
  (globalThis as unknown as { google: unknown }).google = {
    maps: {
      Map: class extends Emitter { panTo = vi.fn(); fitBounds = vi.fn(); },
      Marker: FakeMarker,
      Circle: class { setMap = vi.fn(); setCenter = vi.fn(); setRadius = vi.fn(); },
      InfoWindow: class extends Emitter { setContent = vi.fn(); open = vi.fn(); close = vi.fn(); },
      Point: class { constructor(public x: number, public y: number) {} },
      SymbolPath: { CIRCLE: 0 },
      ControlPosition: { RIGHT_CENTER: 0 },
    },
  };
});
afterEach(cleanup);

const style = { fill: '#180149', stroke: '#fff', strokeWeight: 2, sizePx: 12 };
const make = (over: Record<number, Partial<MapPoint>> = {}): MapPoint[] =>
  Array.from({ length: N }, (_, i) => ({
    id: `w${i}`, lat: -34.6 + i / 1000, lng: -58.4, title: `W ${i}`, tooltip: `W ${i}, 1 km`, color: '#180149', style, ...over[i],
  }));
const totals = () => ({
  icon: people().reduce((n, m) => n + m.setIcon.mock.calls.length, 0),
  title: people().reduce((n, m) => n + m.setTitle.mock.calls.length, 0),
  pos: people().reduce((n, m) => n + m.setPosition.mock.calls.length, 0),
});
const ui = (points: MapPoint[]) => (
  <MemoryRouter>
    <PointsMap points={points} center={{ lat: -34.6, lng: -58.4 }} radiusKm={null} markerShape="dot" placeholderText="x" />
  </MemoryRouter>
);

describe('PointsMap — só o marcador que mudou é repintado', () => {
  it(`${N} pontos: re-render com os MESMOS valores (array novo) não chama setIcon/setTitle/setPosition`, async () => {
    const { rerender } = render(ui(make()));
    await waitFor(() => expect(people()).toHaveLength(N));
    rerender(ui(make()));
    expect(totals()).toEqual({ icon: 0, title: 0, pos: 0 });
  });

  it(`${N} pontos: 1 ponto muda de estilo → setIcon em no máximo 1 marcador`, async () => {
    const { rerender } = render(ui(make()));
    await waitFor(() => expect(people()).toHaveLength(N));
    rerender(ui(make({ 7: { style: { ...style, fill: '#F227AF' } } })));
    expect(totals().icon).toBeLessThanOrEqual(1);
    expect(people()[7].setIcon).toHaveBeenCalledTimes(1);
    expect(totals().title + totals().pos).toBe(0);
  });
});
