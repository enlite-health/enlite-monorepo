/**
 * transitCorridor — a REGRA do corredor logístico, pura e sem banco.
 *
 * A pergunta que a recrutadora faz no mapa não é "quantos km", é "dá para
 * chegar?". E o terreno decide o formato da resposta: em Buenos Aires NÃO
 * EXISTE TERMINAL — Marcel, 02/09: *"tu tem que descer da parada dele, andar
 * para outra parada e pegar outra. E tu, além de tudo, tu paga de novo"*.
 *
 * Daí as duas regras deste arquivo:
 *
 *  1. A resposta é a INTERSEÇÃO das linhas que passam perto da origem com as
 *     que passam perto do destino — uma linha só, sem baldeação. É o pedido
 *     original ("alcançável por UM meio — coletivo, trem ou metrô").
 *  2. Quando a interseção é vazia, a resposta NÃO é uma rota com baldeação: é
 *     `sem_conexion_directa`. Baldeação existe no mundo, mas é o caso caro, e
 *     dizer "dá para chegar" quando custa duas passagens e uma caminhada entre
 *     paradas é a mentira que a REGRA-10 adverte.
 *
 * Nada aqui sai do perímetro: é aritmética sobre paradas públicas e duas
 * coordenadas que já estão no nosso banco.
 */

/** Uma parada como ela sai do banco — infraestrutura pública, sem titular. */
export interface TransitStop {
  externalId: string;
  name: string;
  mode: string;
  lines: readonly string[];
  /** Distância em metros até o ponto consultado, já calculada pelo PostGIS. */
  distanceMeters: number;
}

/** Uma linha que serve AS DUAS pontas, com a caminhada de cada lado. */
export interface CorridorLine {
  line: string;
  mode: string;
  /** Metros a pé da ORIGEM até a parada mais próxima servida por esta linha. */
  originWalkMeters: number;
  originStopName: string;
  /** Metros a pé da parada de desembarque até o DESTINO. */
  destinationWalkMeters: number;
  destinationStopName: string;
}

export type CorridorResult =
  /** Há pelo menos uma linha servindo as duas pontas. */
  | { outcome: 'ok'; lines: CorridorLine[] }
  /** Há paradas dos dois lados, mas nenhuma linha em comum: exigiria baldeação. */
  | { outcome: 'sem_conexion_directa'; lines: [] }
  /** Falta cobertura de paradas em pelo menos uma das pontas (fora da CABA). */
  | { outcome: 'sem_cobertura'; lines: [] };

/**
 * O raio de caminhada. 400 m ≈ 4 quadras portenhas — é o que a literatura de
 * transporte usa como caminhada aceitável até a parada, e casa com a unidade em
 * que a operação já fala ("a três quadras", REQ-19).
 */
export const WALK_RADIUS_METERS = 400;

/** Uma quadra portenha ≈ 100 m. A tela fala em quadras; o banco, em metros. */
export const BLOCK_METERS = 100;

export function blocks(meters: number): number {
  return Math.max(1, Math.round(meters / BLOCK_METERS));
}

/**
 * Cruza as paradas das duas pontas e devolve as linhas diretas.
 *
 * Ordenação: primeiro a menor caminhada TOTAL (ida + volta), porque é isso que
 * a pessoa sente; empate desfeito pelo nome da linha, para a saída ser estável
 * entre chamadas — lista que muda de ordem sozinha não dá para conferir.
 */
export function buildCorridor(
  originStops: readonly TransitStop[],
  destinationStops: readonly TransitStop[],
): CorridorResult {
  if (originStops.length === 0 || destinationStops.length === 0) {
    return { outcome: 'sem_cobertura', lines: [] };
  }

  /**
   * Para cada linha, a parada MAIS PRÓXIMA que a serve deste lado.
   *
   * A chave é MODO + LINHA, nunca o nome sozinho: "8" de colectivo e "8" de trem
   * são coisas diferentes, e cruzá-las inventaria uma conexão direta que não
   * existe. Hoje só há dado de colectivo carregado, então isto não pode
   * disparar — é uma trava para quando o feed de trem/subte entrar, que é
   * exatamente quando ninguém estaria olhando para cá.
   */
  const keyOf = (mode: string, line: string): string => `${mode}\u0000${line}`;
  const nearestByLine = (stops: readonly TransitStop[]): Map<string, TransitStop> => {
    const best = new Map<string, TransitStop>();
    for (const stop of stops) {
      for (const line of stop.lines) {
        const k = keyOf(stop.mode, line);
        const current = best.get(k);
        if (!current || stop.distanceMeters < current.distanceMeters) best.set(k, stop);
      }
    }
    return best;
  };

  const fromOrigin = nearestByLine(originStops);
  const fromDestination = nearestByLine(destinationStops);

  const lines: CorridorLine[] = [];
  for (const [k, originStop] of fromOrigin) {
    const destinationStop = fromDestination.get(k);
    if (!destinationStop) continue;
    lines.push({
      line: k.slice(k.indexOf('\u0000') + 1),
      mode: originStop.mode,
      originWalkMeters: Math.round(originStop.distanceMeters),
      originStopName: originStop.name,
      destinationWalkMeters: Math.round(destinationStop.distanceMeters),
      destinationStopName: destinationStop.name,
    });
  }

  if (lines.length === 0) return { outcome: 'sem_conexion_directa', lines: [] };

  lines.sort((a, b) => {
    const walkA = a.originWalkMeters + a.destinationWalkMeters;
    const walkB = b.originWalkMeters + b.destinationWalkMeters;
    return walkA !== walkB ? walkA - walkB : a.line.localeCompare(b.line, 'es');
  });
  return { outcome: 'ok', lines };
}
