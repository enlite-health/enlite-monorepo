/**
 * AdminWorkersMapController
 *
 * POST /api/admin/workers/map — os pontos do mapa de prestadores (REQ-04 da
 * planning de 26/08, DEC-14: "dois mapas sobre o Google").
 *
 * É POST com corpo, e não GET com query, de propósito (lex 29/08, C2): o
 * Cloud Run grava a URL crua da request num log global por 30 dias, e o
 * centro do raio é a casa de alguém. Coordenada não vai na URL.
 *
 * Diferente de GET /workers, aqui NÃO há paginação: o mapa precisa de todos
 * os pontos que casam o filtro — mas o filtro tem ESCOPO OBRIGATÓRIO (lex C3):
 * centro+raio ou província/localidade. Sem escopo é export da base, e a
 * resposta é 400. O WHERE reaproveita o da lista (`buildWorkerListWhereClause`)
 * para "documentação completa", profissão e província/localidade significarem
 * a mesma coisa nas duas telas; por cima entra o raio (`ST_DWithin` sobre
 * `worker_service_areas.location`) e o país (lex C4).
 *
 * Quem NÃO tem coordenada continua na resposta com `lat`/`lng` nulos: o
 * recrutador precisa saber que aquela pessoa existe e não está no mapa
 * (medido em prod, 29/08: 1213 de 3400 INCOMPLETE_REGISTER têm coordenada).
 * Um raio nunca esconde quem não tem posição — "não sei onde está" ≠ "está longe".
 *
 * Privacidade: sai nome, status, profissão, cidade/bairro e posição. Nada de
 * telefone, e-mail, documento — quem não tem nome sai como '—', nunca o e-mail.
 * A leitura em massa deixa trilha (lex C5): uid, país, escopo e contagens —
 * sem coordenada, sem nome.
 *
 * KMS — teto por request: o LIMIT do SQL já corta em `MAX_MAP_POINTS` (5000)
 * linhas, e cada linha tem até 2 cifras (nome e sobrenome), então o pior caso
 * é 10.000 decrypts numa request. Só cifra NÃO nula vai ao KMS (quem não tem
 * nome não custa nada), os dois campos entram numa ÚNICA passada, em lotes de
 * `DECRYPT_BATCH` em paralelo. Sem cache: a mesma cifra em duas requests custa
 * duas vezes — decisão consciente, o cache global de PII é assunto do ABAC.
 */

import { Request, Response } from 'express';
import { z } from 'zod';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { resolveLocationFilter } from '@shared/utils/normalizeLocationValue';
import {
  MAX_MAP_POINTS, mapScopeShape, num, parseMapBody, respondMapError, respondMapPoints, withMapScopeRules,
} from '@shared/http/mapQueryCommon';
import { buildAllValidatedClause, buildPendingValidationClause } from '../../application/workerDocumentFilters';
import { buildWorkerListWhereClause, locationMatchSql } from './AdminWorkersListHelpers';

export { MAX_MAP_POINTS };
/** Cifras por rodada de decrypt em paralelo (em prod cada uma é uma chamada ao KMS). */
export const DECRYPT_BATCH = 50;

const WorkerStatusEnum = z.enum(['REGISTERED', 'INCOMPLETE_REGISTER', 'DISABLED']);

/** `.strict()`: parâmetro desconhecido é 400, não silêncio (lex C1). */
export const WorkersMapBodySchema = withMapScopeRules(
  z
    .object({
      ...mapScopeShape,
      /** Lista de status. Ausente = REGISTERED + INCOMPLETE_REGISTER (quem deu baixa fica fora). */
      status: z.array(WorkerStatusEnum).optional(),
      docs_complete: z.enum(['complete', 'incomplete']).optional(),
      docs_validated: z.enum(['all_validated', 'pending_validation']).optional(),
      /** AT,CAREGIVER,NURSE,KINESIOLOGIST,PSYCHOLOGIST */
      profession: z.array(z.string().trim().min(1)).optional(),
    })
    .strict(),
);

export type WorkersMapBody = z.infer<typeof WorkersMapBodySchema>;

export interface WorkerMapPoint {
  id: string;
  name: string;
  lat: number | null;
  lng: number | null;
  status: string;
  documentsComplete: boolean;
  profession: string | null;
  city: string | null;
  neighborhood: string | null;
  state: string | null;
  /** Só quando a request trouxe centro; null para quem não tem coordenada. */
  distanceKm: number | null;
}

interface WorkerMapRow {
  id: string;
  first_name_encrypted: string | null;
  last_name_encrypted: string | null;
  status: string;
  profession: string | null;
  latitude: string | number | null;
  longitude: string | number | null;
  city: string | null;
  neighborhood: string | null;
  state: string | null;
  distance_km: string | number | null;
}

const DEFAULT_STATUSES = ['REGISTERED', 'INCOMPLETE_REGISTER'];

/**
 * Monta o SQL do mapa. Exportada para o teste afirmar a forma da query
 * (a régua aqui é o TEXTO do SQL + a ordem dos params, porque o banco real
 * só entra no e2e).
 */
