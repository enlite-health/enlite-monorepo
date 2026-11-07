import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Crosshair, X } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import type { MapPoint } from './PointsMap';

/**
 * Cartão do balão. Vive DENTRO do InfoWindow do Google, por portal, e não como
 * string de HTML: assim o nome entra como texto (nunca como markup — não há o
 * que escapar), a tipografia é a dos atoms, e o link é o `Link` do router. Com
 * `<a href>` cru, clicar no balão recarregava o SPA inteiro e o mapa voltava
 * ao ponto de partida — o oposto do que o balão existe para fazer.
 */
export function InfoCard({ point, linkLabel, closeLabel, onClose, centerHereLabel, onCenterHere, extra }: { point: MapPoint; linkLabel?: string; closeLabel: string; onClose: () => void; centerHereLabel?: string; onCenterHere?: () => void; extra?: ReactNode }): JSX.Element {
  return (
    <div className="points-map-info relative font-lexend min-w-[210px] max-w-[330px] p-3" data-testid="points-map-info-card">
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
