/**
 * PointsMap — props aditivas da 089 (§9.4): anéis, enquadramento por raio,
 * pino em ponto, centro em casa, clique opcional e contrato DOM (data-*).
 * Google Maps dublado em `window.google` (unit; o e2e real vem depois).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PointsMap, type MapPoint, type MapRing } from '../PointsMap';

const loadGoogleMaps = vi.fn();
vi.mock('@infrastructure/services/loadGoogleMaps', () => ({ loadGoogleMaps: () => loadGoogleMaps() }));

type Listener = (...a: unknown[]) => void;
class Emitter {
  listeners: Record<string, Listener[]> = {};
  addListener(ev: string, cb: Listener): void { (this.listeners[ev] ??= []).push(cb); }
  emit(ev: string, ...a: unknown[]): void { (this.listeners[ev] ?? []).forEach((cb) => cb(...a)); }
}
class FMap extends Emitter {
  panTo = vi.fn();
  fitBounds = vi.fn();
  constructor(_el: HTMLElement, _o: unknown) { super(); maps.push(this); }
}
class FMarker extends Emitter {
  setMap = vi.fn(); setPosition = vi.fn(); setIcon = vi.fn(); setTitle = vi.fn(); setZIndex = vi.fn();
  getPosition = vi.fn(() => this.opts.position);
  constructor(public opts: Record<string, unknown>) { super(); markers.push(this); }
}
class FCircle {
  setMap = vi.fn(); setCenter = vi.fn(); setRadius = vi.fn();
  constructor(public opts: Record<string, unknown>) { circles.push(this); }
}
class FInfo extends Emitter { setContent = vi.fn(); open = vi.fn(); close = vi.fn(); }
class FOverlay {
  panes = { overlayLayer: document.createElement('div') };
  getPanes() { return this.panes; }
  getProjection() { return { fromLatLngToDivPixel: () => ({ x: 10, y: 20 }) }; }
  setMap(m: unknown) { if (m) { overlays.push(this); (this as unknown as { onAdd(): void }).onAdd(); (this as unknown as { draw(): void }).draw(); } }
}
let maps: FMap[] = []; let markers: FMarker[] = []; let circles: FCircle[] = []; let overlays: FOverlay[] = [];

const CENTER = { lat: -34.6, lng: -58.4 };
const P = (id: string, over: Partial<MapPoint> = {}): MapPoint => ({ id, lat: -34.61, lng: -58.41, title: `T ${id}`, color: '#16a34a', ...over });
const RINGS: MapRing[] = [
  { radiusKm: 5, stroke: '#F227AF', strokeWeight: 2, fill: '#F227AF', fillOpacity: 0.05, label: '5 km', labelTone: 'current' },
  { radiusKm: 10, stroke: '#737373', strokeWeight: 1, fill: '#737373', fillOpacity: 0.02, label: '10 km', labelTone: 'idle' },
];

function mount(props: Partial<React.ComponentProps<typeof PointsMap>> = {}) {
  return render(
    <MemoryRouter>
      <PointsMap points={[P('a')]} center={CENTER} radiusKm={null} placeholderText="x" {...props} />
    </MemoryRouter>,
  );
}

describe('PointsMap — props aditivas 089', () => {
  beforeEach(() => {
    maps = []; markers = []; circles = []; overlays = [];
    (globalThis as unknown as { google: unknown }).google = {
      maps: {
        Map: FMap, Marker: FMarker, Circle: FCircle, InfoWindow: FInfo, OverlayView: FOverlay,
        LatLng: class { constructor(public p: unknown) {} },
        Point: class { constructor(public x: number, public y: number) {} },
        SymbolPath: { CIRCLE: 0 },
      },
    };
    loadGoogleMaps.mockResolvedValue(undefined);
  });
  afterEach(() => { cleanup(); delete (globalThis as unknown as { google?: unknown }).google; });

  it('rings=[5,10] → 2 Circle estilizados (sem o azul legado), rótulos no DOM e data-rings', async () => {
    const { getByTestId } = mount({ rings: RINGS, radiusKm: 7 });
    await waitFor(() => expect(circles).toHaveLength(2));
    expect(circles.map((c) => c.opts.radius)).toEqual([5000, 10000]);
    expect(circles[0].opts.strokeColor).toBe('#F227AF');
    expect(circles.some((c) => c.opts.fillColor === '#2563eb')).toBe(false);
    expect(overlays.map((o) => o.panes.overlayLayer.textContent)).toEqual(['5 km', '10 km']);
    expect(getByTestId('points-map')).toHaveAttribute('data-rings', '5,10');
  });

  it('fitRadiusKm=10 → fitBounds com os bounds do círculo de 10 km, padding 24; sem a prop não enquadra', async () => {
    const { getByTestId, unmount } = mount({ fitRadiusKm: 10 });
    await waitFor(() => expect(maps[0]?.fitBounds).toHaveBeenCalledTimes(1));
    const [b, pad] = maps[0].fitBounds.mock.calls[0] as [{ north: number; south: number; east: number; west: number }, number];
    expect(pad).toBe(24);
    expect(b.north - CENTER.lat).toBeCloseTo(10 / 111.32, 5);
    expect(CENTER.lat - b.south).toBeCloseTo(10 / 111.32, 5);
    expect(b.east).toBeGreaterThan(CENTER.lng);
    expect(b.west).toBeLessThan(CENTER.lng);
    expect(getByTestId('points-map')).toHaveAttribute('data-fit-radius-km', '10');
    unmount();
    mount();
    await waitFor(() => expect(maps).toHaveLength(2));
    expect(maps[1].fitBounds).not.toHaveBeenCalled();
  });

  it('sem onCenterChange: 0 listeners de clique; com ele, o clique chama como hoje', async () => {
    mount();
    await waitFor(() => expect(maps).toHaveLength(1));
    expect(maps[0].listeners.click).toBeUndefined();
    cleanup();
    const onCenterChange = vi.fn();
    mount({ onCenterChange });
    await waitFor(() => expect(maps).toHaveLength(2));
    act(() => maps[1].emit('click', { latLng: { lat: () => -34.7, lng: () => -58.5 } }));
    expect(onCenterChange).toHaveBeenCalledWith({ lat: -34.7, lng: -58.5 });
  });

  it('data-center e data-selected-id presentes (mesmo sem tiles); legado sem rings não cria data-rings', async () => {
    const { getByTestId } = mount({ selectedId: 'a' });
    const el = getByTestId('points-map');
    expect(el).toHaveAttribute('data-center', '-34.6,-58.4');
    expect(el).toHaveAttribute('data-selected-id', 'a');
    expect(el).not.toHaveAttribute('data-rings');
    expect(el).toHaveAttribute('data-markers');
  });

  it('markerShape=dot: SymbolPath.CIRCLE, optimized:false, escala pelo style; enfatizado com outline engrossa a borda', async () => {
    const style = { fill: '#F227AF', stroke: '#ffffff', strokeWeight: 2, sizePx: 18, outline: true };
    const { rerender } = mount({ markerShape: 'dot', points: [P('a', { style })] });
    await waitFor(() => expect(markers.filter((m) => m.opts.title)).toHaveLength(1));
    const pin = markers.find((m) => m.opts.title) as FMarker;
    expect(pin.opts.optimized).toBe(false);
    expect(pin.opts.icon).toMatchObject({ path: 0, scale: 9, fillColor: '#F227AF', strokeWeight: 2 });
    rerender(
      <MemoryRouter>
        <PointsMap points={[P('a', { style })]} center={CENTER} radiusKm={null} placeholderText="x" markerShape="dot" hoveredId="a" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(pin.setIcon).toHaveBeenLastCalledWith(expect.objectContaining({ strokeWeight: 3.5 })));
  });

  it('centerIcon=house: overlay 34 px no lugar do marcador-ponto; padrão continua marcador', async () => {
    mount({ centerIcon: 'house' });
    await waitFor(() => expect(overlays).toHaveLength(1));
    expect(markers.filter((m) => !m.opts.title)).toHaveLength(0);
    expect(overlays[0].panes.overlayLayer.querySelector('[data-testid="points-map-center-house"]')).not.toBeNull();
    cleanup();
    mount();
    await waitFor(() => expect(markers.some((m) => !m.opts.title)).toBe(true));
  });

  it('centerLabel → aria-label/title no centro (casa e ponto); ausente ⇒ sem título', async () => {
    mount({ centerIcon: 'house', centerLabel: 'Lugar del servicio' });
    await waitFor(() => expect(overlays).toHaveLength(1));
    const house = overlays[0].panes.overlayLayer.querySelector('[data-testid="points-map-center-house"]') as HTMLElement;
    expect(house).toHaveAttribute('aria-label', 'Lugar del servicio');
    expect(house.title).toBe('Lugar del servicio');
    cleanup();
    markers = [];
    mount({ centerLabel: 'Lugar del servicio', points: [] });
    await waitFor(() => expect(markers).toHaveLength(1));
    expect(markers[0].opts.title).toBe('Lugar del servicio');
    cleanup();
    markers = [];
    mount({ points: [] });
    await waitFor(() => expect(markers).toHaveLength(1));
    expect(markers[0].opts.title).toBeUndefined();
  });
});
