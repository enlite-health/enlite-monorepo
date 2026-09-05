/**
 * PointsMap — um Google Map com N marcadores, um círculo de raio e o clique
 * que define o centro. É o mapa dos dois lados do painel (prestadores e
 * pacientes, REQ-04 · DEC-14).
 *
 * Sem lib nova: `google.maps.Map` + `Marker` via `loadGoogleMaps` (o mesmo
 * caminho do `ServiceAreaMap`). Só coordenada ARMAZENADA vai para o Google,
 * renderizada client-side (lex 29/08, C7): este componente não chama
 * `Geocoder` nem `places.Autocomplete`, e o centro é um clique no mapa ou um
 * ponto interno — nunca um endereço digitado.
 *
 * Quando o script não carrega (sem chave, offline), o placeholder assume e a
 * lista ao lado continua funcionando: o mapa é visualização, não fonte.
 *
 * Estado exposto ao DOM (`data-map-status`, `data-markers`) para o E2E
 * afirmar sem depender de tiles — o canvas do Google não é determinístico.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { ArrowRight, Crosshair, MapPin, X } from 'lucide-react';
import { loadGoogleMaps } from '@infrastructure/services/loadGoogleMaps';
import { Text } from '@presentation/components/atoms/Text';

export interface MapPoint {
  id: string;
  lat: number | null;
  lng: number | null;
  /** NOME da pessoa — título do balão e tooltip nativo do pino. */
  title: string;
  /** Linha secundária do balão (profissão, status, bairro). Já traduzida. */
  details?: string;
  /** Distância já formatada ("1.9 km"), quando a busca tem centro. */
  distance?: string | null;
  /** Tooltip nativo do pino (uma linha). Sem ele, o nome. */
  tooltip?: string;
  /** Cor do pino (hex). */
  color: string;
  /** Rota interna aberta a partir do balão (ex.: /admin/workers/:id). */
  href?: string;
}

export interface PointsMapProps {
  points: MapPoint[];
  center: { lat: number; lng: number };
  radiusKm: number | null;
  onCenterChange: (c: { lat: number; lng: number }) => void;
  /** Id do ponto a destacar (abre o balão e leva a viewport até ele). */
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  /** Id do ponto sob o cursor na LISTA — engorda o pino correspondente. */
  hoveredId?: string | null;
  /** Cursor entrando/saindo de um PINO — para a lista acender a linha. */
  onHover?: (id: string | null) => void;
  /** Rótulo do link do balão ("Ver perfil"). Sem ele o balão não mostra link. */
  linkLabel?: string;
  /** Rótulo acessível do botão de fechar do balão. */
  closeLabel?: string;
  /** Rótulo do "centrar aqui" do balão. Sem ele e sem `onCenterHere`, não aparece. */
  centerHereLabel?: string;
  /** Conteúdo extra no rodapé do balão, montado pelo chamador para o ponto aberto. */
  renderExtra?: (point: MapPoint) => ReactNode;
  /** Mover o centro do raio para o ponto do balão — com o mapa cheio de pinos,
   *  o clique que queria ser "aqui" acerta uma pessoa; isto devolve a intenção. */
  onCenterHere?: (point: MapPoint) => void;
  placeholderText: string;
  className?: string;
  height?: number;
}

export type MapStatus = 'loading' | 'ready' | 'unavailable';

const CENTER_SCALE = 7;
const CENTER_SCALE_PULSE = 13;
const PULSE_MS = 320;

/**
 * ⚠️ As flags do arco vão SEPARADAS (`0 1 1 0-5`), nunca na forma compacta
 * (`0 110-5`) dos ícones minificados: o SVG aceita as duas, o parser de
 * `google.maps.Symbol` só aceita a primeira. Com a compacta ele lança
 * "Expected number at position 109, found z" a cada redesenho e NENHUM pino
 * é desenhado — o mapa fica só com o centro e o círculo, e `data-markers`
 * continua marcando verde (ele conta o que a página quis, não o que o Google
 * pintou). Medido em 31/08 com controle positivo: compacta = 1 erro/0 pinos,
 * separada = 0 erros/desenha.
 */
const PIN_PATH =
  'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z';

