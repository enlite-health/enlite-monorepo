/**
 * CorridorPanel — a rota de transporte público dentro do balão do pino.
 *
 * Responde a pergunta que a recrutadora faz ao clicar: *dá para chegar, e em
 * quanto tempo?* — porta a porta, com a caminhada das duas pontas.
 *
 * A BALDEAÇÃO é destaque, não detalhe: em Buenos Aires não existe terminal, e
 * trocar de veículo obriga a andar até outra parada e **pagar de novo** (Marcel,
 * 02/09). Por isso as rotas vêm ordenadas por menos baldeação antes de menos
 * tempo, e "directo" é dito com todas as letras — é o que decide se o prestador
 * aceita o caso.
 *
 * As três saídas são MENSAGENS DIFERENTES de propósito: "não há trajeto" e "não
 * tenho as duas pontas" são coisas distintas, e colapsá-las faria o operador
 * tratar falta de dado como ausência de transporte.
 */
import { useState } from 'react';
import { Bus, TrainFront, Footprints, ChevronDown, AlertTriangle, MoveHorizontal } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import { useCorridor } from '@hooks/admin/useCorridor';
import type { CorridorRequest, RouteLeg, TransitRoute } from '@infrastructure/http/AdminMapApiService';

export interface CorridorLabels {
  loading: string;
  error: string;
  noRoute: string;
  noCoverage: string;
  direct: string;
  transfers: (n: number) => string;
  total: (min: number) => string;
  walkLeg: (min: number, meters: number) => string;
  straight: (blocks: number) => string;
}

const ModeIcon = ({ mode }: { mode?: string }): JSX.Element =>
  mode === 'train' || mode === 'subway' || mode === 'tram'
    ? <TrainFront size={13} className="text-gray-600 shrink-0" />
    : <Bus size={13} className="text-gray-600 shrink-0" />;

function Aviso({ text, testId }: { text: string; testId: string }): JSX.Element {
  return (
    <div className="flex items-start gap-1.5 mt-2" data-testid={testId}>
      <AlertTriangle size={13} className="text-amber-600 shrink-0 mt-0.5" />
      <Text as="span" size="xs" color="muted">{text}</Text>
    </div>
  );
}

function Leg({ leg, labels }: { leg: RouteLeg; labels: CorridorLabels }): JSX.Element {
  if (leg.kind === 'walk') {
    return (
      <li className="flex items-center gap-1.5" data-testid="route-leg" data-kind="walk">
        <Footprints size={13} className="text-gray-500 shrink-0" />
        <Text as="span" size="xs" color="muted">{labels.walkLeg(leg.minutes, leg.meters)}</Text>
      </li>
    );
  }
  return (
    <li className="flex items-center gap-1.5" data-testid="route-leg" data-kind="transit" data-line={leg.line}>
      <ModeIcon mode={leg.mode} />
      <Text as="span" size="xs" weight="medium" color="secondary">{leg.line}</Text>
      <Text as="span" size="xs" color="muted" className="truncate">{leg.from} → {leg.to} · {leg.minutes} min</Text>
    </li>
  );
}

function Rota({ route, labels, aberta, onToggle }: {
  route: TransitRoute; labels: CorridorLabels; aberta: boolean; onToggle: () => void;
}): JSX.Element {
  return (
    <li data-testid="route" data-transfers={route.transfers} data-minutes={route.totalMinutes}>
      <button type="button" onClick={onToggle} className="flex items-center gap-1.5 w-full text-left hover:underline" data-testid="route-summary">
        <ChevronDown size={12} className={`text-gray-500 shrink-0 transition-transform ${aberta ? 'rotate-180' : ''}`} />
        <Text as="span" size="xs" weight="semibold" color="secondary">{labels.total(route.totalMinutes)}</Text>
        <Text as="span" size="xs" color="muted">
          {route.transfers === 0 ? labels.direct : labels.transfers(route.transfers)} · {route.lines.join(' → ')}
        </Text>
      </button>
      {aberta && (
        <ul className="mt-1 ml-4 flex flex-col gap-0.5" data-testid="route-legs">
          {route.legs.map((l, i) => <Leg key={`${l.kind}-${i}`} leg={l} labels={labels} />)}
        </ul>
      )}
    </li>
  );
}

export function CorridorPanel({ pair, labels }: { pair: CorridorRequest; labels: CorridorLabels }): JSX.Element {
  const state = useCorridor(pair);
  // A primeira rota nasce ABERTA: é a resposta, não uma opção entre outras.
  const [aberta, setAberta] = useState(0);

  if (state.isLoading) {
    return (
      <div className="mt-2 pt-2 border-t border-gray-100" data-testid="corridor-loading">
        <Text as="div" size="xs" color="muted">{labels.loading}</Text>
      </div>
    );
  }
  if (state.error || !state.data) {
    return (
      <div className="mt-2 pt-2 border-t border-gray-100">
        <Aviso text={labels.error} testId="corridor-error" />
      </div>
    );
  }

  const { outcome, routes, straightLineMeters } = state.data;

  return (
    /* `data-clarity-mask` EXPLÍCITO, e não herdado do wrapper do mapa: o balão é
       portalado para dentro do DOM do Google, e a lista de superfícies a mascarar
       já falhou duas vezes por confiar em herança. Aqui há nome de parada e
       horário — "sai desta parada às 14:05" é um ponto conhecido com hora. */
    <div className="mt-2 pt-2 border-t border-gray-100" data-testid="corridor-panel" data-outcome={outcome} data-clarity-mask="True">
      {outcome === 'ok' && (
        <ul className="flex flex-col gap-1.5" data-testid="routes">
          {routes.map((r, i) => (
            <Rota key={`${r.totalMinutes}-${r.lines.join('-')}`} route={r} labels={labels}
              aberta={aberta === i} onToggle={() => setAberta(aberta === i ? -1 : i)} />
          ))}
        </ul>
      )}

      {outcome === 'sem_ruta' && <Aviso text={labels.noRoute} testId="corridor-no-route" />}
      {outcome === 'sem_cobertura' && <Aviso text={labels.noCoverage} testId="corridor-no-coverage" />}

      {straightLineMeters !== null && (
        <div className="flex items-center gap-1.5 mt-2" data-testid="corridor-straight">
          <MoveHorizontal size={13} className="text-gray-500 shrink-0" />
          <Text as="span" size="xs" color="muted">{labels.straight(Math.max(1, Math.round(straightLineMeters / 100)))}</Text>
        </div>
      )}
    </div>
  );
}
