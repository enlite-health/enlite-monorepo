/**
 * transitRoute — a FORMA da rota de transporte público que a tela mostra.
 *
 * Puro: converte a resposta da **Routes API** do Google no que o balão do pino
 * precisa, e só isso. Sem rede, sem banco.
 *
 * A rota é de PORTA A PORTA (endereço do prestador → domicílio de atendimento),
 * porque é assim que a operação funciona: a caminhada das duas pontas faz parte
 * do problema real, e em Buenos Aires não existe terminal — baldear obriga a
 * andar até outra parada e pagar de novo (Marcel, ata de 02/09, REGRA-10). Por
 * isso a baldeação é CONTADA e ordenada na frente do tempo.
 *
 * ⚠️ O FORMATO AQUI FOI MEDIDO, NÃO SUPOSTO (05/09/2026, chamada real à Routes
 * API para um par em CABA — a resposta está em
 * `__tests__/fixtures/routes-api-caba.json`). Cinco armadilhas que uma
 * implementação escrita de memória erraria, e todas viram `NaN` ou string vazia
 * na tela:
 *   1. duração é STRING com sufixo: `"561s"`, não `{ value: 561 }`;
 *   2. o modo a pé é `WALK`, não `WALKING`;
 *   3. a duração do passo é `staticDuration`, não `duration`;
 *   4. distância é `distanceMeters` (número puro), não `{ value }`;
 *   5. as paradas vivem em `transitDetails.stopDetails.{departure,arrival}Stop`.
 * Além disso, o Google devolveu **6 rotas com duplicatas idênticas** e pernas a
 * pé CONSECUTIVAS (28s + 47s) — os dois casos são tratados abaixo.
 */

/**
 * Uma perna do trajeto: ou se anda, ou se pega alguma coisa.
 *
 * União DISCRIMINADA, e não um objeto com tudo opcional: perna a pé SEMPRE tem
 * metros (zero quando o Google omite) e perna de transporte SEMPRE tem linha.
 * Com campos opcionais, cada uso precisaria de um `?? 0` — e esses `??` seriam
 * ramos mortos, que fingem cobrir um caso que a construção já impede.
 */
export type RouteLeg =
  | { kind: 'walk'; minutes: number; meters: number; paths: string[] }
  | { kind: 'transit'; minutes: number; line: string; mode: string; from: string; to: string; paths: string[];
      /** Cor OFICIAL da linha, como o Google a devolve (`#1b6633` para o 50 em
       *  CABA). `''` quando ausente — quem desenha usa a cor do tema. */
      color: string };

export interface TransitRoute {
  /** Duração total porta a porta, em minutos. */
  totalMinutes: number;
  /** Quantas trocas de veículo. ZERO é o caso bom. */
  transfers: number;
  lines: string[];
  legs: RouteLeg[];
}

export type TransitRouteResult =
  | { outcome: 'ok'; routes: TransitRoute[] }
  /** Não há trajeto de transporte público entre os dois pontos. */
  | { outcome: 'sem_ruta'; routes: [] }
  /** Falta coordenada numa das pontas, ou o par não existe no escopo do ator. */
  | { outcome: 'sem_cobertura'; routes: [] };

/** Quantas alternativas a tela mostra. */
export const MAX_ROUTES = 3;

/** `"561s"` → 561. Devolve 0 para ausente ou malformado — nunca `NaN`. */
export function parseDuration(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number(String(raw).replace(/s$/, ''));
  return Number.isFinite(n) ? n : 0;
}

const toMinutes = (raw: string | undefined): number => Math.max(1, Math.round(parseDuration(raw) / 60));

/**
 * Só aceita `#rrggbb`. A cor vem de FORA e vai parar num `strokeColor` do
 * Google Maps: deixar passar string arbitrária de terceiro para dentro de uma
 * propriedade de desenho é ampliar a superfície sem necessidade. Qualquer coisa
 * fora do formato vira `''`, e quem desenha cai na cor do tema.
 */
export function normalizeLineColor(raw: string | undefined): string {
  return raw && /^#[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : '';
}

/** `BUS` → `bus`; `HEAVY_RAIL`/`COMMUTER_TRAIN` → `train`; `SUBWAY` → `subway`. */
export function normalizeVehicle(raw: string | undefined): string {
  const v = (raw ?? '').toUpperCase();
  if (v === 'SUBWAY' || v === 'METRO_RAIL') return 'subway';
  if (v === 'TRAM' || v === 'LIGHT_RAIL') return 'tram';
  if (v.includes('RAIL') || v.includes('TRAIN')) return 'train';
  return 'bus';
}