/** Ponto do centro do raio. `scale` maior = pulso de confirmação do clique. */
function centerIcon(scale: number): google.maps.Symbol {
  return { path: google.maps.SymbolPath.CIRCLE, scale, fillColor: '#111827', fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 2 };
}

function pinIcon(color: string, emphasized = false): google.maps.Symbol {
  return {
    path: PIN_PATH,
    fillColor: color,
    fillOpacity: 1,
    strokeColor: emphasized ? '#111827' : '#ffffff',
    strokeWeight: emphasized ? 2.5 : 1.5,
    scale: emphasized ? 2 : 1.4,
    anchor: new google.maps.Point(12, 22),
  };
}

/**
 * Cartão do balão. Vive DENTRO do InfoWindow do Google, por portal, e não como
 * string de HTML: assim o nome entra como texto (nunca como markup — não há o
 * que escapar), a tipografia é a dos atoms, e o link é o `Link` do router. Com
 * `<a href>` cru, clicar no balão recarregava o SPA inteiro e o mapa voltava
 * ao ponto de partida — o oposto do que o balão existe para fazer.
 */
function InfoCard({ point, linkLabel, closeLabel, onClose, centerHereLabel, onCenterHere, extra }: { point: MapPoint; linkLabel?: string; closeLabel: string; onClose: () => void; centerHereLabel?: string; onCenterHere?: () => void; extra?: ReactNode }): JSX.Element {
  return (
    <div className="points-map-info relative font-lexend min-w-[210px] max-w-[280px] p-3" data-testid="points-map-info-card">
      <button
        type="button"
        onClick={onClose}
        aria-label={closeLabel}
        data-testid="points-map-info-close"
        className="absolute top-2 right-2 p-1 rounded text-gray-500 hover:text-gray-900 hover:bg-gray-100"
      >
        <X size={14} />
      </button>
      <div className="flex items-baseline justify-between gap-3 pr-6">
        <Text as="span" size="sm" weight="semibold" color="secondary">{point.title}</Text>
        {point.distance && <Text as="span" size="xs" color="muted" className="shrink-0">{point.distance}</Text>}
      </div>
      {point.details && (
        <Text as="div" size="xs" color="muted" className="mt-1 pr-6">{point.details}</Text>
      )}
      <div className="flex items-center gap-3 mt-2">
        {point.href && linkLabel && (
          <Link to={point.href} className="inline-flex items-center gap-1 text-primary hover:underline">
            <Text as="span" size="xs" weight="medium" color="inherit">{linkLabel}</Text>
            <ArrowRight size={12} />
          </Link>
        )}
        {onCenterHere && centerHereLabel && (
          <button type="button" onClick={onCenterHere} data-testid="points-map-info-center-here" className="inline-flex items-center gap-1 text-gray-600 hover:text-gray-900 hover:underline">
            <Crosshair size={12} />
            <Text as="span" size="xs" weight="medium" color="inherit">{centerHereLabel}</Text>
          </button>
        )}
      </div>
      {/* Slot do chamador. O `PointsMap` desenha pontos; ele não sabe o que é um
          corredor de transporte, e não deve saber — quem monta o conteúdo é a
          página, que tem o contexto do par (âncora × pino). */}
      {extra}
    </div>
  );
}

