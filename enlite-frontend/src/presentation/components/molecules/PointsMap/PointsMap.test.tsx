/**
 * PointsMap.test.tsx — o Google Maps é substituído por um fake mínimo em
 * `window.google` para afirmar O QUE o componente pede ao SDK: marcadores por
 * id (diff, não recriação), círculo do raio, clique → centro, balão do
 * selecionado, e o placeholder quando o script não carrega.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PointsMap, type MapPoint } from './PointsMap';

const last = <T,>(arr: T[]): T | undefined => arr[arr.length - 1];

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
  setZIndex = vi.fn();
  /** O componente usa a posição do marcador para levar a viewport até ele. */
  getPosition = vi.fn(() => this.opts.position);
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
  opts: Record<string, unknown>;
  setContent = vi.fn();
  open = vi.fn();
  close = vi.fn();
  constructor(opts: Record<string, unknown> = {}) { super(); this.opts = opts; infos.push(this); }
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

  it('clique no pino → onSelect(id); selectedId abre o balão no nó do React; closeclick → onSelect(null); sem selecionado fecha', async () => {
    const pts = [P('a', { title: 'Ana <b>' }), P('b', { href: undefined })];
    const { rerender, onSelect } = renderMap({ points: pts });
    await waitFor(() => expect(markers.filter((m) => m.opts.title)).toHaveLength(2));
    const a = markers.find((m) => m.opts.title === 'Ana <b>') as FakeMarker;
    act(() => a.emit('click'));
    expect(onSelect).toHaveBeenCalledWith('a');
    rerender(<PointsMap points={pts} center={CABA} radiusKm={5} onCenterChange={vi.fn()} onSelect={onSelect} selectedId="a" placeholderText="x" />);
    await waitFor(() => expect(infos[0].open).toHaveBeenCalled());

    // O conteúdo é um NÓ, não string de HTML: o nome entra como texto e não há
    // markup para escapar — `<b>` continua sendo `<b>` escrito, não negrito.
    const node = infos[0].setContent.mock.calls[0][0] as HTMLElement;
    expect(node).toBeInstanceOf(HTMLElement);
    await waitFor(() => expect(node.textContent).toContain('Ana <b>'));
    expect(node.querySelector('b')).toBeNull();

    act(() => infos[0].emit('closeclick'));
    expect(onSelect).toHaveBeenCalledWith(null);
    const closesBefore = infos[0].close.mock.calls.length;
    rerender(<PointsMap points={[P('a')]} center={CABA} radiusKm={5} onCenterChange={vi.fn()} onSelect={onSelect} selectedId={null} placeholderText="x" />);
    await waitFor(() => expect(infos[0].close.mock.calls.length).toBe(closesBefore + 1));
    // selecionado que não está no mapa (sem coordenada / removido) fecha o balão
    rerender(<PointsMap points={[P('a')]} center={CABA} radiusKm={5} onCenterChange={vi.fn()} onSelect={onSelect} selectedId="zzz" placeholderText="x" />);
    await waitFor(() => expect(infos[0].close.mock.calls.length).toBe(closesBefore + 2));
  });

  it('o balão mostra nome, detalhe, distância e um link do ROUTER (não recarrega o SPA)', async () => {
    const pt = P('a', { title: 'Lucía Fernández', details: 'AT · Documentación completa · Monserrat', distance: '0.4 km', href: '/admin/workers/a' });
    render(
      <MemoryRouter>
        <PointsMap points={[pt]} center={CABA} radiusKm={5} onCenterChange={vi.fn()} selectedId="a" linkLabel="Ver perfil" placeholderText="x" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(infos[0].open).toHaveBeenCalled());
    const node = infos[0].setContent.mock.calls[0][0] as HTMLElement;
    await waitFor(() => expect(node.querySelector('[data-testid="points-map-info-card"]')).not.toBeNull());
    expect(node.textContent).toContain('Lucía Fernández');
    expect(node.textContent).toContain('AT · Documentación completa · Monserrat');
    expect(node.textContent).toContain('0.4 km');
    const link = node.querySelector('a') as HTMLAnchorElement;
    expect(link.textContent).toContain('Ver perfil');
    expect(link.getAttribute('href')).toBe('/admin/workers/a');
    // o tooltip nativo do pino continua sendo a linha única
    expect(markers.find((m) => m.opts.title)?.opts.title).toBe('Lucía Fernández');
  });

  it('o header do Google fica desligado e quem fecha é o botão do cartão', async () => {
    const onSelect = vi.fn();
    render(
      <MemoryRouter>
        <PointsMap points={[P('a', { title: 'Ana' })]} center={CABA} radiusKm={5} onCenterChange={vi.fn()} onSelect={onSelect} selectedId="a" linkLabel="Ver perfil" closeLabel="Cerrar" placeholderText="x" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(infos[0].open).toHaveBeenCalled());
    // a faixa branca de cima era o header do Google
    expect(infos[0].opts.headerDisabled).toBe(true);
    // ...e o foco não é roubado para dentro do balão
    expect((infos[0].open.mock.calls[0][0] as { shouldFocus: boolean }).shouldFocus).toBe(false);

    const node = infos[0].setContent.mock.calls[0][0] as HTMLElement;
    await waitFor(() => expect(node.querySelector('[data-testid="points-map-info-close"]')).not.toBeNull());
    const close = node.querySelector('[data-testid="points-map-info-close"]') as HTMLButtonElement;
    expect(close.getAttribute('aria-label')).toBe('Cerrar');
    act(() => close.click());
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('sem linkLabel o balão não oferece link, e sem distância não inventa uma', async () => {
    render(
      <MemoryRouter>
        <PointsMap points={[P('a', { title: 'Sin link', details: 'AT', distance: null })]} center={CABA} radiusKm={5} onCenterChange={vi.fn()} selectedId="a" placeholderText="x" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(infos[0].open).toHaveBeenCalled());
    const node = infos[0].setContent.mock.calls[0][0] as HTMLElement;
    await waitFor(() => expect(node.textContent).toContain('Sin link'));
    expect(node.querySelector('a')).toBeNull();
    expect(node.textContent).toContain('AT');
  });

  it('o path do pino leva os parâmetros do arco em grupos de 7 — a forma compacta o Google recusa', async () => {
    renderMap();
    await waitFor(() => expect(markers.filter((m) => m.opts.title)).toHaveLength(2));
    const path = (markers.find((m) => m.opts.title)?.opts.icon as { path: string }).path;
    // `a` (arco) consome 7 parâmetros por repetição. Na forma compacta as flags
    // grudam no x (`0 110-5`) e o parser do Google lê 5 números onde precisa de
    // 7 — daí "Expected number at position 109, found z" e ZERO pinos na tela.
    // A prova de que desenha é o navegador (sonda de 31/08); isto aqui só
    // impede a volta da forma que não desenha.
    const arcs = path.split(/(?=a)/).filter((s) => s.startsWith('a'));
    expect(arcs.length).toBeGreaterThan(0);
    for (const arc of arcs) {
      const nums = arc.slice(1).match(/-?\d*\.?\d+/g) ?? [];
      expect(nums.length % 7).toBe(0);
    }
  });

  it('escolher um ponto leva a viewport até ele — sem isso o balão abre fora da tela', async () => {
    const { rerender, onSelect } = renderMap();
    await waitFor(() => expect(markers.filter((m) => m.opts.title)).toHaveLength(2));
    maps[0].panTo.mockClear();
    rerender(<PointsMap points={[P('a'), P('b'), P('c', { lat: null, lng: null })]} center={CABA} radiusKm={5} onCenterChange={vi.fn()} onSelect={onSelect} selectedId="a" placeholderText="x" />);
    await waitFor(() => expect(maps[0].panTo).toHaveBeenCalledWith({ lat: -34.6, lng: -58.4 }));
  });

  it('destaque nos dois sentidos: hoveredId engorda o pino e o solta; mouseover/mouseout no pino chamam onHover', async () => {
    const onHover = vi.fn();
    const base = [P('a'), P('b')];
    const { rerender } = render(<PointsMap points={base} center={CABA} radiusKm={5} onCenterChange={vi.fn()} onHover={onHover} placeholderText="x" />);
    await waitFor(() => expect(markers.filter((m) => m.opts.title)).toHaveLength(2));
    const a = markers.find((m) => m.opts.title === 'T a') as FakeMarker;

    rerender(<PointsMap points={base} center={CABA} radiusKm={5} onCenterChange={vi.fn()} onHover={onHover} hoveredId="a" placeholderText="x" />);
    await waitFor(() => expect(a.setIcon).toHaveBeenCalled());
    expect((last(a.setIcon.mock.calls)?.[0] as { scale: number }).scale).toBe(2);
    expect(a.setZIndex).toHaveBeenLastCalledWith(900);

    rerender(<PointsMap points={base} center={CABA} radiusKm={5} onCenterChange={vi.fn()} onHover={onHover} hoveredId={null} placeholderText="x" />);
    await waitFor(() => expect((last(a.setIcon.mock.calls)?.[0] as { scale: number }).scale).toBe(1.4));
    expect(a.setZIndex).toHaveBeenLastCalledWith(null);

    act(() => a.emit('mouseover'));
    expect(onHover).toHaveBeenCalledWith('a');
    act(() => a.emit('mouseout'));
    expect(onHover).toHaveBeenCalledWith(null);
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

  it('o balão oferece "centrar aqui" — o clique que queria ser no mapa acerta uma pessoa', async () => {
    const onCenterHere = vi.fn();
    const pt = P('a', { title: 'Ana', details: 'AT', distance: '1 km', href: '/x/a' });
    render(
      <MemoryRouter>
        <PointsMap points={[pt]} center={CABA} radiusKm={5} onCenterChange={vi.fn()} selectedId="a" linkLabel="Ver perfil" centerHereLabel="Centrar aquí" onCenterHere={onCenterHere} placeholderText="x" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(infos[0].open).toHaveBeenCalled());
    const node = infos[0].setContent.mock.calls[0][0] as HTMLElement;
    await waitFor(() => expect(node.querySelector('[data-testid="points-map-info-center-here"]')).not.toBeNull());
    const botao = node.querySelector('[data-testid="points-map-info-center-here"]') as HTMLButtonElement;
    expect(botao.textContent).toContain('Centrar aquí');
    act(() => botao.click());
    expect(onCenterHere).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
  });

  it('o ponto do centro PULSA quando o centro muda, e volta ao tamanho normal', async () => {
    const { rerender } = renderMap();
    await waitFor(() => expect(markers.length).toBeGreaterThan(0));
    const centro = markers.find((m) => !m.opts.title) as FakeMarker;
    expect((centro.opts.icon as { scale: number }).scale).toBe(7);

    rerender(<PointsMap points={[P('a')]} center={{ lat: -34.7, lng: -58.5 }} radiusKm={5} onCenterChange={vi.fn()} placeholderText="x" />);
    // pulso imediato: sem isto, a única coisa que se mexe na tela é um ponto de 7px
    await waitFor(() => expect((last(centro.setIcon.mock.calls)?.[0] as { scale: number }).scale).toBe(13));
    // e volta sozinho
    await waitFor(() => expect((last(centro.setIcon.mock.calls)?.[0] as { scale: number }).scale).toBe(7), { timeout: 2000 });
  });

  it('desmontar no meio do pulso não deixa timer solto', async () => {
    const { rerender, unmount } = renderMap();
    await waitFor(() => expect(markers.length).toBeGreaterThan(0));
    rerender(<PointsMap points={[P('a')]} center={{ lat: -34.7, lng: -58.5 }} radiusKm={5} onCenterChange={vi.fn()} placeholderText="x" />);
    unmount();
  });

  it('`renderExtra` injeta conteúdo do CHAMADOR no rodapé do balão — o mapa não sabe o que é', async () => {
    // O `PointsMap` desenha pontos; quem sabe o que é um corredor de transporte
    // é a página, que tem o par (âncora × pino). Este slot é a fronteira disso.
    const renderExtra = vi.fn((p: { id: string }) => <div data-testid="extra-do-chamador">extra de {p.id}</div>);
    render(
      <MemoryRouter>
        <PointsMap points={[P('a')]} center={CABA} radiusKm={5} onCenterChange={vi.fn()} selectedId="a" renderExtra={renderExtra} placeholderText="x" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(infos[0].open).toHaveBeenCalled());
    // o balão é PORTALADO para um nó solto que vai ao InfoWindow do Google —
    // ele não está no document.body, então `screen` não o enxerga.
    const node = infos[0].setContent.mock.calls[0][0] as HTMLElement;
    await waitFor(() => expect(node.querySelector('[data-testid="extra-do-chamador"]')).not.toBeNull());
    expect(node.textContent).toContain('extra de a');
    expect(renderExtra).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
  });
});