/** O recorte da Routes API que este módulo lê. */
export interface RawStep {
  travelMode?: string;
  staticDuration?: string;
  distanceMeters?: number;
  /** O traçado do passo, codificado. Medido em 06/09: `steps[].polyline.encodedPolyline`. */
  polyline?: { encodedPolyline?: string };
  transitDetails?: {
    transitLine?: { nameShort?: string; name?: string; color?: string; vehicle?: { type?: string } };
    stopDetails?: { departureStop?: { name?: string }; arrivalStop?: { name?: string } };
  };
}
export interface RawRoute {
  duration?: string;
  legs?: Array<{ duration?: string; steps?: RawStep[] }>;
}

/**
 * Junta pernas a pé CONSECUTIVAS numa só. O Google fatia a caminhada em vários
 * passos (medido: 28s + 47s antes de embarcar); mostrar "caminhe 1 min, depois
 * caminhe 1 min" faz a tela parecer quebrada e esconde o total.
 */
function mergeWalks(legs: RouteLeg[]): RouteLeg[] {
  const out: RouteLeg[] = [];
  for (const leg of legs) {
    const prev = out[out.length - 1];
    if (leg.kind === 'walk' && prev?.kind === 'walk') {
      prev.minutes += leg.minutes;
      prev.meters += leg.meters;
      // O traçado ACUMULA. Descartá-lo aqui abriria um buraco no desenho
      // exatamente onde a caminhada foi fundida — e é o caso comum, não a
      // exceção: na captura de 06/09 os passos 0 e 1 são os dois `WALK`, com
      // polilinhas próprias de 13 e 18 caracteres.
      prev.paths.push(...leg.paths);
      continue;
    }
    // Cópia do ARRAY, não só do objeto: `{ ...leg }` compartilharia a mesma
    // referência de `paths`, e o `push` acima mutaria a perna de origem.
    out.push({ ...leg, paths: [...leg.paths] });
  }
  return out;
}

/** Identidade de uma rota, para descartar as duplicatas que o Google devolve. */
const signature = (r: TransitRoute): string =>
  `${r.totalMinutes}|${r.lines.join('>')}|${r.legs.length}`;

/**
 * Converte a resposta do Google no nosso formato.
 *
 * Trajeto sem NENHUMA perna de transporte é descartado: o Google às vezes
 * devolve "vá andando" como rota de transporte público, e mostrar isso no
 * painel de transporte seria responder outra pergunta.
 */
export function buildTransitRoutes(raw: readonly RawRoute[]): TransitRouteResult {
  const routes: TransitRoute[] = [];
  const vistas = new Set<string>();

  for (const r of raw) {
    const leg0 = r.legs?.[0];
    const steps = leg0?.steps ?? [];
    const legs: RouteLeg[] = [];

    for (const s of steps) {
      // `[]` e não `undefined` quando o Google omite: perna sem traçado é
      // perna que não se desenha, e o resto da rota continua válido.
      const paths = s.polyline?.encodedPolyline ? [s.polyline.encodedPolyline] : [];
      if ((s.travelMode ?? '').toUpperCase() === 'TRANSIT') {
        const line = s.transitDetails?.transitLine;
        const stops = s.transitDetails?.stopDetails;
        legs.push({
          kind: 'transit',
          paths,
          minutes: toMinutes(s.staticDuration),
          line: line?.nameShort ?? line?.name ?? '—',
          mode: normalizeVehicle(line?.vehicle?.type),
          color: normalizeLineColor(line?.color),
          from: stops?.departureStop?.name ?? '',
          to: stops?.arrivalStop?.name ?? '',
        });
      } else {
        legs.push({ kind: 'walk', minutes: toMinutes(s.staticDuration), meters: Math.round(s.distanceMeters ?? 0), paths });
      }
    }

    const merged = mergeWalks(legs);
    const transitLegs = merged.filter((l): l is Extract<RouteLeg, { kind: 'transit' }> => l.kind === 'transit');
    if (transitLegs.length === 0) continue;

    const rota: TransitRoute = {
      // A duração da LEG é a do trajeto; a da rota inclui espera. Prefere a leg,
      // cai na rota quando ausente.
      totalMinutes: toMinutes(leg0?.duration ?? r.duration),
      transfers: transitLegs.length - 1,
      lines: transitLegs.map((l) => l.line),
      legs: merged,
    };

    // O Google devolveu 6 rotas para um par simples, várias idênticas.
    const sig = signature(rota);
    if (vistas.has(sig)) continue;
    vistas.add(sig);
    routes.push(rota);
  }

  if (routes.length === 0) return { outcome: 'sem_ruta', routes: [] };

  // Menos baldeação primeiro (é o que custa passagem de novo), depois o tempo.
  routes.sort((a, b) => (a.transfers !== b.transfers ? a.transfers - b.transfers : a.totalMinutes - b.totalMinutes));
  return { outcome: 'ok', routes: routes.slice(0, MAX_ROUTES) };
}
