/**
 * CorridorPanel — o corredor logístico dentro do balão do pino.
 *
 * Responde a pergunta que a recrutadora faz ao clicar: *dá para chegar?* — e
 * responde na unidade em que a operação já fala, que é QUADRA e LINHA, não
 * minuto (`acceso: "a três quadras, acessa por colectivo tal"`).
 *
 * ⚠️ O QUE ESTE PAINEL NÃO PROMETE: horário de partida, baldeação minuto a
 * minuto e tempo total. Não é modéstia de desenho — é o dado. O GTFS aberto de
 * Buenos Aires está suspenso e o que resta é de 2019/2020; prometer horário
 * sobre isso seria inventar. O que existe fresco (paradas de 28/10/2024, com as
 * linhas que passam em cada uma) responde o corredor, e só.
 *
 * As três saídas são MENSAGENS DIFERENTES de propósito: "não há linha direta"
 * (baldear, que em Buenos Aires se paga de novo) é uma resposta operacional, e
 * "não tenho dado aqui" é uma confissão. Colapsar as duas em "nada encontrado"
 * faria o operador tratar falta de dado como ausência de transporte.
 */
import { Bus, TrainFront, MoveHorizontal, AlertTriangle } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import { useCorridor } from '@hooks/admin/useCorridor';
import type { CorridorLine, CorridorRequest } from '@infrastructure/http/AdminMapApiService';

export interface CorridorLabels {
  title: (n: number) => string;
  loading: string;
  error: string;
  noDirect: string;
  noCoverage: string;
  walk: (blocks: number) => string;
  legs: (origin: number, destination: number) => string;
}

const ModeIcon = ({ mode }: { mode: string }): JSX.Element =>
  mode === 'train' || mode === 'subway'
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

/** Quantas linhas o balão mostra antes de resumir. */
const VISIBLE_LINES = 4;

/**
 * Busca o corredor no MONTE do painel — e o painel só monta quando o balão do
 * pino abre. Isso é o que garante que a cota de 60 chamadas/min só é gasta com
 * algo que alguém está de fato olhando.
 */
export function CorridorPanel({ pair, labels }: { pair: CorridorRequest; labels: CorridorLabels }): JSX.Element {
  const state = useCorridor(pair);
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

  const { outcome, lines, straightLineBlocks } = state.data;
  const shown: CorridorLine[] = lines.slice(0, VISIBLE_LINES);

  return (
    /* `data-clarity-mask` EXPLÍCITO, e não herdado do wrapper do mapa: o balão
       é portalado para dentro do DOM do Google, e a lista de superfícies a
       mascarar já falhou duas vezes por confiar em herança. Aqui há nome de
       parada + quadras a pé — e "X quadras até uma parada conhecida" é um
       círculo em torno de um ponto conhecido, ou seja, geocódigo disfarçado. */
    <div className="mt-2 pt-2 border-t border-gray-100" data-testid="corridor-panel" data-outcome={outcome} data-clarity-mask="True">
      {outcome === 'ok' && (
        <>
          <Text as="div" size="xs" weight="semibold" color="secondary">{labels.title(lines.length)}</Text>
          <ul className="mt-1 flex flex-col gap-0.5" data-testid="corridor-lines">
            {shown.map((l) => (
              <li key={`${l.mode}-${l.line}`} className="flex items-center gap-1.5" data-testid="corridor-line" data-line={l.line}>
                <ModeIcon mode={l.mode} />
                <Text as="span" size="xs" weight="medium" color="secondary">{l.line}</Text>
                <Text as="span" size="xs" color="muted">{labels.legs(l.originBlocks, l.destinationBlocks)}</Text>
              </li>
            ))}
          </ul>
        </>
      )}

      {outcome === 'sem_conexion_directa' && <Aviso text={labels.noDirect} testId="corridor-no-direct" />}
      {outcome === 'sem_cobertura' && <Aviso text={labels.noCoverage} testId="corridor-no-coverage" />}

      {straightLineBlocks !== null && (
        <div className="flex items-center gap-1.5 mt-2" data-testid="corridor-walk">
          <MoveHorizontal size={13} className="text-gray-500 shrink-0" />
          <Text as="span" size="xs" color="muted">{labels.walk(straightLineBlocks)}</Text>
        </div>
      )}
    </div>
  );
}
