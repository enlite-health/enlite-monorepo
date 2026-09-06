/**
 * useRouteOverlay — desenha o traçado de UMA rota sobre o mapa.
 *
 * Mora fora do `PointsMap` por dois motivos: o arquivo já estava a 11 linhas do
 * teto de 400 da casa, e o ciclo de vida de overlay imperativo do Google (criar,
 * trocar, destruir) é uma responsabilidade fechada — a mesma que o círculo do
 * raio já tem lá dentro.
 *
 * DESENHA SÓ A OPÇÃO ABERTA no acordeão, nunca as três. Três trajetos
 * sobrepostos num raio de 5 km viram macarrão e destroem justamente a leitura
 * que o painel numerado conquistou: qual é qual deixa de ser respondível.
 *
 * A convenção visual é a do Google Maps, porque o olho de quem opera já está
 * treinado nela e imitar aproximadamente é pior que imitar direito:
 *   - CAMINHADA: uma fileira de pontos redondos, cinza, sem linha ligando —
 *     não um tracejado;
 *   - TRANSPORTE: traço grosso na **cor oficial da linha**, que o próprio
 *     Google devolve em `transitLine.color` (o 50 de CABA é `#1b6633`, o 8 é
 *     `#3061f2`). Pintar tudo de azul do tema seria inventar uma informação que
 *     a pessoa já sabe ler de outro lugar;
 *   - e o traço vai sobre um CONTORNO branco mais largo, que é o que faz a
 *     linha continuar legível cruzando avenida, parque e água.
 */
import { useEffect } from 'react';

/** O mínimo que o desenho precisa saber de uma perna. */
export interface RouteOverlayLeg {
  kind: 'walk' | 'transit';
  /** Polilinhas CODIFICADAS. Lista porque caminhadas fundidas acumulam trechos. */
  paths: string[];
  /** Cor oficial da linha, só em perna de transporte. Vazia/ausente → cor do tema. */
  color?: string;
}

/** Usada só quando o Google não informa a cor da linha. */
const COR_PADRAO = '#180149';
/** Cinza dos pontos de caminhada — o mesmo tom que o Maps usa. */
const COR_CAMINHADA = '#5f6368';
/** Contorno sob o traço: é ele que sustenta a leitura sobre fundo carregado. */
const COR_CONTORNO = '#ffffff';

const TRACO_PX = 6;
const CONTORNO_PX = TRACO_PX + 4;

/** Abaixo dos pinos (que usam zIndex 1000): a rota é fundo, não alvo de clique. */
const Z_INDEX = 50;

/**
 * Folga ao enquadrar, em pixels. O TOPO é generoso de propósito: o balão do pino
 * ocupa aquela faixa, e o `InfoWindow` do Google decide o deslocamento no
 * instante em que ABRE — quando o painel ainda diz "buscando…". As rotas chegam
 * depois, o balão se estica para cima e nada o reposiciona: medido em 06/09, o
 * topo (nome, "Ver perfil" e a contagem) ficava 120px FORA do mapa. Empurrar a
 * rota para a metade de baixo é o que devolve o espaço ao balão.
 *
 * 300 é o número medido, não escolhido: com ele o balão inteiro cabe no mapa nas
 * três opções; com 360 o trajeto era espremido numa faixa de 80px e o zoom
 * reabria, desfazendo o motivo do enquadramento.
 *
 * ⚠️ ESTA FOLGA É O CONSERTO INTEIRO. Cheguei a escrever um segundo mecanismo,
 * que observava o crescimento do balão e deslocava o mapa por conta própria.
 * Isolando os dois no e2e (06/09): só o enquadramento → verde; só o
 * deslocamento → 24px cortados, vermelho. O segundo mecanismo não fazia nada e
 * foi apagado. Quem mexer aqui: o `admin-map-tracado.integration.e2e.ts` reprova
 * o corte, e já foi sabotado para provar que reprova mesmo.
 */
const FOLGA = { top: 300, right: 48, bottom: 56, left: 48 };

