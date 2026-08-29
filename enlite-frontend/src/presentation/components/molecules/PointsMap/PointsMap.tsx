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
import { useEffect, useRef, useState } from 'react';
import { MapPin } from 'lucide-react';
import { loadGoogleMaps } from '@infrastructure/services/loadGoogleMaps';
import { Text } from '@presentation/components/atoms/Text';

export interface MapPoint {
  id: string;
  lat: number | null;
  lng: number | null;
  /** Texto do balão ao clicar (nome + status). Já traduzido pelo chamador. */
  title: string;
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
  /** Id do ponto a destacar (abre o balão). */
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  placeholderText: string;
  className?: string;
  height?: number;
}

export type MapStatus = 'loading' | 'ready' | 'unavailable';

function pinIcon(color: string): google.maps.Symbol {
  return {
    path: 'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z',
    fillColor: color,
    fillOpacity: 1,
    strokeColor: '#ffffff',
    strokeWeight: 1.5,
    scale: 1.4,
    anchor: new google.maps.Point(12, 22),
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);
}

export function PointsMap({
  points,
  center,
  radiusKm,
  onCenterChange,
  selectedId = null,
  onSelect,
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
  const onCenterChangeRef = useRef(onCenterChange);
  const onSelectRef = useRef(onSelect);
  onCenterChangeRef.current = onCenterChange;
  onSelectRef.current = onSelect;
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
        infoRef.current = new google.maps.InfoWindow();
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

  // 2. Centro + círculo do raio.
  useEffect(() => {
    const map = mapRef.current;
    if (status !== 'ready' || !map) return;
    map.panTo(center);
    if (!centerMarkerRef.current) {
      centerMarkerRef.current = new google.maps.Marker({
        map,
        position: center,
        zIndex: 1000,
        icon: { path: google.maps.SymbolPath.CIRCLE, scale: 7, fillColor: '#111827', fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 2 },
      });
    } else {
      centerMarkerRef.current.setPosition(center);
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
        existing.setTitle(p.title);
        continue;
      }
      const marker = new google.maps.Marker({ map, position, title: p.title, icon: pinIcon(p.color) });
      marker.addListener('click', () => onSelectRef.current?.(id));
      markersRef.current.set(id, marker);
    }
  }, [status, points]);

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
    const link = point.href ? `<br/><a href="${escapeHtml(point.href)}" style="color:#2563eb">→</a>` : '';
    info.setContent(`<div style="font: 13px system-ui; max-width: 240px">${escapeHtml(point.title)}${link}</div>`);
    info.open({ map, anchor: marker });
  }, [status, selectedId, points]);

  const markersCount = points.filter((p) => p.lat !== null && p.lng !== null).length;

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
