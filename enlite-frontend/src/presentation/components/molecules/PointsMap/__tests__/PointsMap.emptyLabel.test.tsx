/**
 * PointsMap — anel com `label` vazio (estado "ninguém até 50 km" da página
 * Invitar prestadores) não cria overlay de rótulo; o Circle continua criado.
 * Google Maps dublado em `window.google` (mesmo dublê de PointsMap.rings.test).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PointsMap, type MapPoint, type MapRing } from '../PointsMap';

const loadGoogleMaps = vi.fn();
vi.mock('@infrastructure/services/loadGoogleMaps', () => ({ loadGoogleMaps: () => loadGoogleMaps() }));

type Listener = (...a: unknown[]) => void;
class Emitter {
  listeners: Record<string, Listener[]> = {};
  addListener(ev: string, cb: Listener): void { (this.listeners[ev] ??= []).push(cb); }
}
class FMap extends Emitter {
  panTo = vi.fn(); fitBounds = vi.fn();
  constructor(_el: HTMLElement, _o: unknown) { super(); maps.push(this); }
}
class FMarker extends Emitter {
  setMap = vi.fn(); setPosition = vi.fn(); setIcon = vi.fn(); setTitle = vi.fn(); setZIndex = vi.fn();
  getPosition = vi.fn(() => this.opts.position);
  constructor(public opts: Record<string, unknown>) { super(); }
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
let maps: FMap[] = []; let circles: FCircle[] = []; let overlays: FOverlay[] = [];

const CENTER = { lat: -34.6, lng: -58.4 };
const POINT: MapPoint = { id: 'a', lat: -34.61, lng: -58.41, title: 'T a', color: '#16a34a' };
const ring = (radiusKm: number, label: string): MapRing => ({
  radiusKm, stroke: '#737373', strokeWeight: 1, fill: '#737373', fillOpacity: 0.02, label, labelTone: 'idle',
});

function mount(rings: MapRing[]) {
  return render(
    <MemoryRouter>
      <PointsMap points={[POINT]} center={CENTER} radiusKm={null} placeholderText="x" rings={rings} />
    </MemoryRouter>,
  );
}

describe('PointsMap — anel sem rótulo (089)', () => {
  beforeEach(() => {
    maps = []; circles = []; overlays = [];
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

  it("label '' → o Circle é criado, mas nenhum overlay/elemento de rótulo existe para o anel", async () => {
    mount([ring(50, '')]);
    await waitFor(() => expect(circles).toHaveLength(1));
    expect(circles[0].opts.radius).toBe(50000);
    expect(overlays).toHaveLength(0);
  });

  it("label 'X km' → overlay de rótulo criado com o texto", async () => {
    mount([ring(50, '50 km')]);
    await waitFor(() => expect(circles).toHaveLength(1));
    expect(overlays.map((o) => o.panes.overlayLayer.textContent)).toEqual(['50 km']);
  });

  it("mistura: só o anel com label gera overlay; o vazio mantém o Circle", async () => {
    mount([ring(10, '10 km'), ring(50, '')]);
    await waitFor(() => expect(circles).toHaveLength(2));
    expect(circles.map((c) => c.opts.radius)).toEqual([10000, 50000]);
    expect(overlays.map((o) => o.panes.overlayLayer.textContent)).toEqual(['10 km']);
  });
});
