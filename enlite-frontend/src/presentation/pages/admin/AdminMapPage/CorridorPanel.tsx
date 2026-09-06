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
 *
 * ⚠️ CADA ROTA É UMA OPÇÃO FECHADA, e o desenho tem de gritar isso. Na primeira
 * versão as pernas da rota aberta e os cabeçalhos das seguintes empilhavam sem
 * separação, e o conjunto lia como UM trajeto de cinco passos em vez de TRÊS
 * alternativas (apontado pelo Gabriel, 05/09). O que conserta: contagem
 * explícita no topo, moldura com divisória entre as opções, fundo na que está
 * aberta, e as pernas indentadas atrás de uma barra vertical — a barra é o que
 * diz "isto pertence à linha de cima".
 */
import { useEffect, useState } from 'react';
import { Bus, TrainFront, Footprints, ChevronDown, AlertTriangle, MoveHorizontal } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import { useCorridor } from '@hooks/admin/useCorridor';
import type { CorridorRequest, RouteLeg, TransitRoute } from '@infrastructure/http/AdminMapApiService';

export interface CorridorLabels {
  /** "3 opciones" — a contagem explícita no topo. */
  options: (n: number) => string;
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
    ? <TrainFront size={13} className="text-primary shrink-0" />
    : <Bus size={13} className="text-primary shrink-0" />;

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
        <Footprints size={13} className="text-primary shrink-0" />
        <Text as="span" size="xs" color="muted">{labels.walkLeg(leg.minutes, leg.meters)}</Text>
      </li>
    );
  }
  /* Duas linhas de propósito. Numa só, o nome da parada de desembarque era
     cortado ("→ Avenid…") — e saber que se pega o 50 sem saber ONDE DESCER não
     responde a pergunta. As paradas ganham a linha inteira e QUEBRAM em vez de
     truncar; nome de parada portenha é longo por natureza. */
  return (
    <li data-testid="route-leg" data-kind="transit" data-line={leg.line}>
      <div className="flex items-center gap-1.5">
        <ModeIcon mode={leg.mode} />
        <Text as="span" size="xs" weight="semibold" color="primary">{leg.line}</Text>
        <Text as="span" size="xs" color="muted">{leg.minutes} min</Text>
      </div>
      <Text as="div" size="xs" color="muted" className="pl-[19px] !leading-[1.35]" data-testid="route-leg-stops">
        {leg.from} → {leg.to}
      </Text>
    </li>
  );
}

function Rota({ route, labels, aberta, onToggle, numero }: {
  route: TransitRoute; labels: CorridorLabels; aberta: boolean; onToggle: () => void; numero: number;
}): JSX.Element {
  return (
    <li
      data-testid="route"
      data-transfers={route.transfers}
      data-minutes={route.totalMinutes}
      data-open={aberta}
      className={aberta ? 'bg-blue-50/60' : ''}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={aberta}
        className="flex items-baseline gap-1.5 w-full text-left px-2 py-1.5 hover:bg-gray-50"
        data-testid="route-summary"
      >
        <ChevronDown size={12} className={`text-primary shrink-0 self-center transition-transform ${aberta ? 'rotate-180' : ''}`} />
        {/* O número é o que deixa "opção 2 de 3" explícito mesmo fechada. */}
        <Text as="span" size="xs" color="muted" className="shrink-0">{numero}.</Text>
        {/* Na cor do tema: o tempo, a linha, a contagem lá em cima e TODOS os
            ícones (Gabriel, 06/09). O TEXTO secundário continua em `muted` — é
            ele que carrega o detalhe, e escurecer tudo apagaria a hierarquia.
            ⚠️ O triângulo do aviso fica ÂMBAR: ali a cor é significado, não
            estilo, e uniformizá-la tiraria o sinal de "algo não deu certo". */}
        <Text as="span" size="xs" weight="semibold" color="primary" className="shrink-0">{labels.total(route.totalMinutes)}</Text>
        <Text as="span" size="xs" color="muted" className="truncate">
          {route.transfers === 0 ? labels.direct : labels.transfers(route.transfers)} · {route.lines.join(' → ')}
        </Text>
      </button>
      {aberta && (
        /* Barra vertical + indentação: é ela que diz que estes passos pertencem
           à opção acima, e não ao balão inteiro. */
        <ul className="ml-[26px] mr-2 mb-1.5 pl-2 border-l-2 border-gray-800 flex flex-col gap-0.5" data-testid="route-legs">
          {route.legs.map((l, i) => <Leg key={`${l.kind}-${i}`} leg={l} labels={labels} />)}
        </ul>
      )}
    </li>
  );
}