function drawLeg(map: google.maps.Map, leg: RouteOverlayLeg): google.maps.Polyline[] {
  return leg.paths.flatMap((encoded) => {
    const path = google.maps.geometry.encoding.decodePath(encoded);
    if (leg.kind === 'walk') {
      // A linha em si é INVISÍVEL (`strokeOpacity: 0`); o que se vê são
      // círculos repetidos sobre ela. É assim que o Maps desenha a pé, e a
      // diferença para um tracejado importa: ponto lê como "trecho a percorrer",
      // traço lê como "veículo".
      return [new google.maps.Polyline({
        map,
        path,
        strokeOpacity: 0,
        icons: [{
          icon: { path: google.maps.SymbolPath.CIRCLE, scale: 3, fillColor: COR_CAMINHADA, fillOpacity: 1, strokeOpacity: 0 },
          offset: '0',
          repeat: '12px',
        }],
        clickable: false,
        zIndex: Z_INDEX,
      })];
    }
    const cor = leg.color || COR_PADRAO;
    const base = { map, path, clickable: false, strokeOpacity: 1 } as const;
    // DUAS linhas, nesta ordem: o contorno branco embaixo e a cor da linha em
    // cima. Uma só, sem contorno, some ao cruzar avenida larga ou parque.
    return [
      new google.maps.Polyline({ ...base, strokeColor: COR_CONTORNO, strokeWeight: CONTORNO_PX, zIndex: Z_INDEX }),
      new google.maps.Polyline({ ...base, strokeColor: cor, strokeWeight: TRACO_PX, zIndex: Z_INDEX + 1 }),
    ];
  });
}

/**
 * @param map    o mapa já pronto, ou `null` enquanto carrega
 * @param legs   as pernas da rota aberta, ou `null` para apagar o traçado
 */
export function useRouteOverlay(map: google.maps.Map | null, legs: RouteOverlayLeg[] | null): void {
  useEffect(() => {
    // `!legs` e não `!legs?.length`: o tipo já exclui `undefined`, e o `?.`
    // criaria um ramo que nenhum teste alcança.
    if (!map || !legs || legs.length === 0) return;
    // A biblioteca `geometry` entra pela URL do script, e o script do Google
    // carrega UMA vez por página: se outra tela subiu a dela primeiro sem
    // `geometry`, o decodificador não existe. Não desenhar é degradação
    // aceitável — o painel de texto continua respondendo a pergunta; quebrar a
    // tela inteira do mapa por causa do enfeite não é.
    if (!google.maps.geometry?.encoding) return;

    const lines = legs.flatMap((leg) => drawLeg(map, leg));

    // ENQUADRA a rota. Sem isto o desenho existe e não se vê: o mapa nasce em
    // zoom 11 (~55 km de viewport) e um trajeto urbano de 1,2 km vira 25 pixels
    // — medido em 06/09, com as linhas confirmadas na tela e invisíveis a olho.
    // Só mexe no mapa quando há rota; fechar o balão não devolve o zoom, porque
    // recuar sozinho seria tirar da operadora a vista que ela acabou de ganhar.
    const caixa = new google.maps.LatLngBounds();
    for (const line of lines) line.getPath().forEach((p) => caixa.extend(p));
    if (!caixa.isEmpty()) map.fitBounds(caixa, FOLGA);
    // As linhas vivem na CLAUSURA, não num `ref`. O React já roda esta limpeza
    // antes de reentrar no efeito, então ela cobre os quatro casos de uma vez:
    // trocar de opção no acordeão, trocar de par, fechar o balão e desmontar.
    // (A 1ª versão guardava num `ref` e ainda apagava no topo do efeito por
    // garantia — o piso de cobertura mostrou que aquele laço nunca rodava com
    // conteúdo, porque a limpeza sempre vem antes. Rede que nunca é acionada
    // não é segurança: é código que ninguém testa.)
    return () => { for (const line of lines) line.setMap(null); };
  }, [map, legs]);
}