export function buildWorkersMapQuery(q: WorkersMapBody): { sql: string; params: unknown[] } {
  // `status` da lista aceita UM valor; o mapa aceita vários e passa a LISTA ao
  // builder, que a resolve (ANY, sem o exclude de DISABLED da casa, e
  // `docs_complete` por interseção) — a regra está escrita em `statuses`.
  const base = buildWorkerListWhereClause({
    statuses: q.status && q.status.length > 0 ? q.status : DEFAULT_STATUSES,
    docs_complete: q.docs_complete,
    profession: q.profession?.join(','),
    state: q.state,
    city: q.city,
    limit: String(q.limit),
    offset: '0',
  });

  let where = base.whereClause;
  const params = [...base.params];
  let i = base.paramIndex;

  where += ` AND w.country = $${i}`;
  params.push(q.country);
  i++;

  if (q.docs_validated === 'all_validated') where += ` AND ${buildAllValidatedClause('wd')}`;
  if (q.docs_validated === 'pending_validation') where += ` AND ${buildPendingValidationClause('wd')}`;

  // O prestador pode ter mais de uma área. O LATERAL escolhe UMA: primeiro a
  // que casa o filtro de província/localidade (mesmo predicado do EXISTS da
  // lista — senão o filtro aceita o worker por uma área e o pino mostra outra),
  // depois quem tem coordenada, depois a mais recente.
  const lateralOrder: string[] = [];
  for (const [column, value] of [['state', q.state], ['city', q.city]] as const) {
    if (value === undefined) continue;
    const built = locationMatchSql('s', params, i, column, resolveLocationFilter(value));
    i = built.paramIndex;
    if (built.sql !== null) lateralOrder.push(`${built.sql} DESC NULLS LAST`);
  }
  lateralOrder.push('(s.latitude IS NULL)', 's.updated_at DESC');

  let distanceSelect = 'NULL::numeric AS distance_km';
  if (q.center) {
    const pLng = i++;
    const pLat = i++;
    params.push(q.center.lng, q.center.lat);
    const point = `ST_SetSRID(ST_MakePoint($${pLng}, $${pLat}), 4326)::geography`;
    distanceSelect = `ST_Distance(wsa.location, ${point}) / 1000.0 AS distance_km`;
    if (q.radius_km !== undefined) {
      const pM = i++;
      params.push(q.radius_km * 1000);
      // Sem coordenada NÃO é "fora do raio": fica na resposta com lat/lng nulos.
      where += ` AND (wsa.location IS NULL OR ST_DWithin(wsa.location, ${point}, $${pM}))`;
    }
  }

  const pLimit = i++;
  params.push(q.limit);

  const sql = `
    SELECT w.id, w.first_name_encrypted, w.last_name_encrypted, w.status, w.profession,
      wsa.latitude, wsa.longitude, wsa.city, wsa.neighborhood, wsa.state,
      ${distanceSelect}
    FROM workers w
    LEFT JOIN worker_documents wd ON wd.worker_id = w.id
    LEFT JOIN LATERAL (
      SELECT s.latitude, s.longitude, s.location, s.city, s.neighborhood, s.state
      FROM worker_service_areas s
      WHERE s.worker_id = w.id AND s.deleted_at IS NULL
      ORDER BY ${lateralOrder.join(', ')}
      LIMIT 1
    ) wsa ON true
    ${where}
    ORDER BY distance_km ASC NULLS LAST, w.created_at DESC
    LIMIT $${pLimit}
  `;
  return { sql, params };
}

export class AdminWorkersMapController {
  private readonly db = DatabaseConnection.getInstance().getPool();
  private readonly encryption = new KMSEncryptionService();

  /**
   * Descriptografa só as cifras não nulas, em lotes paralelos de
   * `DECRYPT_BATCH`, e devolve na MESMA posição da entrada ('' onde era null).
   */
  private async decryptAll(values: Array<string | null>): Promise<string[]> {
    const out = values.map(() => '');
    const pending = values.map((v, idx) => ({ v, idx })).filter((x): x is { v: string; idx: number } => x.v !== null);
    for (let start = 0; start < pending.length; start += DECRYPT_BATCH) {
      const chunk = pending.slice(start, start + DECRYPT_BATCH);
      const plain = await Promise.all(chunk.map((x) => this.encryption.decrypt(x.v)));
      chunk.forEach((x, k) => { out[x.idx] = plain[k]; });
    }
    return out;
  }

  /** POST /api/admin/workers/map */
  async getMapPoints(req: Request, res: Response): Promise<void> {
    const body = parseMapBody(WorkersMapBodySchema, req, res);
    if (!body) return;

    try {
      const { sql, params } = buildWorkersMapQuery(body);
      const result = await this.db.query<WorkerMapRow>(sql, params);
      const rows = result.rows;

      // Uma passada só: nome e sobrenome de todas as linhas (já cortadas pelo LIMIT).
      const names = await this.decryptAll(rows.flatMap((r) => [r.first_name_encrypted, r.last_name_encrypted]));

      const data: WorkerMapPoint[] = rows.map((row, k) => {
        const lat = num(row.latitude);
        const lng = num(row.longitude);
        const hasCoords = lat !== null && lng !== null;
        return {
          id: row.id,
          name: [names[2 * k], names[2 * k + 1]].filter(Boolean).join(' ') || '—',
          lat: hasCoords ? lat : null,
          lng: hasCoords ? lng : null,
          status: row.status,
          documentsComplete: row.status === 'REGISTERED',
          profession: row.profession ?? null,
          city: row.city ?? null,
          neighborhood: row.neighborhood ?? null,
          state: row.state ?? null,
          distanceKm: hasCoords ? num(row.distance_km) : null,
        };
      });

      respondMapPoints(req, res, 'workers.map.read', body, data);
    } catch (error: unknown) {
      respondMapError(res, error, 'AdminWorkersMapController:getMapPoints', 'Failed to load workers map');
    }
  }
}
