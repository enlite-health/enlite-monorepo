/**
 * mapQueryCommon — o que os DOIS mapas do painel (prestadores e pacientes,
 * REQ-04 · DEC-14) têm em comum e que antes vivia copiado em cada controller:
 *
 *   - o pedaço do schema que é ESCOPO (país, província/localidade, centro+raio,
 *     limit) e as duas regras de refinamento do lex de 29/08 (C3: sem escopo
 *     é export da base → 400; raio exige centro);
 *   - `num()` — coluna numérica do pg chega como string;
 *   - o `safeParse → 400` da borda;
 *   - a trilha de leitura em massa (lex C5): uid, país, escopo, filtros de
 *     CATÁLOGO, contagens e o geohash-5 do centro — NUNCA coordenada crua,
 *     nome ou UUID (o invariante do geohash está escrito em `respondMapPoints`);
 *   - o TETO de pontos por request e a leitura do `COUNT(*) OVER()` que mantém
 *     a contagem da tela exata mesmo quando o teto corta a lista;
 *   - o `catch` que reporta só a origem.
 *
 * Fixar aqui é o que garante que uma mudança de regra (ex.: escopo passa a
 * exigir raio ≤ 50 km) vale para os dois mapas ao mesmo tempo.
 */

import { Request, Response } from 'express';
import { z } from 'zod';
import { logger, reportError } from '@shared/logging';
import { recognizedZoneLabel } from '@shared/utils/normalizeLocationValue';
import { geohash5 } from '@shared/utils/geohash';

/**
 * Teto de pontos por request (30/08). Era 5000 — o mesmo volume que o CSV de
 * `GET /workers/export`, que é `adminOnly` justamente porque recrutadora
 * exportava a base e usava errado. O mapa é `staffOnly` (é a ferramenta dela)
 * e não pode ser a mesma porta por outro caminho: 500 pontos é o que cabe numa
 * tela e não é um export. A tela NÃO perde a contagem — `COUNT(*) OVER()` nas
 * duas queries devolve o total do filtro inteiro, exato, mesmo cortado.
 */
export const MAX_MAP_POINTS = 500;

const coord = (min: number, max: number) => z.number().min(min).max(max);
const text = z.string().trim().min(1).max(120);

/** Campos de escopo comuns aos dois mapas. Cada controller espalha isto no seu `z.object`. */
export const mapScopeShape = {
  country: z.enum(['AR', 'BR']),
  state: text.optional(),
  city: text.optional(),
  center: z.object({ lat: coord(-90, 90), lng: coord(-180, 180) }).strict().optional(),
  radius_km: z.number().min(1).max(100).optional(),
  limit: z.number().int().min(1).max(MAX_MAP_POINTS).default(MAX_MAP_POINTS),
};

export type MapScope = {
  country: 'AR' | 'BR';
  state?: string;
  city?: string;
  center?: { lat: number; lng: number };
  radius_km?: number;
  limit: number;
};

/**
 * O que a trilha de leitura em massa recebe do corpo já validado: escopo
 * geográfico + os filtros de CATÁLOGO. `status` e `profession` são listas de
 * valores fechados (enum de status, código de profissão) — catálogo, nunca
 * dado de pessoa. Os dois controllers passam o próprio `body`; chave a mais
 * no corpo (`limit`, `docs_complete`, `with_open_vacancies`) não entra no log
 * porque o log é montado por ALLOWLIST, campo a campo, e não por spread.
 */
export type MapLogScope = Pick<MapScope, 'country' | 'state' | 'city' | 'center' | 'radius_km'> & {
  status?: readonly string[];
  /** Só o mapa de prestadores filtra por profissão; no de pacientes fica null. */
  profession?: readonly string[];
};

/** Escopo obrigatório (lex C3): centro+raio, OU província, OU localidade. */
export function hasScope(q: Pick<MapScope, 'center' | 'radius_km' | 'state' | 'city'>): boolean {
  return (q.center !== undefined && q.radius_km !== undefined) || q.state !== undefined || q.city !== undefined;
}

/** Aplica os dois refinamentos de escopo a um schema que contém `mapScopeShape`. */
export function withMapScopeRules<S extends z.ZodTypeAny>(schema: S): z.ZodEffects<z.ZodEffects<S>> {
  return schema
    .refine((q: MapScope) => q.radius_km === undefined || q.center !== undefined, {
      message: 'radius_km requires center',
    })
    .refine((q: MapScope) => hasScope(q), {
      message: 'scope required: center+radius_km, or state/city',
    });
}

/** Coluna numérica do pg (numeric/float chegam como string). Não-numérico vira null. */
export function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * `safeParse → 400` da borda. Devolve o corpo validado, ou `null` depois de
 * já ter respondido 400 (o chamador só faz `if (!body) return`).
 */
export function parseMapBody<S extends z.ZodTypeAny>(schema: S, req: Request, res: Response): z.infer<S> | null {
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'Invalid map filters', details: parsed.error.flatten() });
    return null;
  }
  return parsed.data;
}

/**
 * O total do filtro INTEIRO, lido do `COUNT(*) OVER()::int AS total_count` que
 * as duas queries de mapa trazem: a window roda ANTES do LIMIT, então toda
 * linha carrega o mesmo número e basta olhar a primeira. Sem linha nenhuma o
 * total é 0 — é a única leitura possível, e é a verdadeira.
 */
export function totalFromRows(rows: Array<{ total_count?: string | number | null }>): number {
  return num(rows[0]?.total_count) ?? 0;
}