export function PointsMap({
  points,
  center,
  radiusKm,
  onCenterChange,
  selectedId = null,
  onSelect,
  hoveredId = null,
  onHover,
  linkLabel,
  closeLabel = 'Cerrar',
  centerHereLabel,
  onCenterHere,
  renderExtra,
  placeholderText,
  className = '',
  height = 560,
}: PointsMapProps): JSX.Element {
  const divRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<Map<string, google.maps.Marker>>(new Map());
  const circleRef = useRef<google.maps.Circle | null>(null);
  const centerMarkerRef = useRef<google.maps.Marker | null>(null);
  const infoRef = useRef<google.maps.InfoWindow | null>(null);
  /** Nó estável para o React desenhar dentro do balão do Google. */
  const infoNodeRef = useRef<HTMLDivElement>(document.createElement('div'));
  const emphasizedRef = useRef<Set<string>>(new Set());
  const pulseRef = useRef<number | null>(null);
  const onCenterChangeRef = useRef(onCenterChange);
  const onSelectRef = useRef(onSelect);
  const onHoverRef = useRef(onHover);
  const onCenterHereRef = useRef(onCenterHere);
  onCenterChangeRef.current = onCenterChange;
  onSelectRef.current = onSelect;
  onHoverRef.current = onHover;
  onCenterHereRef.current = onCenterHere;
  const [status, setStatus] = useState<MapStatus>('loading');
  // `ready` é o SDK; os tiles chegam depois — e é o que um print precisa esperar.
  const [tilesLoaded, setTilesLoaded] = useState(false);

  // 1. Carrega o script e cria o mapa uma vez.
  useEffect(() => {
    let cancelled = false;
    loadGoogleMaps()
      .then(() => {
        if (cancelled || !divRef.current) return;
        const map = new google.maps.Map(divRef.current, {
          center,
          zoom: 11,
          disableDefaultUI: true,
          zoomControl: true,
          clickableIcons: false,
          styles: [
            { featureType: 'poi', stylers: [{ visibility: 'off' }] },
            { featureType: 'transit', stylers: [{ visibility: 'off' }] },
          ],
        });
        map.addListener('click', (e: google.maps.MapMouseEvent) => {
          const ll = e.latLng;
          if (ll) onCenterChangeRef.current({ lat: ll.lat(), lng: ll.lng() });
        });
        map.addListener('tilesloaded', () => setTilesLoaded(true));
        // `headerDisabled`: a faixa de header do Google (com o X dele) some — era
        // ela a área branca acima do conteúdo. O fechar passa a ser do cartão.
        infoRef.current = new google.maps.InfoWindow({ headerDisabled: true } as google.maps.InfoWindowOptions);
        infoRef.current.addListener('closeclick', () => onSelectRef.current?.(null));
        mapRef.current = map;
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('unavailable');
      });
    return () => {
      cancelled = true;
    };
    // Só na montagem: o centro inicial vem por prop, os seguintes por effect próprio.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => { if (pulseRef.current !== null) window.clearTimeout(pulseRef.current); }, []);

  // 2. Centro + círculo do raio.
  useEffect(() => {
    const map = mapRef.current;
    if (status !== 'ready' || !map) return;
    map.panTo(center);
    if (!centerMarkerRef.current) {
      centerMarkerRef.current = new google.maps.Marker({ map, position: center, zIndex: 1000, icon: centerIcon(CENTER_SCALE) });
    } else {
      centerMarkerRef.current.setPosition(center);
      // Pulso de confirmação. Medido em 01/09: o clique é registrado em 7ms e a
      // viewport muda aos 14ms — não há lentidão. O que faltava era a tela DIZER
      // que entendeu: a única coisa que se movia era um ponto de 7px, enquanto a
      // lista ao lado continuava idêntica até a resposta chegar.
      centerMarkerRef.current.setIcon(centerIcon(CENTER_SCALE_PULSE));
      if (pulseRef.current !== null) window.clearTimeout(pulseRef.current);
      pulseRef.current = window.setTimeout(() => centerMarkerRef.current?.setIcon(centerIcon(CENTER_SCALE)), PULSE_MS);
    }
    if (radiusKm === null) {
      circleRef.current?.setMap(null);
      circleRef.current = null;
      return;
    }
    if (!circleRef.current) {
      circleRef.current = new google.maps.Circle({
        map,
        center,
        radius: radiusKm * 1000,
        fillColor: '#2563eb',
        fillOpacity: 0.08,
        strokeColor: '#2563eb',
        strokeOpacity: 0.6,
        strokeWeight: 1.5,
        clickable: false,
      });
    } else {
      circleRef.current.setCenter(center);
      circleRef.current.setRadius(radiusKm * 1000);
    }
  }, [status, center, radiusKm]);

  // 3. Marcadores: diff por id (o Google cobra por tile, não por marker — mas
  //    recriar 1.500 pinos a cada filtro trava a UI).
  useEffect(() => {
    const map = mapRef.current;
    if (status !== 'ready' || !map) return;
    const wanted = new Map(points.filter((p) => p.lat !== null && p.lng !== null).map((p) => [p.id, p]));
    for (const [id, marker] of markersRef.current) {
      if (!wanted.has(id)) {
        marker.setMap(null);
        markersRef.current.delete(id);
      }
    }
    for (const [id, p] of wanted) {
      const position = { lat: p.lat as number, lng: p.lng as number };
      const existing = markersRef.current.get(id);
      if (existing) {
        existing.setPosition(position);
        existing.setIcon(pinIcon(p.color));
        existing.setTitle(p.tooltip ?? p.title);
        continue;
      }
      const marker = new google.maps.Marker({ map, position, title: p.tooltip ?? p.title, icon: pinIcon(p.color) });
      marker.addListener('click', () => onSelectRef.current?.(id));
      marker.addListener('mouseover', () => onHoverRef.current?.(id));
      marker.addListener('mouseout', () => onHoverRef.current?.(null));
      markersRef.current.set(id, marker);
    }
  }, [status, points]);

  // 3b. Destaque (lista ↔ mapa): só os ids que ENTRARAM ou SAÍRAM do destaque
  //     são repintados — varrer 5.000 pinos a cada hover travaria a UI.
  useEffect(() => {
    if (status !== 'ready') return;
    const next = new Set([hoveredId, selectedId].filter((v): v is string => !!v));
    for (const id of new Set([...emphasizedRef.current, ...next])) {
      const marker = markersRef.current.get(id);
      const p = points.find((x) => x.id === id);
      if (!marker || !p) continue;
      const on = next.has(id);
      marker.setIcon(pinIcon(p.color, on));
      marker.setZIndex(on ? 900 : null);
    }
    emphasizedRef.current = next;
  }, [status, hoveredId, selectedId, points]);

  // 4. Balão do ponto selecionado.
  useEffect(() => {
    const map = mapRef.current;
    const info = infoRef.current;
    if (status !== 'ready' || !map || !info) return;
    if (!selectedId) {
      info.close();
      return;
    }
    const marker = markersRef.current.get(selectedId);
    const point = points.find((p) => p.id === selectedId);
    if (!marker || !point) {
      info.close();
      return;
    }
    // A viewport VAI até o ponto. Sem isto, escolher alguém na lista abre o
    // balão onde o mapa já estava — e quem está fora do enquadramento abre
    // balão fora da tela: a tela inteira parece "sempre o mesmo lugar".
    const position = marker.getPosition();
    if (position) map.panTo(position);
    info.setContent(infoNodeRef.current);
    // `shouldFocus: false`: o balão abre como EFEITO de um clique na lista, e
    // roubar o foco para dentro dele tira o teclado de onde a pessoa estava —
    // além de pintar o anel de foco no link já na abertura.
    info.open({ map, anchor: marker, shouldFocus: false });
  }, [status, selectedId, points]);

  const markersCount = points.filter((p) => p.lat !== null && p.lng !== null).length;
  const selectedPoint = useMemo(
    () => points.find((p) => p.id === selectedId && p.lat !== null) ?? null,
    [points, selectedId],
  );

  return (
    <div className={`relative w-full rounded-[10px] overflow-hidden border border-gray-200 ${className}`} style={{ height }}>
      <div
        ref={divRef}
        className="w-full h-full"
        data-testid="points-map"
        data-map-status={status}
        data-markers={status === 'ready' ? markersCount : 0}
        data-tiles={tilesLoaded ? 'loaded' : 'pending'}
      />
      {selectedPoint && createPortal(
        <InfoCard
          point={selectedPoint}
          linkLabel={linkLabel}
          closeLabel={closeLabel}
          onClose={() => onSelectRef.current?.(null)}
          centerHereLabel={centerHereLabel}
          onCenterHere={onCenterHere ? () => onCenterHereRef.current?.(selectedPoint) : undefined}
          extra={renderExtra?.(selectedPoint)}
        />,
        infoNodeRef.current,
      )}
      {status !== 'ready' && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-gray-100"
          data-testid="points-map-placeholder"
        >
          <MapPin size={32} className="text-gray-700" />
          <Text size="sm" color="secondary" className="text-center px-4">
            {status === 'loading' ? '…' : placeholderText}
          </Text>
        </div>
      )}
    </div>
  );
}
