import { useTranslation } from 'react-i18next';
import { PointsMap, type MapPoint, type MapRing } from '@presentation/components/molecules/PointsMap/PointsMap';
import { Text } from '@presentation/components/atoms/Text';
import type { buildBoardView, RingTone } from './inviteBoardModel';

type View = ReturnType<typeof buildBoardView>;

const RING_STYLE: Record<RingTone, Pick<MapRing, 'stroke' | 'strokeWeight' | 'fill' | 'fillOpacity'>> = {
  idle: { stroke: 'rgba(24,1,73,.35)', strokeWeight: 1.5, fill: '#180149', fillOpacity: 0.03 },
  current: { stroke: '#F227AF', strokeWeight: 2, fill: '#F227AF', fillOpacity: 0.06 },
  done: { stroke: '#0B5E45', strokeWeight: 2, fill: '#0B5E45', fillOpacity: 0.05 },
};

const CARD = 'rounded-xl bg-white shadow-[0_4px_8px_rgba(0,0,0,.08)]';

interface Props {
  view: View;
  center: { lat: number; lng: number };
  height: number;
  /** E8 (ninguém até 50 km): anéis sem rótulo, sem legenda e sem dica. */
  nobody?: boolean;
  hoveredId: string | null;
  selectedId: string | null;
  onHover: (id: string | null) => void;
  onSelect: (id: string | null) => void;
}

/** Ponto da legenda com o mesmo estilo do pino do mapa: borda branca + anel de 1 px (`dotIcon`). */
function Dot({ className, style }: { className?: string; style?: React.CSSProperties }): JSX.Element {
  return <span aria-hidden="true" className={`inline-block h-3 w-3 shrink-0 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(24,1,73,.35)] ${className ?? ''}`} style={style} />;
}

/** L.1–L.9 — mapa com centro fixo, anéis, pinos-ponto, legenda, dica e a nota do passo vacante. */
export function InviteMapPane({ view, center, height, nobody = false, hoveredId, selectedId, onHover, onSelect }: Props): JSX.Element {
  const { t } = useTranslation();
  const points: MapPoint[] = view.pins.map((p) => ({
    id: p.workerId,
    lat: p.lat,
    lng: p.lng,
    title: p.workerName,
    color: p.style.fill,
    // Inventário L.6: "{nome}, {d} km. Mostrar en la lista" (sem distância: "{nome}. Mostrar en la lista").
    tooltip: Number.isFinite(p.distanceKm)
      ? t('admin.vacancyInvite.map.pin', { name: p.workerName, distance: p.distanceKm.toFixed(1).replace('.', ',') })
      : t('admin.vacancyInvite.map.pinNoDistance', { name: p.workerName }),
    style: p.style,
  }));
  const rings: MapRing[] = view.rings.map((r) => ({
    radiusKm: r.radiusKm,
    ...RING_STYLE[r.tone],
    label: nobody ? '' : `${r.radiusKm} km`,
    labelTone: r.tone,
  }));
  const note = view.vacanteNote;
  // E8 (ninguém até 50 km): sem dica, sem legenda e sem rótulo de anel. No passo vacante a nota amarela ocupa o topo: sem dica.
  const showHint = !nobody && view.step !== 'vacante';

  return (
    <div className="relative" data-testid="invite-map-pane-map">
      <PointsMap
        points={points}
        center={center}
        radiusKm={null}
        rings={rings}
        fitRadiusKm={view.fitRadiusKm}
        markerShape="dot"
        centerIcon="house"
        centerLabel={t('admin.vacancyInvite.map.center')}
        hoveredId={hoveredId}
        onHover={onHover}
        selectedId={selectedId}
        onSelect={onSelect}
        placeholderText={t('admin.vacancyInvite.map.unavailable')}
        className="!rounded-none !border-0"
        height={height}
      />
      {note && (
        <div data-testid="invite-vacante-note" className="absolute left-4 top-4 max-w-[300px] rounded-xl bg-[#FFF4D6] px-3 py-2.5 text-[#5C3B00] shadow-[0_4px_8px_rgba(0,0,0,.08)]">
          <Text size="xs" color="inherit">
            {t('admin.vacancyInvite.map.vacanteNote.intro')}
            {note.farCount > 0 && ` ${t('admin.vacancyInvite.map.vacanteNote.far', { count: note.farCount })}`}
            {note.noLocationCount > 0 && ` ${t('admin.vacancyInvite.map.vacanteNote.noLocation', { count: note.noLocationCount })}`}
          </Text>
        </div>
      )}
      {showHint && (
        <div data-testid="invite-map-hint" className={`absolute right-4 top-4 px-3 py-2 ${CARD}`}>
          <Text size="xs" color="primary">{t('admin.vacancyInvite.map.hint')}</Text>
        </div>
      )}
      {!nobody && (
      <ul data-testid="invite-map-legend" className={`absolute bottom-8 left-4 max-w-[calc(100%-32px)] flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5 ${CARD}`}>
        <li className="flex items-center gap-1.5 whitespace-nowrap"><Dot className="bg-[#F227AF]" /><Text as="span" size="xs" color="primary">{t('admin.vacancyInvite.map.legend.selected')}</Text></li>
        <li className="flex items-center gap-1.5 whitespace-nowrap"><Dot className="bg-primary" /><Text as="span" size="xs" color="primary">{t('admin.vacancyInvite.map.legend.unselected')}</Text></li>
        <li className="flex items-center gap-1.5 whitespace-nowrap"><Dot className="!border-gray-800 bg-white" /><Text as="span" size="xs" color="primary">{t('admin.vacancyInvite.map.legend.invited')}</Text></li>
        <li className="flex items-center gap-1.5 whitespace-nowrap"><Dot className="!h-3.5 !w-3.5 bg-[#111827]" /><Text as="span" size="xs" color="primary">{t('admin.vacancyInvite.map.legend.service')}</Text></li>
      </ul>
      )}
    </div>
  );
}
