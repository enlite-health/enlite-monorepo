/**
 * PointsMap.test.tsx — o Google Maps é substituído por um fake mínimo em
 * `window.google` para afirmar O QUE o componente pede ao SDK: marcadores por
 * id (diff, não recriação), círculo do raio, clique → centro, balão do
 * selecionado, e o placeholder quando o script não carrega.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { PointsMap, type MapPoint } from './PointsMap';

const loadGoogleMaps = vi.fn();
vi.mock('@infrastructure/services/loadGoogleMaps', () => ({ loadGoogleMaps: () => loadGoogleMaps() }));

// ── Fake do SDK ───────────────────────────────────────────────────────────────
type Listener = (...args: unknown[]) => void;
class FakeEmitter {
  listeners: Record<string, Listener[]> = {};
  addListener(ev: string, cb: Listener): void { (this.listeners[ev] ??= []).push(cb); }
  emit(ev: string, ...args: unknown[]): void { (this.listeners[ev] ?? []).forEach((cb) => cb(...args)); }
}
class FakeMap extends FakeEmitter {
  opts: unknown;
  panTo = vi.fn();
  constructor(_el: HTMLElement, opts: unknown) { super(); this.opts = opts; }
}
class FakeMarker extends FakeEmitter {
  opts: Record<string, unknown>;
  setMap = vi.fn();
  setPosition = vi.fn();
  setIcon = vi.fn();
  setTitle = vi.fn();
  constructor(opts: Record<string, unknown>) { super(); this.opts = opts; markers.push(this); }
}
class FakeCircle {
  opts: Record<string, unknown>;
  setMap = vi.fn();
  setCenter = vi.fn();
  setRadius = vi.fn();
  constructor(opts: Record<string, unknown>) { this.opts = opts; circles.push(this); }
}
class FakeInfoWindow extends FakeEmitter {
  setContent = vi.fn();
  open = vi.fn();
  close = vi.fn();
  constructor() { super(); infos.push(this); }
}
let markers: FakeMarker[] = [];
let circles: FakeCircle[] = [];
let infos: FakeInfoWindow[] = [];
let maps: FakeMap[] = [];

function installFakeGoogle(): void {
  (globalThis as unknown as { google: unknown }).google = {
    maps: {
      Map: class extends FakeMap { constructor(el: HTMLElement, opts: unknown) { super(el, opts); maps.push(this); } },
      Marker: FakeMarker,
      Circle: FakeCircle,
      InfoWindow: FakeInfoWindow,
      Point: class { constructor(public x: number, public y: number) {} },
      SymbolPath: { CIRCLE: 0 },
    },
  };
}

const CABA = { lat: -34.6037, lng: -58.3816 };
const P = (id: string, over: Partial<MapPoint> = {}): MapPoint => ({ id, lat: -34.6, lng: -58.4, title: `T ${id}`, color: '#16a34a', href: `/x/${id}`, ...over });

function renderMap(props: Partial<React.ComponentProps<typeof PointsMap>> = {}) {
  const onCenterChange = vi.fn();
  const onSelect = vi.fn();
  const utils = render(
    <PointsMap points={[P('a'), P('b'), P('c', { lat: null, lng: null })]} center={CABA} radiusKm={5} onCenterChange={onCenterChange} onSelect={onSelect} placeholderText="sem mapa" {...props} />,
  );
  return { ...utils, onCenterChange, onSelect };
}

describe('PointsMap', () => {
  beforeEach(() => {
    markers = []; circles = []; infos = []; maps = [];
    installFakeGoogle();
    loadGoogleMaps.mockResolvedValue(undefined);
  });
  afterEach(() => { delete (globalThis as unknown as { google?: unknown }).google; });

  it('carrega o SDK, cria o mapa, os marcadores (só quem tem coordenada), o círculo e o centro; expõe estado no DOM', async () => {
    renderMap();
    const el = screen.getByTestId('points-map');
    expect(el).toHaveAttribute('data-map-status', 'loading');
    expect(el).toHaveAttribute('data-markers', '0');
    expect(screen.getByTestId('points-map-placeholder')).toHaveTextContent('…');
    await waitFor(() => expect(el).toHaveAttribute('data-map-status', 'ready'));
    expect(el).toHaveAttribute('data-markers', '2');
    expect(screen.queryByTestId('points-map-placeholder')).toBeNull();
    expect(maps).toHaveLength(1);
    expect((maps[0].opts as { clickableIcons: boolean }).clickableIcons).toBe(false);
    // 2 pinos + 1 marcador de centro
    const pins = markers.filter((m) => m.opts.title);
    expect(pins.map((m) => m.opts.title)).toEqual(['T a', 'T b']);
    expect((pins[0].opts.icon as { fillColor: string }).fillColor).toBe('#16a34a');
    expect(circles).toHaveLength(1);
    expect(circles[0].opts.radius).toBe(5000);
    expect(maps[0].panTo).toHaveBeenCalledWith(CABA);
    // tiles: pendente até o SDK avisar
    expect(el).toHaveAttribute('data-tiles', 'pending');
    act(() => maps[0].emit('tilesloaded'));
    expect(el).toHaveAttribute('data-tiles', 'loaded');
  });

  it('clique no mapa → onCenterChange com lat/lng; sem latLng não chama', async () => {
    const { onCenterChange } = renderMap();
    await waitFor(() => expect(maps).toHaveLength(1));
    act(() => maps[0].emit('click', { latLng: { lat: () => -34.7, lng: () => -58.5 } }));
    expect(onCenterChange).toHaveBeenCalledWith({ lat: -34.7, lng: -58.5 });
    act(() => maps[0].emit('click', { latLng: null }));
    expect(onCenterChange).toHaveBeenCalledTimes(1);
  });

  it('mudar centro/raio move o círculo e o marcador de centro em vez de recriar; raio null remove o círculo', async () => {
    const { rerender } = renderMap();
    await waitFor(() => expect(circles).toHaveLength(1));
    const centerMarker = markers.find((m) => !m.opts.title) as FakeMarker;
    const next = { lat: -34.7, lng: -58.5 };
    rerender(<PointsMap points={[P('a')]} center={next} radiusKm={10} onCenterChange={vi.fn()} placeholderText="x" />);
    await waitFor(() => expect(circles[0].setRadius).toHaveBeenCalledWith(10000));
    expect(circles[0].setCenter).toHaveBeenCalledWith(next);
    expect(centerMarker.setPosition).toHaveBeenCalledWith(next);
    expect(circles).toHaveLength(1);
    rerender(<PointsMap points={[P('a')]} center={next} radiusKm={null} onCenterChange={vi.fn()} placeholderText="x" />);
    await waitFor(() => expect(circles[0].setMap).toHaveBeenCalledWith(null));
    // voltar um raio cria um círculo novo (o anterior foi descartado)
    rerender(<PointsMap points={[P('a')]} center={next} radiusKm={5} onCenterChange={vi.fn()} placeholderText="x" />);
    await waitFor(() => expect(circles).toHaveLength(2));
  });

  it('diff de marcadores: mantém por id (atualiza posição/ícone/título), remove os que saíram, cria os novos', async () => {
    const { rerender } = renderMap();
    await waitFor(() => expect(markers.filter((m) => m.opts.title)).toHaveLength(2));
    const a = markers.find((m) => m.opts.title === 'T a') as FakeMarker;
    const b = markers.find((m) => m.opts.title === 'T b') as FakeMarker;
    rerender(<PointsMap points={[P('a', { lat: -34.61, title: 'T a2', color: '#d97706' }), P('d')]} center={CABA} radiusKm={5} onCenterChange={vi.fn()} placeholderText="x" />);
    await waitFor(() => expect(b.setMap).toHaveBeenCalledWith(null));
    expect(a.setPosition).toHaveBeenCalledWith({ lat: -34.61, lng: -58.4 });
    expect(a.setTitle).toHaveBeenCalledWith('T a2');
    expect((a.setIcon.mock.calls[0][0] as { fillColor: string }).fillColor).toBe('#d97706');
    expect(markers.filter((m) => m.opts.title === 'T d')).toHaveLength(1);
    expect(screen.getByTestId('points-map')).toHaveAttribute('data-markers', '2');
  });

  it('clique no pino → onSelect(id); selectedId abre o balão com título escapado e link; closeclick → onSelect(null); sem selecionado fecha', async () => {
    const { rerender, onSelect } = renderMap({ points: [P('a', { title: 'Ana <b>' }), P('b', { href: undefined })] });
    await waitFor(() => expect(markers.filter((m) => m.opts.title)).toHaveLength(2));
    const a = markers.find((m) => m.opts.title === 'Ana <b>') as FakeMarker;
    act(() => a.emit('click'));
    expect(onSelect).toHaveBeenCalledWith('a');
    rerender(<PointsMap points={[P('a', { title: 'Ana <b>' }), P('b', { href: undefined })]} center={CABA} radiusKm={5} onCenterChange={vi.fn()} onSelect={onSelect} selectedId="a" placeholderText="x" />);
    await waitFor(() => expect(infos[0].open).toHaveBeenCalled());
    const html = infos[0].setContent.mock.calls[0][0] as string;
    expect(html).toContain('Ana &lt;b&gt;');
    expect(html).toContain('href="/x/a"');
    rerender(<PointsMap points={[P('a', { title: 'Ana <b>' }), P('b', { href: undefined })]} center={CABA} radiusKm={5} onCenterChange={vi.fn()} onSelect={onSelect} selectedId="b" placeholderText="x" />);
    await waitFor(() => expect(infos[0].setContent).toHaveBeenCalledTimes(2));
    expect(infos[0].setContent.mock.calls[1][0]).not.toContain('href=');
    act(() => infos[0].emit('closeclick'));
    expect(onSelect).toHaveBeenCalledWith(null);
    const closesBefore = infos[0].close.mock.calls.length;
    rerender(<PointsMap points={[P('a')]} center={CABA} radiusKm={5} onCenterChange={vi.fn()} onSelect={onSelect} selectedId={null} placeholderText="x" />);
    await waitFor(() => expect(infos[0].close.mock.calls.length).toBe(closesBefore + 1));
    // selecionado que não está no mapa (sem coordenada / removido) fecha o balão
    rerender(<PointsMap points={[P('a')]} center={CABA} radiusKm={5} onCenterChange={vi.fn()} onSelect={onSelect} selectedId="zzz" placeholderText="x" />);
    await waitFor(() => expect(infos[0].close.mock.calls.length).toBe(closesBefore + 2));
  });

  it('sem onSelect: clique no pino e closeclick não quebram', async () => {
    render(<PointsMap points={[P('a')]} center={CABA} radiusKm={5} onCenterChange={vi.fn()} placeholderText="x" />);
    await waitFor(() => expect(markers.filter((m) => m.opts.title)).toHaveLength(1));
    act(() => (markers.find((m) => m.opts.title) as FakeMarker).emit('click'));
    act(() => infos[0].emit('closeclick'));
  });

  it('script não carrega → status unavailable + placeholder com o texto; nada de marcador', async () => {
    loadGoogleMaps.mockRejectedValue(new Error('no key'));
    renderMap();
    await waitFor(() => expect(screen.getByTestId('points-map')).toHaveAttribute('data-map-status', 'unavailable'));
    expect(screen.getByTestId('points-map-placeholder')).toHaveTextContent('sem mapa');
    expect(markers).toHaveLength(0);
    expect(screen.getByTestId('points-map')).toHaveAttribute('data-markers', '0');
  });

  it('desmontar antes do script carregar não cria mapa (cancelamento)', async () => {
    let resolveLoad: () => void = () => {};
    loadGoogleMaps.mockImplementation(() => new Promise<void>((r) => { resolveLoad = r; }));
    const { unmount } = renderMap();
    unmount();
    await act(async () => { resolveLoad(); await Promise.resolve(); });
    expect(maps).toHaveLength(0);
  });

  it('desmontar antes de falhar não muda estado', async () => {
    let rejectLoad: (e: unknown) => void = () => {};
    loadGoogleMaps.mockImplementation(() => new Promise<void>((_r, rej) => { rejectLoad = rej; }));
    const { unmount } = renderMap();
    unmount();
    await act(async () => { rejectLoad(new Error('late')); await Promise.resolve(); });
    expect(maps).toHaveLength(0);
  });
});