/**
 * Fecha a leitura: contagens, trilha (lex C5) e resposta 200.
 * A trilha leva quem, país, escopo, os filtros de CATÁLOGO e quantos — sem
 * coordenada, sem nome, sem UUID. A tabela da OP-08 chega com o ABAC (D212).
 *
 * `total` é o do BANCO (`totalFromRows`), não o do array: com o teto em 500 a
 * tela mostraria "500" havendo 4.000, e "4 en 25 km" viraria mentira. `n` no
 * log continua sendo o que SAIU, `totalMatching` é o que EXISTIA no filtro, e
 * `truncated` é a diferença entre os dois.
 *
 * ⚠️ INVARIANTE DO `geohash5` (lex 30/08, C6) — LEIA ANTES DE ACRESCENTAR CAMPO.
 * O geocódigo do centro só é admissível aqui porque NÃO HÁ IDENTIFICADOR NA
 * MESMA LINHA. O centro pode cair na coordenada EXATA do domicílio de alguém por
 * DUAS portas (atualizado em 02/09, lex C-2): o seletor "Centrar en paciente" e o
 * botão "Centrar aquí" do balão do pino — este último vale para QUALQUER ponto,
 * inclusive de PRESTADOR, não só de paciente. Se esta linha carregasse junto o id
 * (ou o nome) de alguém, o par vira "endereço aproximado de pessoa identificada"
 * — e a regra
 * HIPAA-like interna só aceita geocódigo abaixo do nível de estado quando o
 * registro está DESIDENTIFICADO. `uid` é o do STAFF que consultou (quem olhou),
 * nunca o de quem foi olhado, e é por isso que ele pode conviver com o geohash.
 * Portanto: id, UUID, nome e `center.lat`/`center.lng` crus continuam FORA —
 * há teste que fica vermelho se qualquer um deles entrar no objeto logado.
 *
 * `?? null` em vez de omitir a chave: a forma da linha é a mesma nas duas
 * rotas, então "não filtrou por província" e "a rota nem tem esse filtro" leem
 * igual no Cloud Logging e nenhuma consulta de auditoria precisa de dois casos.
 */
/**
 * Localidade na trilha: NUNCA o que foi digitado.
 *
 * `state`/`city` são texto livre no schema (`z.string().max(120)`), e a
 * autorização do `lex` (30/08) pressupõe "filtros de catálogo, sem dado de
 * pessoa". Não existe catálogo fechado de província/localidade neste repo:
 * `canonicalLocation` e `canonicalProvince` devolvem "o resto inalterado", então
 * `city: "casa da Ana Paz"` passaria por elas e entraria verbatim no Cloud
 * Logging por 30 dias. Medido — foi um teste desta suíte que pegou.
 *
 * Regra, conservadora de propósito (C6 do `lex`: a `city` é mais fina que o
 * geohash em localidade pequena):
 *   - `stateCanonical` sai APENAS quando o valor cai no conjunto FECHADO de
 *     apelidos reconhecidos em código (`recognizedZoneLabel` → CABA/PBA);
 *   - qualquer outra coisa vira só o booleano "houve filtro".
 * Preço declarado: numa varredura por província/localidade sem centro, a trilha
 * registra QUE houve recorte geográfico, não QUAL. Fecha-se quando existir
 * catálogo fechado de províncias — aí o valor volta, sem texto livre.
 */
export function logSafeState(raw: string | null | undefined): string | null {
  return recognizedZoneLabel(raw);
}

export function hasFilter(raw: string | null | undefined): boolean {
  return typeof raw === 'string' && raw.trim() !== '';
}

export function respondMapPoints<P extends { lat: number | null }>(
  req: Request,
  res: Response,
  msg: string,
  scope: MapLogScope,
  data: P[],
  total: number,
): void {
  const withoutCoordinates = data.filter((p) => p.lat === null).length;
  const truncated = total > data.length;
  logger.info({
    msg,
    uid: req.user?.uid ?? null,
    country: scope.country,
    scope: scope.center ? 'radius' : 'location',
    n: data.length,
    withoutCoordinates,
    truncated,
    // O total do filtro INTEIRO: é ele que diz o TAMANHO da varredura, e não o
    // que coube na tela — `n` sozinho esconde uma leitura de 40.000 pessoas.
    totalMatching: total,
    status: scope.status ?? null,
    profession: scope.profession ?? null,
    // ⚠️ `state`/`city` são TEXTO LIVRE no schema (`z.string().max(120)`), não
    // catálogo — e a autorização do `lex` (30/08) pressupõe "filtros de catálogo,
    // sem dado de pessoa". Sem esta passagem, um `city: "casa da Ana Paz"` digitado
    // no filtro entraria verbatim no Cloud Logging por 30 dias. Então o que vai ao
    // log é o valor CANONIZADO pelo mesmo SSOT que o dropdown usa; o que não
    // canoniza vira o marcador abaixo — a auditoria continua sabendo QUE houve
    // filtro de localidade, sem carregar o que a pessoa escreveu.
    stateCanonical: logSafeState(scope.state),
    hasStateFilter: hasFilter(scope.state),
    hasCityFilter: hasFilter(scope.city),
    radiusKm: scope.radius_km ?? null,
    geohash5: scope.center ? geohash5(scope.center.lat, scope.center.lng) : null,
  });
  res.status(200).json({ success: true, data, total, withoutCoordinates, truncated });
}

/** Erro da leitura: só a origem vai para o log — nenhum filtro, nome ou coordenada. */
export function respondMapError(res: Response, error: unknown, source: string, message: string): void {
  const e = error instanceof Error ? error : new Error(String(error));
  reportError(e, { source });
  res.status(500).json({ success: false, error: message });
}
