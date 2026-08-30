/**
 * mapQueryCommon — o que os DOIS mapas do painel (prestadores e pacientes,
 * REQ-04 · DEC-14) têm em comum e que antes vivia copiado em cada controller:
 *
 *   - o pedaço do schema que é ESCOPO (país, província/localidade, centro+raio,
 *     limit) e as duas regras de refinamento do lex de 29/08 (C3: sem escopo
 *     é export da base → 400; raio exige centro);
 *   - `num()` — coluna numérica do pg chega como string;
 *   - o `safeParse → 400` da borda;
 *   - a trilha de leitura em massa (lex C5): uid, país, escopo e contagens —
 *     NUNCA coordenada, nome ou UUID;
 *   - o `catch` que reporta só a origem.
 *
 * Fixar aqui é o que garante que uma mudança de regra (ex.: escopo passa a
 * exigir raio ≤ 50 km) vale para os dois mapas ao mesmo tempo.
 */

import { Request, Response } from 'express';
import { z } from 'zod';
import { logger, reportError } from '@shared/logging';

export const MAX_MAP_POINTS = 5000;

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
 * Fecha a leitura: contagens, trilha (lex C5) e resposta 200.
 * A trilha leva quem, país, escopo e quantos — sem coordenada, sem nome, sem
 * UUID. A tabela da OP-08 chega com o ABAC (D212).
 */
export function respondMapPoints<P extends { lat: number | null }>(
  req: Request,
  res: Response,
  msg: string,
  scope: Pick<MapScope, 'country' | 'center' | 'limit'>,
  data: P[],
): void {
  const withoutCoordinates = data.filter((p) => p.lat === null).length;
  const truncated = data.length >= scope.limit;
  logger.info({
    msg,
    uid: req.user?.uid ?? null,
    country: scope.country,
    scope: scope.center ? 'radius' : 'location',
    n: data.length,
    withoutCoordinates,
    truncated,
  });
  res.status(200).json({ success: true, data, total: data.length, withoutCoordinates, truncated });
}

/** Erro da leitura: só a origem vai para o log — nenhum filtro, nome ou coordenada. */
export function respondMapError(res: Response, error: unknown, source: string, message: string): void {
  const e = error instanceof Error ? error : new Error(String(error));
  reportError(e, { source });
  res.status(500).json({ success: false, error: message });
}