export function CorridorPanel({ pair, labels, onRouteOpen }: {
  pair: CorridorRequest;
  labels: CorridorLabels;
  /**
   * Avisa QUAL rota está aberta, para a página desenhá-la no mapa. O painel não
   * desenha nada: ele vive dentro do balão, que é portalado para o DOM do
   * Google, e o mapa é irmão dele — só a página enxerga os dois.
   * ⚠️ Precisa de identidade estável (um `setState`, não uma arrow inline).
   */
  onRouteOpen?: (legs: RouteLeg[] | null) => void;
}): JSX.Element {
  const state = useCorridor(pair);
  // A primeira rota nasce ABERTA: é a resposta, não uma opção entre outras.
  const [aberta, setAberta] = useState(0);

  const rotaAberta = state.data?.outcome === 'ok' ? state.data.routes[aberta] : undefined;
  // Sincroniza o desenho com o acordeão. Em efeito, e não no clique, porque a
  // rota aberta também muda quando a RESPOSTA chega (a 1ª nasce aberta) — e
  // avisar só no clique deixaria o mapa vazio até alguém tocar no painel.
  useEffect(() => { onRouteOpen?.(rotaAberta?.legs ?? null); }, [rotaAberta, onRouteOpen]);
  // Apaga ao fechar o balão. Separado do de cima de propósito: junto, cada troca
  // de opção apagaria e redesenharia, e a linha piscaria a cada clique.
  useEffect(() => () => onRouteOpen?.(null), [onRouteOpen]);

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
        <>
          <Text as="div" size="xs" weight="semibold" color="primary" className="mb-1" data-testid="routes-count">
            {labels.options(routes.length)}
          </Text>
          {/* Moldura + divisória: sem elas, as pernas da opção aberta e o
              cabeçalho da seguinte viram uma lista só.

              🔒 A ESCALA DE CINZA DESTA CASA NÃO É A DO TAILWIND e não é sequer
              monotônica (`tailwind.config.js`): 200=#F7F7F7, 300=#EEEEEE,
              400=#ECEFF1 — o 400 é mais CLARO que o 300 —, 600=#D9D9D9,
              800=#737373. Quem sobe o número achando que escurece não escurece:
              medido em 05/09, `gray-300` na moldura devolveu #EEEEEE (invisível
              contra o branco do balão) e `gray-400` na barra CLAREOU o que eu
              queria reforçar. Só `600` e `800` são borda que se enxerga. Antes
              de trocar qualquer `gray-*` aqui, leia `getComputedStyle`, não a
              intuição do Tailwind padrão. */}
          {/* TETO DE ALTURA com rolagem interna. Sem ele o balão cresce com o
              conteúdo e ESTOURA a borda de cima do mapa — medido em 05/09: com
              3 opções e a primeira expandida, o topo (nome do paciente, "Ver
              perfil" e a contagem) ficava cortado fora da viewport. O InfoWindow
              do Google reposiciona o mapa, mas não encolhe o que não cabe.

              O teto é 260px e não 190: a 190 o conserto só trocava um corte por
              outro — medido, a rota COM BALDEAÇÃO tinha 5 pernas e mostrava 3,
              escondendo justamente onde se desce. E perna escondida aqui é pior
              que balão alto, porque nada na tela avisa que há mais. 260 cobre a
              rota de uma baldeação (228px medidos) e ainda cabe no mapa (o balão
              fica ~435px numa área de 558px). A rolagem continua para o caso de
              duas baldeações — rede de segurança, não o layout esperado. */}
          <ul className="border border-gray-600 rounded-md divide-y divide-gray-600 overflow-y-auto max-h-[260px]" data-testid="routes">
            {routes.map((r, i) => (
              <Rota key={`${r.totalMinutes}-${r.lines.join('-')}`} route={r} labels={labels} numero={i + 1}
                aberta={aberta === i} onToggle={() => setAberta(aberta === i ? -1 : i)} />
            ))}
          </ul>
        </>
      )}

      {outcome === 'sem_ruta' && <Aviso text={labels.noRoute} testId="corridor-no-route" />}
      {outcome === 'sem_cobertura' && <Aviso text={labels.noCoverage} testId="corridor-no-coverage" />}

      {straightLineMeters !== null && (
        <div className="flex items-center gap-1.5 mt-2" data-testid="corridor-straight">
          <MoveHorizontal size={13} className="text-primary shrink-0" />
          <Text as="span" size="xs" color="muted">{labels.straight(Math.max(1, Math.round(straightLineMeters / 100)))}</Text>
        </div>
      )}
    </div>
  );
}
