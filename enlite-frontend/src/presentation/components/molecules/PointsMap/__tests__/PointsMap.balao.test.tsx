/**
 * Com um pino selecionado, cada convite da fila gera um `points` novo. O balão só reabre (e o mapa só
 * recentraliza) quando o selecionado muda ou a posição DELE muda — senão o mapa "pula" a cada envio.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PointsMap, type MapPoint } from '../PointsMap';

const loadGoogleMaps = vi.fn();
vi.mock('@infrastructure/services/loadGoogleMaps', () => ({ loadGoogleMaps: () => loadGoogleMaps() }));

class Emitter { addListener = vi.fn(); }
const spies = { panTo: vi.fn(), open: vi.fn(), markers: 0 };
class FakeMarker extends Emitter {
  setMap = vi.fn(); setPosition = vi.fn(); setIcon = vi.fn(); setTitle = vi.fn(); setZIndex = vi.fn();
  getPosition = vi.fn(() => this.opts.position);
  constructor(public opts: Record<string, unknown>) { super(); spies.markers += 1; }
}

beforeEach(() => {
  spies.panTo = vi.fn(); spies.open = vi.fn(); spies.markers = 0;
  loadGoogleMaps.mockResolvedValue(undefined);
  (globalThis as unknown as { google: unknown }).google = {
    maps: {
      Map: class extends Emitter { panTo = spies.panTo; fitBounds = vi.fn(); },
      Marker: FakeMarker,
      Circle: class { setMap = vi.fn(); setCenter = vi.fn(); setRadius = vi.fn(); },
      InfoWindow: class extends Emitter { setContent = vi.fn(); open = spies.open; close = vi.fn(); },
      Point: class { constructor(public x: number, public y: number) {} },
      SymbolPath: { CIRCLE: 0 },
    },
  };
});
afterEach(cleanup);

const pts = (lat = -34.6): MapPoint[] => [
  { id: 'a', lat, lng: -58.4, title: 'A', color: '#111' },
  { id: 'b', lat: -34.7, lng: -58.4, title: 'B', color: '#111' },
];
const CENTER = { lat: -34.6, lng: -58.4 }; // identidade estável, como na página
const ui = (points: MapPoint[], selectedId: string | null) => (
  <MemoryRouter>
    <PointsMap points={points} center={CENTER} radiusKm={null} selectedId={selectedId} placeholderText="x" />
  </MemoryRouter>
);

describe('PointsMap — balão do selecionado', () => {
  it('re-render com `points` novo e o MESMO selecionado: não reabre nem recentraliza', async () => {
    const { rerender } = render(ui(pts(), 'a'));
    await waitFor(() => expect(spies.open).toHaveBeenCalledTimes(1));
    const panBefore = spies.panTo.mock.calls.length; // inclui o panTo do centro, que não é do balão
    rerender(ui(pts(), 'a'));
    rerender(ui(pts(), 'a'));
    expect(spies.open).toHaveBeenCalledTimes(1);
    expect(spies.panTo).toHaveBeenCalledTimes(panBefore);
  });

  it('trocar o selecionado reabre; mover o selecionado de lugar reabre', async () => {
    const { rerender } = render(ui(pts(), 'a'));
    await waitFor(() => expect(spies.open).toHaveBeenCalledTimes(1));
    rerender(ui(pts(), 'b'));
    expect(spies.open).toHaveBeenCalledTimes(2);
    rerender(ui(pts(-34.65), 'b'));
    expect(spies.open).toHaveBeenCalledTimes(2); // moveu o "a", não o selecionado "b"
    rerender(ui([{ ...pts()[0] }, { ...pts()[1], lat: -34.8 }], 'b'));
    expect(spies.open).toHaveBeenCalledTimes(3);
  });
});
